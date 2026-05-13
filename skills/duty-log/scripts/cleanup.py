"""Clean up old temporary images from the download directory."""
import argparse
from pathlib import Path
from datetime import datetime, timedelta


def cleanup(temp_dir, max_age_hours=24):
    """Remove .jpg/.png files older than max_age_hours from temp_dir.

    Returns count of removed files.
    """
    temp_dir = Path(temp_dir)
    if not temp_dir.exists():
        return 0

    cutoff = datetime.now() - timedelta(hours=max_age_hours)
    count = 0
    for pattern in ['*.jpg', '*.jpeg', '*.png', '*.gif']:
        for f in temp_dir.glob(pattern):
            mtime = datetime.fromtimestamp(f.stat().st_mtime)
            if mtime < cutoff:
                f.unlink()
                count += 1
    return count


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Clean up old temporary images')
    parser.add_argument('--temp-dir', required=True, help='Directory to clean')
    parser.add_argument('--max-age-hours', type=int, default=24,
                        help='Remove files older than this many hours')
    args = parser.parse_args()

    removed = cleanup(args.temp_dir, args.max_age_hours)
    print(f'Removed {removed} old images from {args.temp_dir}')
