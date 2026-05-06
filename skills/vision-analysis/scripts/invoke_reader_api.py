#!/usr/bin/env python3
"""Compatibility wrapper for the shared advanced-reader Cats reader proxy."""
from __future__ import annotations

import runpy
import sys
from pathlib import Path


def main() -> int:
    shared_script = (
        Path(__file__).resolve().parents[2]
        / "advanced-reader"
        / "scripts"
        / "invoke_reader_api.py"
    )
    if not shared_script.exists():
        print(f"Shared reader script not found: {shared_script}", file=sys.stderr)
        return 1

    runpy.run_path(str(shared_script), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
