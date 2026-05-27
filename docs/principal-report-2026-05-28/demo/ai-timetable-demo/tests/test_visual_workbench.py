from pathlib import Path


HTML_PATH = Path("app/static/index.html")


def visible_html() -> str:
    html = HTML_PATH.read_text(encoding="utf-8")
    return html.split('<section class="legacy-controls"', 1)[0]


def app_js() -> str:
    return Path("app/static/app.js").read_text(encoding="utf-8")


def test_visual_workbench_exposes_only_core_actions():
    html = visible_html()

    for control_id in ["schoolScope", "classSelect", "rerunButton", "exportButton", "missingInfo", "conflictAdvice"]:
        assert f'id="{control_id}"' in html

    hidden_or_removed = [
        "ruleInput",
        "excelInput",
        "conditionImageInput",
        "addDataButton",
        "dataModal",
        "manualModeButton",
    ]
    for control_id in hidden_or_removed:
        assert f'id="{control_id}"' not in html


def test_visual_workbench_copy_does_not_advertise_dragging():
    html = visible_html()

    assert "拖拽" not in html
    assert "手动微调" not in html
    assert 'data-tab="teachers"' not in html
    assert 'data-tab="courses"' not in html
    assert 'data-tab="rooms"' not in html


def test_visual_workbench_runtime_copy_points_to_background_adjustments():
    js = app_js()

    old_teacher_facing_copy = [
        "拖到空白节次",
        "左侧“教室”",
        "左侧新增/修改",
        "当前资料可在左侧维护",
        "Excel 可先用于预览",
        "可拖动调整这节课",
    ]
    for text in old_teacher_facing_copy:
        assert text not in js
