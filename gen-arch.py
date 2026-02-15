"""Generate XiaoBa architecture diagram as Excalidraw JSON"""
import json

def shape(id, x, y, w, h, stroke, bg, sw=2, rough=1, bound_els=None):
    return {
        "type": "rectangle", "id": id, "x": x, "y": y, "width": w, "height": h,
        "strokeColor": stroke, "backgroundColor": bg, "fillStyle": "solid",
        "strokeWidth": sw, "roughness": rough, "opacity": 100, "angle": 0,
        "seed": abs(hash(id)) % 900000000 + 100000000,
        "version": 1, "versionNonce": abs(hash(id)) % 900000000 + 100000000,
        "isDeleted": False, "groupIds": [], "boundElements": bound_els or [],
        "updated": 1700000000000, "link": None, "locked": False,
        "roundness": {"type": 3}
    }

def estimate_width(label, font_size):
    """Estimate text width matching Excalidraw Virgil font metrics."""
    w = 0
    for ch in label:
        if ord(ch) > 0x2000:  # CJK character
            w += font_size * 1.0
        elif ch == ' ':
            w += font_size * 0.4
        else:  # ASCII
            w += font_size * 0.6
    return max(int(w), font_size * 2)

def text(id, label, container_id, cx, cy, cw, ch, font_size=18, color="#1e1e1e"):
    tw = estimate_width(label, font_size)
    th = 30 if font_size >= 24 else 25
    # Calculate explicit position: center text inside container
    tx = cx + (cw - tw) / 2
    ty = cy + (ch - th) / 2
    return {
        "type": "text", "id": id, "x": tx, "y": ty,
        "width": tw, "height": th,
        "text": label, "fontSize": font_size, "fontFamily": 1,
        "textAlign": "center", "verticalAlign": "middle",
        "strokeColor": color, "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": 1, "roughness": 1, "opacity": 100, "angle": 0,
        "seed": abs(hash(id)) % 900000000 + 100000000,
        "version": 1, "versionNonce": abs(hash(id)) % 900000000 + 100000000,
        "isDeleted": False, "groupIds": [], "boundElements": None,
        "updated": 1700000000000, "link": None, "locked": False,
        "containerId": container_id, "originalText": label,
        "lineHeight": 1.25, "baseline": 21 if font_size >= 18 else 18
    }

def arrow(id, x, y, dx, dy, stroke, sw=2):
    return {
        "type": "arrow", "id": id, "x": x, "y": y,
        "width": abs(dx), "height": abs(dy),
        "points": [[0, 0], [dx, dy]],
        "strokeColor": stroke, "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": sw, "roughness": 1, "opacity": 100, "angle": 0,
        "seed": abs(hash(id)) % 900000000 + 100000000,
        "version": 1, "versionNonce": abs(hash(id)) % 900000000 + 100000000,
        "isDeleted": False, "groupIds": [], "boundElements": None,
        "updated": 1700000000000, "link": None, "locked": False,
        "startBinding": None, "endBinding": None,
        "startArrowhead": None, "endArrowhead": "arrow",
        "lastCommittedPoint": None, "roundness": {"type": 2}
    }

def bind_arrow(arr, start_id, end_id):
    arr["startBinding"] = {"elementId": start_id, "focus": 0, "gap": 1}
    arr["endBinding"] = {"elementId": end_id, "focus": 0, "gap": 1}
    return arr

def be(ids_types):
    return [{"id": i, "type": t} for i, t in ids_types]

# Colors
BLUE = "#1971c2"; LBLUE = "#a5d8ff"
RED = "#e03131"; PINK = "#ffc9c9"
GREEN = "#2f9e44"; LGREEN = "#b2f2bb"; LLGREEN = "#d3f9d8"
ORANGE = "#e8590c"; LORANGE = "#ffd8a8"; LLORANGE = "#fff3e0"
PURPLE = "#6741d9"; LPURPLE = "#d0bfff"; LLPURPLE = "#f3f0ff"
TEAL = "#099268"; LTEAL = "#c3fae8"; LLTEAL = "#e3fafc"
GRAY = "#868e96"; LGRAY = "#e9ecef"
DARK = "#1e1e1e"

elements = []

# === TITLE ===
elements.append(shape("title-bg", 330, 10, 400, 50, DARK, DARK, 2, 0,
    be([("t-title", "text")])))
elements.append(text("t-title", "XiaoBa 架构图", "title-bg", 330, 10, 400, 50, 24, "#ffffff"))

# === ROW 1: ENTRY POINTS ===
elements.append(shape("cli", 180, 85, 160, 55, BLUE, LBLUE, 2, 1,
    be([("t-cli", "text"), ("a1", "arrow")])))
elements.append(text("t-cli", "CLI", "cli", 180, 85, 160, 55, 18, BLUE))

elements.append(shape("feishu-bot", 620, 85, 200, 55, BLUE, LBLUE, 2, 1,
    be([("t-feishu", "text"), ("a2", "arrow")])))
elements.append(text("t-feishu", "飞书 Bot", "feishu-bot", 620, 85, 200, 55, 18, BLUE))

# === ROW 2: SESSION LAYER ===
elements.append(shape("agent-session", 250, 200, 300, 60, RED, PINK, 2, 1,
    be([("t-session", "text"), ("a1", "arrow"), ("a2", "arrow"),
        ("a3", "arrow"), ("a4", "arrow"), ("a8", "arrow")])))
elements.append(text("t-session", "AgentSession", "agent-session", 250, 200, 300, 60, 18, RED))

elements.append(shape("memory", 700, 205, 170, 50, GRAY, LGRAY, 1, 1,
    be([("t-memory", "text"), ("a4", "arrow")])))
elements.append(text("t-memory", "GauzMem 记忆", "memory", 700, 205, 170, 50, 14, GRAY))

# === ROW 3: CORE ENGINE ===
elements.append(shape("conv-runner", 200, 325, 360, 65, RED, PINK, 2, 1,
    be([("t-runner", "text"), ("a3", "arrow"),
        ("a5", "arrow"), ("a6", "arrow"), ("a7", "arrow")])))
elements.append(text("t-runner", "ConversationRunner", "conv-runner", 200, 325, 360, 65, 18, RED))

# === ROW 4: SERVICE LAYER ===
elements.append(shape("ai-svc", 30, 455, 180, 55, GREEN, LGREEN, 2, 1,
    be([("t-ai", "text"), ("a5", "arrow"), ("a9", "arrow"), ("a10", "arrow")])))
elements.append(text("t-ai", "AIService", "ai-svc", 30, 455, 180, 55, 18, GREEN))

elements.append(shape("tool-mgr", 270, 455, 180, 55, ORANGE, LORANGE, 2, 1,
    be([("t-tool", "text"), ("a6", "arrow"), ("a11", "arrow"), ("a12", "arrow")])))
elements.append(text("t-tool", "ToolManager", "tool-mgr", 270, 455, 180, 55, 18, ORANGE))

elements.append(shape("skill-mgr", 510, 455, 180, 55, PURPLE, LPURPLE, 2, 1,
    be([("t-skill", "text"), ("a7", "arrow"), ("a13", "arrow")])))
elements.append(text("t-skill", "SkillManager", "skill-mgr", 510, 455, 180, 55, 18, PURPLE))

elements.append(shape("subagent-mgr", 760, 455, 220, 55, TEAL, LTEAL, 2, 1,
    be([("t-subagent", "text"), ("a8", "arrow"), ("a14", "arrow")])))
elements.append(text("t-subagent", "SubAgentManager", "subagent-mgr", 760, 455, 220, 55, 18, TEAL))

# === ROW 5: IMPLEMENTATION LAYER (spaced with 15px gaps) ===
elements.append(shape("anthropic-prov", 0, 570, 155, 45, GREEN, LLGREEN, 1, 1,
    be([("t-anthropic", "text"), ("a9", "arrow")])))
elements.append(text("t-anthropic", "Anthropic", "anthropic-prov", 0, 570, 155, 45, 14, GREEN))

elements.append(shape("openai-prov", 170, 570, 150, 45, GREEN, LLGREEN, 1, 1,
    be([("t-openai", "text"), ("a10", "arrow")])))
elements.append(text("t-openai", "OpenAI", "openai-prov", 170, 570, 150, 45, 14, GREEN))

elements.append(shape("ts-tools", 335, 570, 120, 45, ORANGE, LLORANGE, 1, 1,
    be([("t-ts", "text"), ("a11", "arrow")])))
elements.append(text("t-ts", "TS 内置工具", "ts-tools", 335, 570, 120, 45, 14, ORANGE))

elements.append(shape("py-tools", 470, 570, 120, 45, ORANGE, LLORANGE, 1, 1,
    be([("t-py", "text"), ("a12", "arrow")])))
elements.append(text("t-py", "Python 工具", "py-tools", 470, 570, 120, 45, 14, ORANGE))

elements.append(shape("skill-files", 605, 570, 140, 45, PURPLE, LLPURPLE, 1, 1,
    be([("t-skills", "text"), ("a13", "arrow")])))
elements.append(text("t-skills", "Skill 文件", "skill-files", 605, 570, 140, 45, 14, PURPLE))

elements.append(shape("agents", 800, 570, 150, 45, TEAL, LLTEAL, 1, 1,
    be([("t-agents", "text"), ("a14", "arrow")])))
elements.append(text("t-agents", "Agent 类型", "agents", 800, 570, 150, 45, 14, TEAL))

# === ARROWS ===
arrows = [
    # Row 1 -> Row 2
    bind_arrow(arrow("a1", 260, 140, 140, 60, BLUE, 2), "cli", "agent-session"),
    bind_arrow(arrow("a2", 720, 140, -320, 60, BLUE, 2), "feishu-bot", "agent-session"),
    # Row 2 -> Row 3
    bind_arrow(arrow("a3", 400, 260, -20, 65, RED, 2), "agent-session", "conv-runner"),
    # Row 2 -> Memory
    bind_arrow(arrow("a4", 550, 228, 150, 0, GRAY, 1), "agent-session", "memory"),
    # Row 3 -> Row 4
    bind_arrow(arrow("a5", 300, 390, -180, 65, GREEN, 2), "conv-runner", "ai-svc"),
    bind_arrow(arrow("a6", 380, 390, 0, 65, ORANGE, 2), "conv-runner", "tool-mgr"),
    bind_arrow(arrow("a7", 460, 390, 140, 65, PURPLE, 2), "conv-runner", "skill-mgr"),
    # Row 2 -> Row 4 (long diagonal)
    bind_arrow(arrow("a8", 520, 260, 350, 195, TEAL, 1), "agent-session", "subagent-mgr"),
    # Row 4 -> Row 5
    bind_arrow(arrow("a9", 90, 510, -13, 60, GREEN, 1), "ai-svc", "anthropic-prov"),
    bind_arrow(arrow("a10", 155, 510, 90, 60, GREEN, 1), "ai-svc", "openai-prov"),
    bind_arrow(arrow("a11", 340, 510, 55, 60, ORANGE, 1), "tool-mgr", "ts-tools"),
    bind_arrow(arrow("a12", 410, 510, 120, 60, ORANGE, 1), "tool-mgr", "py-tools"),
    bind_arrow(arrow("a13", 600, 510, 75, 60, PURPLE, 1), "skill-mgr", "skill-files"),
    bind_arrow(arrow("a14", 870, 510, 5, 60, TEAL, 1), "subagent-mgr", "agents"),
]
elements.extend(arrows)

doc = {
    "type": "excalidraw",
    "version": 2,
    "source": "xiaoba",
    "elements": elements,
    "appState": {
        "viewBackgroundColor": "#ffffff",
        "exportWithDarkMode": False,
        "exportBackground": True
    },
    "files": {}
}

with open("xiaoba-arch.json", "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)

print(f"Done: {len(elements)} elements written to xiaoba-arch.json")
