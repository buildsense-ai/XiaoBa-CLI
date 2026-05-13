"""Poll cloud server for new duty log images and download them locally."""
import requests
import json
import os
from datetime import datetime
from pathlib import Path

STATE_FILE = Path(__file__).parent.parent / '.poll_state.json'

def load_state():
    """Load last poll timestamp."""
    if STATE_FILE.exists():
        with open(STATE_FILE, 'r') as f:
            return json.load(f)
    return {'last_poll': '2026-01-01T00:00:00'}

def save_state(last_poll):
    """Save last poll timestamp."""
    with open(STATE_FILE, 'w') as f:
        json.dump({'last_poll': last_poll.isoformat()}, f)

def poll_new_images(api_base, api_token, timeout=30):
    """Poll cloud server for new images since last poll.

    Returns list of image objects with id, filename, receivedAt, url.
    """
    state = load_state()
    since = state['last_poll']

    resp = requests.get(
        f'{api_base}/api/new-images',
        params={'since': since, 'token': api_token},
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    return data.get('images', [])

def download_image(url, dest_dir, api_token, api_base):
    """Download a single image from cloud server. Returns local path."""
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)

    # url may be relative like "/api/images/1" — prepend api_base
    if url.startswith("/"):
        full_url = f"{api_base.rstrip('/')}{url}"
    else:
        full_url = url

    resp = requests.get(
        full_url,
        params={'token': api_token},
        timeout=60,
        stream=True,
    )
    resp.raise_for_status()

    filename = url.split('/')[-1]
    filepath = dest_dir / filename
    with open(filepath, 'wb') as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)

    return filepath

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Poll and fetch new duty images')
    parser.add_argument('--api-base', required=True, help='Cloud server URL e.g. http://118.145.116.152:8899')
    parser.add_argument('--api-token', required=True, help='Auth token')
    parser.add_argument('--dest-dir', required=True, help='Local temp directory for downloaded images')
    parser.add_argument('--output-json', help='Write downloaded images list as JSON file')
    args = parser.parse_args()

    images = poll_new_images(args.api_base, args.api_token)

    results = []
    latest_time = None
    for img in images:
        local_path = download_image(img['url'], args.dest_dir, args.api_token, args.api_base)
        results.append({
            'id': img['id'],
            'filename': img['filename'],
            'local_path': str(local_path),
            'received_at': img['receivedAt'],
        })
        img_time = datetime.fromisoformat(img['receivedAt'])
        if latest_time is None or img_time > latest_time:
            latest_time = img_time

    if latest_time:
        save_state(latest_time)

    if args.output_json and results:
        with open(args.output_json, 'w', encoding='utf-8') as f:
            json.dump(results, f, ensure_ascii=False, indent=2)

    print(json.dumps({'downloaded': len(results)}, ensure_ascii=False))
