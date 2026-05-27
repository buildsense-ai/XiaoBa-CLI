import sys
sys.path.insert(0, 'D:/ai-timetable-demo')

from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

payload = {
    "messages": [],
    "class_counts": {"七年级": 6, "八年级": 6, "九年级": 6},
    "school_scope": "初中",
    "teachers": [],
    "rooms": [],
    "courses": []
}

response = client.post("/api/solve", json=payload)
data = response.json()
print("class_names count:", len(data.get("class_names", [])))
print("First 6:", data.get("class_names", [])[:6])
