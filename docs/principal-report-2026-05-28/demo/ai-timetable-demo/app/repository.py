from __future__ import annotations

import json
import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_PATH = PROJECT_ROOT / "data" / "timetable.json"


def default_state() -> dict:
    return {
        "school_scope": "初中",
        "class_counts": {},
        "teachers": [],
        "rooms": [],
        "courses": [],
        "messages": [],
        "manual_changes": [],
        "imported_schedule": None,
        "resolved_schedule": None,
        "subject_aliases": {},
        "class_aliases": {},
        "constraints": [],
        "review_items": [],
        "patch_history": [],
        "source_metadata": {},
    }


class JsonTimetableRepository:
    def __init__(self, path: str | Path | None = None):
        env_path = os.environ.get("TIMETABLE_DATA_PATH")
        self.path = Path(path or env_path or DEFAULT_DATA_PATH)

    def load(self) -> dict:
        if not self.path.exists():
            state = default_state()
            self.save(state)
            return state
        try:
            with self.path.open("r", encoding="utf-8") as file:
                loaded = json.load(file)
        except (json.JSONDecodeError, OSError):
            loaded = {}
        state = default_state()
        state.update({key: loaded.get(key, value) for key, value in state.items()})
        return state

    def save(self, state: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("w", encoding="utf-8") as file:
            json.dump(state, file, ensure_ascii=False, indent=2)

    def reset(self) -> dict:
        state = default_state()
        self.save(state)
        return state
