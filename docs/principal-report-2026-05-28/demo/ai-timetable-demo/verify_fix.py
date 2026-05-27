"""验证学段过滤修复"""
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

# 测试：初中应该只返回 18 个班级
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

print("=== 验证结果 ===")
print(f"school_scope: {data.get('school_scope')}")
print(f"class_names 数量: {len(data.get('class_names', []))}")
print(f"前3个班级: {data.get('class_names', [])[:3]}")

if len(data.get('class_names', [])) == 18:
    print("\n✅ 修复成功！初中正确返回 18 个班级")
else:
    print(f"\n❌ 仍然返回 {len(data.get('class_names', []))} 个班级")
