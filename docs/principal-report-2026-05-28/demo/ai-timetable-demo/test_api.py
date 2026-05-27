import json
import requests

url = "http://127.0.0.1:8008/api/solve"
payload = {
    "messages": [],
    "class_counts": {"七年级": 6, "八年级": 6, "九年级": 6},
    "school_scope": "初中",
    "teachers": [],
    "rooms": [],
    "courses": []
}

response = requests.post(url, json=payload)
data = response.json()
print("class_names count:", len(data.get("class_names", [])))
print("First 6 class_names:", data.get("class_names", [])[:6])
