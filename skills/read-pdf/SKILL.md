---
name: read-pdf
description: PDF intake pipeline for XiaoBa. Use when the user provides a PDF path or attachment, asks to read/inspect/parse/extract/OCR a PDF, or explicitly says read-pdf/read pdf skill/$read-pdf. After loading this skill, the first substantive action must be running scripts/read-pdf.py on the current PDF or authorized catsco_attachment reference. Do not use platform read_file as the first PDF reader for an explicit read-pdf request.
invocable: user
argument-hint: "<pdf path or catsco_attachment:id> [--pages 1-5,9|all] [--diagnose-only] [--ocr-total-max-pages 80] [--run-mineru] [--mineru-total-max-pages N|0] [--run-vision]"
skillhub_author: "atridaisuki"
skillhub_version: "1.0.15"
skillhub_uploaded_at: "2026-07-16T06:01:46.427Z"
---

# Read PDF

Use this skill as the PDF intake owner. It reads and diagnoses PDFs, chooses fallback routes from objective PDF signals, and writes replayable JSON packets. It does not summarize, judge, research, or create Word/PPT/PDF deliverables.

## Mandatory First Action

For an explicit `read-pdf`, `read pdf skill`, or `$read-pdf` request, run the bundled entry script before using any other PDF reader:

```bash
python <SKILL_DIR>/scripts/read-pdf.py "<pdf-path-or-catsco_attachment-ref>" --pages all --ocr-total-max-pages 80 --batch-size 20 --output "<run-summary.json>"
```

Rules:
- Do not call platform `read_file` before this command.
- Do not answer from memory, prior packets, filename guesses, or earlier session summaries.
- If the user provided a CatsCo attachment reference, pass `catsco_attachment:<id>` directly. If only an authorized local PDF path is available, pass that path.
- If no PDF path or current attachment reference is available, ask for the PDF source instead of guessing.
- Always save `--output`. Use the returned `final_packet_path` or `packet_paths` for downstream work.
- For whole-document reading, extraction, or summary requests with no page range, treat the requested scope as the whole PDF. Use `--pages all` and a long tool timeout, normally 10 minutes or more for scanned PDFs.
- Do not deliver a full-document summary unless `reader_brief.status` is `complete`. If it is `partial`, follow `reader_brief.next_action` before answering.

## P0 Runtime Contract

This skill cannot guarantee that an external router selects it. Its P0 contract starts after the skill is loaded:
- run `scripts/read-pdf.py` first for PDF intake;
- let the runner install `requirements.txt` unless `--no-install` is explicitly needed;
- let the runner split OCR pages by `--batch-size` instead of reading only the first OCR batch;
- when `reader_brief.next_action.action` is `run_continuation`, execute that command before summarizing;
- when `reader_brief.next_action.action` is `backend_decision_required`, do not claim completion; report the unresolved backend or run it only if the workflow/user explicitly wants that backend.

## What The Entry Script Does

`scripts/read-pdf.py` is the normal entrypoint. It:
- checks/imports the light Python dependencies;
- installs this skill's `requirements.txt` when those light dependencies are missing, unless `--no-install` is set;
- runs `pdf-intake.py` once for diagnosis;
- runs a bounded content/backend pass;
- automatically runs OCR for pages diagnosed as OCR-needed, capped by `--ocr-total-max-pages`;
- splits OCR pages into backend batches using `--batch-size` and writes each batch packet independently;
- writes a compact `resolved_text_path` for downstream reading, so agents do not need to open giant OCR JSON packets;
- writes `continuation_commands` when OCR/MinerU/vision work is capped, skipped, or a batch fails;
- records skipped/capped MinerU, vision, and OCR work explicitly in `reader_brief` and the run summary.

Light dependencies are `pdfplumber`, `pdf2image`, `Pillow`, and `PyMuPDF`. OCR/MinerU/vision services are not installed by the skill. Public default backend URLs are loaded from `config/defaults.env`; user/runtime environment variables can override them. Backend secrets are kept server-side and must not be bundled into the skill.

## Common Commands

Default PDF intake, with diagnosis plus bounded OCR when needed:

```bash
python <SKILL_DIR>/scripts/read-pdf.py "<pdf>" --pages all --ocr-total-max-pages 80 --batch-size 20 --output "<run-summary.json>"
```

Specific pages:

```bash
python <SKILL_DIR>/scripts/read-pdf.py "<pdf>" --pages 1-5,9 --output "<run-summary.json>"
```

Diagnosis only, no content/backend pass:

```bash
python <SKILL_DIR>/scripts/read-pdf.py "<pdf>" --diagnose-only --output "<run-summary.json>"
```

Long scanned PDF, intentionally allow more OCR in batches:

```bash
python <SKILL_DIR>/scripts/read-pdf.py "<pdf>" --pages all --ocr-total-max-pages 80 --batch-size 20 --output "<run-summary.json>"
```

Run MinerU or vision only when explicitly needed:

```bash
python <SKILL_DIR>/scripts/read-pdf.py "<pdf>" --pages 12-18 --run-mineru --output "<run-summary.json>"
python <SKILL_DIR>/scripts/read-pdf.py "<pdf>" --pages 12-18 --run-vision --output "<run-summary.json>"
```

When `--run-mineru` is explicit, the runner processes all MinerU-recommended pages in the selected range by default. Use `--mineru-total-max-pages N` only when intentionally capping a costly run; `0` means no cap.

Use the lower-level script only for debugging, custom evals, or a precise backend experiment:

```bash
python <SKILL_DIR>/scripts/pdf-intake.py "<pdf>" --pages 1-5 --no-content --run-ocr --ocr-backend auto --output "<packet.json>"
```

## Backend Policy

- Text diagnosis requires `pdfplumber`.
- OCR execution uses a configured HTTP OCR API first, otherwise local PaddleOCR if available. Missing local Tesseract/PaddleOCR does not mean OCR is unavailable when HTTP OCR is configured.
- HTTP OCR still needs page rendering. Prefer `pdf2image` plus Poppler when present; if Poppler/`pdftoppm` is missing, fall back to `PyMuPDF` (`fitz`) from `requirements.txt`.
- MinerU execution uses a configured HTTP MinerU API or local CLI only when explicitly requested with `--run-mineru`.
- Vision execution uses the configured reader proxy only when explicitly requested with `--run-vision`, or through targeted OCR-short retry if requested.
- `config/defaults.env` may provide non-secret default OCR/MinerU URLs for skillhub installs. Do not put API keys or tokens in that file.
- The scripts record `runtime_env_files_loaded` and `runtime_env_loaded_keys`, but never print API keys or tokens.

## Reading The Result

After `read-pdf.py` finishes, inspect the run summary:
- `ok`: whether the runner completed.
- `reader_brief.status`: whether the requested scope is complete or only partial.
- `reader_brief.agent_instruction`: whether it is safe to summarize the requested scope.
- `reader_brief.next_action`: the concrete next step. `run_continuation` means execute its `command` before answering.
- `reader_brief.continuation_commands`: exact commands to run next when the current scope is partial.
- `resolved_text_path`: compact normalized page text for downstream analysis and summary.
- `dependency_check`: whether requirements were already present or installed.
- `diagnosis.summary.route_decision`: document-level route.
- `diagnosis.summary.backend_availability`: OCR/MinerU/vision/render availability.
- `execution.batch_plan`: planned OCR/content batches and their status.
- `execution.packets`: packet files from content/backend passes.
- `execution.skipped`: capped or deliberately skipped fallback work.
- `final_packet_path`: the single content/backend packet to use next when there was only one content pass.
- `content_packet_paths`: all content/backend packets when the run was split into multiple batches.
- `packet_paths`: all saved packet files, including diagnosis.

Use `resolved_text_path` first for summaries, extraction, or analysis. Inspect the final packet only when backend evidence, page decisions, or diagnostics are needed:
- `coverage` tells which pages were processed and whether sampling/truncation happened.
- `page_decisions` gives page-level recommended backend and evidence.
- `resolved_pages` is the normalized content layer for downstream analysis.
- `ocr_results`, `mineru_results`, and `vision_results` show whether fallback execution really happened.
- `uncertainties` and `route_advisories` must be carried forward when confidence is limited.

If `reader_brief.status` is `partial`, inspect `reader_brief.next_action` first:
- `run_continuation`: run its `command` immediately, then inspect the new summary.
- `backend_decision_required`: remaining work needs MinerU, vision, or another non-auto fallback; do not call the read complete unless that backend is actually run.
- `report_partial` or `report_failure`: clearly label the answer as partial or failed.

Do not invent page ranges when `continuation_commands` are present.

## Boundary

Own:
- PDF path or attachment intake.
- Text-layer extraction.
- Page-level quality diagnosis.
- Scan/layout/fallback routing.
- OCR/MinerU/vision backend execution when explicitly enabled by this skill's commands.
- Replayable packet output.

Do not own:
- Summaries or conclusions beyond reporting intake status.
- Business/domain judgment.
- Web research.
- Word/PPT/report/PDF delivery.
- Replacing current packet evidence with memory.

## Failure Rules

If the runner returns `ok=false`, report the concrete failed stage: dependency check, diagnosis, or backend execution. Do not say the PDF was read.

If the packet route is `partial`, `ocr_required`, `mineru_required`, `vision_required`, or `hybrid`, say which pages/backends are unresolved or capped. Do not upgrade fallback recommendations into completed reading.

Use platform `read_file` only after a current read-pdf packet exists and one of these is true:
- the packet recommends vision and the skill cannot run configured vision;
- the current packet failed with `ok=false` and no script recovery is available;
- the user explicitly asks to compare platform `read_file` against the read-pdf packet.
