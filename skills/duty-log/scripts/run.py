"""Main orchestrator for duty-log: poll → OCR → match → insert → cleanup."""
import argparse
import json
import os
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

# Allow running from any directory
SCRIPTS_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPTS_DIR))

from poll_and_fetch import poll_new_images, download_image, save_state
from ocr_image import ocr_image
from match_and_insert import match_timeslot, find_document, insert_image_to_doc
from cleanup import cleanup


# ── config from env ──────────────────────────────────────────────
API_BASE = os.environ.get("DUTY_LOG_API_BASE", "http://118.145.116.152:8899")
API_TOKEN = os.environ.get("DUTY_LOG_API_TOKEN", "")
BASE_DIR = os.environ.get("DUTY_LOG_BASE_DIR", "")
MAX_RETRIES = 3
RETRY_DELAY = 10


def log(level, msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [{level}] {msg}", flush=True)


def run_pipeline(base_dir=None, api_base=None, api_token=None, dry_run=False, temp_dir=None):
    base_dir = base_dir or BASE_DIR
    api_base = api_base or API_BASE
    api_token = api_token or API_TOKEN

    if not api_token:
        log("ERROR", "DUTY_LOG_API_TOKEN is not set")
        return {"status": "error", "error": "missing api token", "processed": 0}

    if not base_dir:
        log("ERROR", "DUTY_LOG_BASE_DIR is not set")
        return {"status": "error", "error": "missing base dir", "processed": 0}

    if not Path(base_dir).exists():
        log("ERROR", f"Base directory does not exist: {base_dir}")
        return {"status": "error", "error": f"base dir not found: {base_dir}", "processed": 0}

    # ── step 1: poll ─────────────────────────────────────────────
    log("INFO", f"Polling {api_base}/api/new-images ...")

    try:
        images = poll_new_images(api_base, api_token)
    except Exception as e:
        log("ERROR", f"Poll failed: {e}")
        return {"status": "error", "error": f"poll failed: {e}", "processed": 0}

    if not images:
        log("INFO", "No new images.")
        return {"status": "ok", "downloaded": 0, "processed": 0, "errors": []}

    log("INFO", f"Found {len(images)} new image(s)")

    # ── prepare temp dir ─────────────────────────────────────────
    if temp_dir:
        download_dir = Path(temp_dir)
    else:
        download_dir = Path(tempfile.mkdtemp(prefix="dutylog_"))
    download_dir.mkdir(parents=True, exist_ok=True)

    # ── step 2+3: download → ocr → match → insert ────────────────
    results = {"downloaded": 0, "processed": 0, "skipped": 0, "errors": []}
    latest_time = None

    for img in images:
        img_id = img.get("id", "?")
        filename = img.get("filename", "unknown")
        log("INFO", f"Processing: {filename} (id={img_id})")

        # Download
        local_path = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                local_path = download_image(img["url"], str(download_dir), api_token, api_base)
                break
            except Exception as e:
                log("WARN", f"Download attempt {attempt}/{MAX_RETRIES} failed: {e}")
                if attempt == MAX_RETRIES:
                    results["errors"].append({
                        "image_id": img_id,
                        "filename": filename,
                        "step": "download",
                        "error": str(e),
                    })
                else:
                    time.sleep(RETRY_DELAY)

        if local_path is None:
            results["skipped"] += 1
            continue

        results["downloaded"] += 1

        # OCR
        ocr_result = ocr_image(str(local_path))
        if "error" in ocr_result:
            results["errors"].append({
                "image_id": img_id,
                "filename": filename,
                "step": "ocr",
                "error": ocr_result["error"],
            })
            results["skipped"] += 1
            continue

        missing = ocr_result.get("_missing", [])
        if missing:
            results["errors"].append({
                "image_id": img_id,
                "filename": filename,
                "step": "ocr",
                "error": f"Missing fields: {missing}",
            })
            results["skipped"] += 1
            continue

        hhmm = ocr_result["hhmm"]
        date = ocr_result["date"]
        campus = ocr_result["campus"]
        log("INFO", f"OCR: time={hhmm}, date={date}, campus={campus}")

        # Match timeslot
        match = match_timeslot(hhmm)
        if match is None:
            results["errors"].append({
                "image_id": img_id,
                "filename": filename,
                "step": "match",
                "error": f"Time {hhmm} cannot match any timeslot",
            })
            results["skipped"] += 1
            continue

        log("INFO", f"Matched: {match['section']} ({match.get('label', 'N/A')})")

        # Find document
        doc_path = find_document(base_dir, campus, date)
        if doc_path is None:
            from match_and_insert import build_doc_name
            doc_name = build_doc_name(campus, date)
            results["errors"].append({
                "image_id": img_id,
                "filename": filename,
                "step": "find_doc",
                "error": f"Document not found: {base_dir}/{campus}/{doc_name}",
            })
            results["skipped"] += 1
            continue

        # Insert image
        if dry_run:
            log("INFO", f"DRY RUN: would insert {filename} → {doc_path} ({match['section']})")
            results["processed"] += 1
        else:
            try:
                result_path = insert_image_to_doc(doc_path, str(local_path), match)
                log("INFO", f"Inserted: {result_path}")
                results["processed"] += 1
            except Exception as e:
                results["errors"].append({
                    "image_id": img_id,
                    "filename": filename,
                    "step": "insert",
                    "error": str(e),
                })
                results["skipped"] += 1
                continue

        # Save poll state immediately after each successful insert
        # to prevent re-processing on crash/restart
        img_time = datetime.fromisoformat(img["receivedAt"])
        if not dry_run:
            save_state(img_time)
            log("INFO", f"Poll state updated: {img_time.isoformat()}")

    # ── step 4: cleanup ───────────────────────────────────────────
    removed = cleanup(str(download_dir), max_age_hours=0)  # remove all from this run
    log("INFO", f"Cleanup: removed {removed} temp file(s)")

    # ── summary ───────────────────────────────────────────────────
    log("INFO", f"Done. Downloaded={results['downloaded']}, processed={results['processed']}, "
                f"skipped={results['skipped']}, errors={len(results['errors'])}")

    if results["errors"]:
        for err in results["errors"]:
            log("ERROR", f"  [{err['step']}] {err.get('filename', '?')}: {err['error']}")

    return {"status": "ok", **results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Duty log pipeline: poll → OCR → match → insert → cleanup")
    parser.add_argument("--api-base", help="Cloud server URL (env: DUTY_LOG_API_BASE)")
    parser.add_argument("--api-token", help="Auth token (env: DUTY_LOG_API_TOKEN)")
    parser.add_argument("--base-dir", required=True, help="Root directory of duty log documents")
    parser.add_argument("--temp-dir", help="Temporary directory for downloaded images")
    parser.add_argument("--dry-run", action="store_true", help="Run without modifying documents")
    args = parser.parse_args()

    result = run_pipeline(
        base_dir=args.base_dir,
        api_base=args.api_base,
        api_token=args.api_token,
        dry_run=args.dry_run,
        temp_dir=args.temp_dir,
    )

    status_code = 0 if result["status"] == "ok" else 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(status_code)
