from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_export_excel_downloads_workbook():
    response = client.post(
        "/api/export/excel",
        json={"messages": ["九年级不要第一节体育课"], "class_name": "九年级(1)"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert "attachment" in response.headers["content-disposition"]
    assert response.content.startswith(b"PK")


def test_export_csv_downloads_selected_class_table():
    response = client.post(
        "/api/export/csv",
        json={"messages": ["九年级不要第一节体育课"], "class_name": "九年级(1)"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    text = response.content.decode("utf-8-sig")
    assert "九年级(1)课程表" in text
    assert "周一" in text
    assert "第1节" in text


def test_export_pdf_downloads_selected_class_pdf():
    response = client.post(
        "/api/export/pdf",
        json={"messages": ["九年级不要第一节体育课"], "class_name": "九年级(1)"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert "attachment" in response.headers["content-disposition"]
    assert response.content.startswith(b"%PDF")


def test_export_pdf_returns_clear_error_for_unknown_class():
    response = client.post(
        "/api/export/pdf",
        json={"messages": [], "school_scope": "小学", "class_name": "九年级(1)"},
    )

    assert response.status_code == 400
    assert "没有找到班级" in response.json()["detail"]


def test_export_csv_returns_clear_error_for_unknown_class():
    response = client.post(
        "/api/export/csv",
        json={"messages": [], "school_scope": "初中", "class_name": "一年级(1)"},
    )

    assert response.status_code == 400
    assert "请先刷新" in response.json()["detail"]
