#!/usr/bin/env python3
"""
CAD 渲染器 - 使用 matplotlib 渲染 DXF 文件

提供基于坐标的渐进式渲染功能。
从 brain-off-repo 移植。
"""

import gc
import os
import io
import warnings
import contextlib
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import matplotlib.patches as patches
import matplotlib.pyplot as plt
from matplotlib import font_manager


# 图层颜色映射（白底配色方案）
LAYER_COLOR_MAP = {
    "WALL": "#CC0000",
    "S_WALL": "#CC0000",
    "COLUMN": "#FF6600",
    "WINDOW": "#0099CC",
    "E_WINDOW": "#0099CC",
    "DIM": "#0000CC",
    "PUB_DIM": "#0000CC",
    "TEXT": "#008800",
    "PUB_TEXT": "#008800",
    "AXIS": "#CC8800",
    "STAIR": "#CC00CC",
    "E_STAIR": "#CC00CC",
}

DEFAULT_COLOR = "#000000"
DEFAULT_DPI = 100
MIN_FONT_PX = 1.0
MAX_FONT_PX = 18.0
TEXT_FONT_SCALE = 0.75
OVERVIEW_PPU_THRESHOLD = 0.02
RENDERABLE_ENTITY_TYPES = {"LINE", "CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE", "TEXT", "MTEXT"}

_CJK_FONT_CANDIDATES = [
    "PingFang SC", "Hiragino Sans GB", "Heiti SC", "Songti SC", "STHeiti",
    "Microsoft YaHei", "SimHei", "Noto Sans CJK SC", "Arial Unicode MS",
]
_TEXT_FONT = None


@contextlib.contextmanager
def _suppress_ezdxf_noise():
    """Silence noisy third-party prints."""
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        yield


def get_layer_color(layer_name: str) -> str:
    """获取图层颜色"""
    layer_upper = str(layer_name).upper()
    if layer_upper in LAYER_COLOR_MAP:
        return LAYER_COLOR_MAP[layer_upper]
    for key, color in LAYER_COLOR_MAP.items():
        if key in layer_upper:
            return color
    return DEFAULT_COLOR


def decode_cad_text(value: Any) -> str:
    """解码 DXF 文本中的转义编码。"""
    if value is None:
        return ""
    text = str(value)
    try:
        from ezdxf.lldxf.encoding import (
            decode_dxf_unicode, decode_mif_to_unicode,
            has_dxf_unicode, has_mif_encoding,
        )
        if has_mif_encoding(text):
            text = decode_mif_to_unicode(text)
        if has_dxf_unicode(text):
            text = decode_dxf_unicode(text)
    except Exception:
        pass
    return text


def get_renderable_bounds(
    file_path: str,
    layers: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """获取可渲染实体的稳健边界。"""
    try:
        import ezdxf
        if not os.path.exists(file_path):
            return {"success": False, "error": f"文件不存在: {file_path}"}

        doc = ezdxf.readfile(file_path)
        msp = doc.modelspace()

        boxes: List[Tuple[float, float, float, float]] = []
        for entity in _iter_entities(msp, include_insert_virtual=True):
            if entity.dxftype() not in RENDERABLE_ENTITY_TYPES:
                continue
            if layers and _entity_layer(entity) not in layers:
                continue
            bbox = _entity_bbox(entity)
            if bbox:
                boxes.append(bbox)

        if not boxes:
            return {"success": False, "error": "图纸中没有可渲染实体"}

        filtered = _filter_outlier_boxes(boxes)
        min_x, min_y, max_x, max_y = _merge_boxes(filtered)

        return {
            "success": True,
            "bounds": {
                "min_x": round(min_x, 2), "max_x": round(max_x, 2),
                "min_y": round(min_y, 2), "max_y": round(max_y, 2),
                "width": round(max_x - min_x, 2),
                "height": round(max_y - min_y, 2),
                "width_m": round((max_x - min_x) / 1000, 2),
                "height_m": round((max_y - min_y) / 1000, 2),
            },
            "raw_entity_count": len(boxes),
            "used_entity_count": len(filtered),
        }
    except ImportError:
        return {"success": False, "error": "需要安装 ezdxf 库"}
    except Exception as e:
        return {"success": False, "error": f"获取边界失败: {str(e)}"}


def render_drawing_region(
    file_path: str,
    bbox: Dict[str, float],
    output_size: Tuple[int, int] = (2048, 2048),
    layers: Optional[List[str]] = None,
    output_path: Optional[str] = None,
    color_mode: str = "by_layer",
    maintain_aspect_ratio: bool = True,
) -> Dict[str, Any]:
    """渲染指定坐标区域为 PNG 图片。"""
    try:
        import ezdxf

        if not os.path.exists(file_path):
            return {"success": False, "error": f"文件不存在: {file_path}"}

        width = float(bbox.get("width", 0))
        height = float(bbox.get("height", 0))
        if width <= 0 or height <= 0:
            return {"success": False, "error": f"无效 bbox: {bbox}"}

        doc = ezdxf.readfile(file_path)
        msp = doc.modelspace()

        if not output_path:
            output_dir = Path("workspace/rendered")
            output_dir.mkdir(parents=True, exist_ok=True)
            filename = f"region_{int(bbox['x'])}_{int(bbox['y'])}_{int(width)}_{int(height)}.png"
            output_path = str(output_dir / filename)

        if maintain_aspect_ratio:
            aspect_ratio = width / height
            max_width, max_height = output_size
            if aspect_ratio > 1:
                actual_width = max(1, int(max_width))
                actual_height = max(1, int(round(actual_width / aspect_ratio)))
            else:
                actual_height = max(1, int(max_height))
                actual_width = max(1, int(round(actual_height * aspect_ratio)))
        else:
            actual_width = max(1, int(output_size[0]))
            actual_height = max(1, int(output_size[1]))

        fig = plt.figure(
            figsize=(actual_width / DEFAULT_DPI, actual_height / DEFAULT_DPI),
            dpi=DEFAULT_DPI, facecolor="white",
        )
        ax = fig.add_axes([0, 0, 1, 1], frame_on=False)
        ax.set_facecolor("white")
        ax.set_xlim(bbox["x"], bbox["x"] + width)
        ax.set_ylim(bbox["y"], bbox["y"] + height)
        ax.set_aspect("equal")
        ax.set_axis_off()

        pixels_per_unit = actual_width / width
        _render_entities(ax, msp, bbox, layers, color_mode, pixels_per_unit)

        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message=r"Glyph .* missing from font\(s\).*", category=UserWarning)
            fig.savefig(output_path, dpi=DEFAULT_DPI, facecolor="white", edgecolor="white", transparent=False)

        plt.close(fig)
        gc.collect()

        return {
            "success": True,
            "image_path": output_path,
            "actual_bbox": bbox,
            "scale": round(pixels_per_unit, 6),
            "output_size": [actual_width, actual_height],
        }
    except ImportError:
        return {"success": False, "error": "需要安装 ezdxf 和 matplotlib"}
    except Exception as e:
        try:
            plt.close("all")
            gc.collect()
        except Exception:
            pass
        return {"success": False, "error": f"渲染失败: {str(e)}"}


def entity_intersects_bbox(entity: Any, bbox: Dict[str, float]) -> bool:
    """检查实体是否和指定 bbox 相交。"""
    entity_bbox = _entity_bbox(entity)
    if not entity_bbox:
        return False
    return _boxes_intersect(entity_bbox, _bbox_tuple(bbox))


# ============================================================
# 内部辅助函数
# ============================================================

def _render_entities(ax, msp, bbox, layers, color_mode, pixels_per_unit):
    """渲染实体到 matplotlib axes。"""
    bbox_tuple = _bbox_tuple(bbox)
    text_kwargs = _get_text_font_kwargs()

    for entity in _iter_entities(msp, include_insert_virtual=True):
        entity_type = entity.dxftype()
        if entity_type not in RENDERABLE_ENTITY_TYPES:
            continue
        entity_layer = _entity_layer(entity)
        if layers and entity_layer not in layers:
            continue
        if not _boxes_intersect(_entity_bbox(entity), bbox_tuple):
            continue

        color = get_layer_color(entity_layer) if color_mode == "by_layer" else DEFAULT_COLOR
        try:
            if entity_type == "LINE":
                _render_line(ax, entity, color)
            elif entity_type == "CIRCLE":
                _render_circle(ax, entity, color)
            elif entity_type == "ARC":
                _render_arc(ax, entity, color)
            elif entity_type == "LWPOLYLINE":
                _render_lwpolyline(ax, entity, color)
            elif entity_type == "POLYLINE":
                _render_polyline(ax, entity, color)
            elif entity_type == "TEXT":
                _render_text(ax, entity, color, pixels_per_unit, text_kwargs)
            elif entity_type == "MTEXT":
                _render_mtext(ax, entity, color, pixels_per_unit, text_kwargs)
        except Exception:
            pass


def _iter_entities(msp, include_insert_virtual: bool = True) -> Iterable[Any]:
    for entity in msp:
        if include_insert_virtual and entity.dxftype() == "INSERT":
            try:
                with _suppress_ezdxf_noise():
                    for sub_entity in entity.virtual_entities():
                        yield sub_entity
            except Exception:
                pass
        yield entity


def _entity_layer(entity: Any) -> str:
    try:
        return str(entity.dxf.layer)
    except Exception:
        return "0"


def _bbox_tuple(bbox: Dict[str, float]) -> Tuple[float, float, float, float]:
    x1 = float(bbox["x"])
    y1 = float(bbox["y"])
    x2 = x1 + float(bbox["width"])
    y2 = y1 + float(bbox["height"])
    return (x1, y1, x2, y2)


def _entity_bbox(entity: Any) -> Optional[Tuple[float, float, float, float]]:
    entity_type = entity.dxftype()
    try:
        if entity_type == "LINE":
            x1, y1 = entity.dxf.start.x, entity.dxf.start.y
            x2, y2 = entity.dxf.end.x, entity.dxf.end.y
            return (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))
        if entity_type == "CIRCLE":
            cx, cy = entity.dxf.center.x, entity.dxf.center.y
            r = float(entity.dxf.radius)
            return (cx - r, cy - r, cx + r, cy + r)
        if entity_type == "ARC":
            cx, cy = entity.dxf.center.x, entity.dxf.center.y
            r = float(entity.dxf.radius)
            return (cx - r, cy - r, cx + r, cy + r)
        if entity_type == "LWPOLYLINE":
            points = list(entity.get_points())
            if not points:
                return None
            xs = [float(p[0]) for p in points]
            ys = [float(p[1]) for p in points]
            return (min(xs), min(ys), max(xs), max(ys))
        if entity_type == "POLYLINE":
            points = [(v.dxf.location.x, v.dxf.location.y) for v in entity.vertices]
            if not points:
                return None
            xs = [float(p[0]) for p in points]
            ys = [float(p[1]) for p in points]
            return (min(xs), min(ys), max(xs), max(ys))
        if entity_type in ("TEXT", "MTEXT"):
            x = float(entity.dxf.insert.x)
            y = float(entity.dxf.insert.y)
            height = _entity_text_height(entity)
            text = _extract_entity_text(entity)
            visual_chars = max(1, min(len(text), 64))
            width = max(height * visual_chars * 0.6, height)
            width = min(width, height * 80)
            return (x, y, x + width, y + height)
    except Exception:
        return None
    return None


def _entity_text_height(entity: Any) -> float:
    if entity.dxftype() == "TEXT":
        height = getattr(entity.dxf, "height", 100.0)
    else:
        height = getattr(entity.dxf, "char_height", 100.0)
    try:
        value = float(height)
    except Exception:
        value = 100.0
    return max(value, 1.0)


def _extract_entity_text(entity: Any) -> str:
    try:
        if entity.dxftype() == "TEXT":
            text = entity.dxf.text
        else:
            from ezdxf.tools.text import plain_mtext
            text = plain_mtext(entity.text)
        return decode_cad_text(text).replace("\x00", "").strip()
    except Exception:
        try:
            return decode_cad_text(getattr(entity.dxf, "text", "")).replace("\x00", "").strip()
        except Exception:
            return ""


def _boxes_intersect(
    box_a: Optional[Tuple[float, float, float, float]],
    box_b: Tuple[float, float, float, float],
) -> bool:
    if not box_a:
        return False
    return not (
        box_a[2] < box_b[0] or box_a[0] > box_b[2] or
        box_a[3] < box_b[1] or box_a[1] > box_b[3]
    )


def _render_line(ax, entity, color):
    x1, y1 = entity.dxf.start.x, entity.dxf.start.y
    x2, y2 = entity.dxf.end.x, entity.dxf.end.y
    ax.plot([x1, x2], [y1, y2], color=color, linewidth=0.6, solid_capstyle="round")


def _render_circle(ax, entity, color):
    cx, cy = entity.dxf.center.x, entity.dxf.center.y
    r = entity.dxf.radius
    circle = patches.Circle((cx, cy), r, fill=False, edgecolor=color, linewidth=0.6)
    ax.add_patch(circle)


def _render_arc(ax, entity, color):
    cx, cy = entity.dxf.center.x, entity.dxf.center.y
    r = entity.dxf.radius
    arc = patches.Arc(
        (cx, cy), 2 * r, 2 * r, angle=0,
        theta1=entity.dxf.start_angle, theta2=entity.dxf.end_angle,
        edgecolor=color, linewidth=0.6,
    )
    ax.add_patch(arc)


def _render_lwpolyline(ax, entity, color):
    points = list(entity.get_points())
    if not points:
        return
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    if entity.closed and len(points) > 2:
        xs.append(xs[0])
        ys.append(ys[0])
    ax.plot(xs, ys, color=color, linewidth=0.6)


def _font_size_points(text_height: float, pixels_per_unit: float) -> float:
    font_px = text_height * pixels_per_unit * TEXT_FONT_SCALE
    min_font_px = MIN_FONT_PX if pixels_per_unit < OVERVIEW_PPU_THRESHOLD else 2.5
    font_px = max(min_font_px, min(font_px, MAX_FONT_PX))
    return font_px * 72.0 / DEFAULT_DPI


def _get_text_font_kwargs() -> Dict[str, Any]:
    global _TEXT_FONT
    if _TEXT_FONT is None:
        available = {f.name for f in font_manager.fontManager.ttflist}
        selected = None
        for name in _CJK_FONT_CANDIDATES:
            if name in available:
                selected = name
                break
        _TEXT_FONT = font_manager.FontProperties(family=selected) if selected else False
    if _TEXT_FONT:
        return {"fontproperties": _TEXT_FONT}
    return {}


def _render_text(ax, entity, color, pixels_per_unit, text_kwargs):
    x, y = entity.dxf.insert.x, entity.dxf.insert.y
    text = _extract_entity_text(entity)
    if not text:
        return
    rotation = entity.dxf.rotation if hasattr(entity.dxf, "rotation") else 0
    fontsize = _font_size_points(_entity_text_height(entity), pixels_per_unit)
    ax.text(x, y, text, fontsize=fontsize, color=color, rotation=rotation,
            ha="left", va="bottom", clip_on=True, **text_kwargs)


def _render_mtext(ax, entity, color, pixels_per_unit, text_kwargs):
    x, y = entity.dxf.insert.x, entity.dxf.insert.y
    text = _extract_entity_text(entity)
    if not text:
        return
    rotation = entity.dxf.rotation if hasattr(entity.dxf, "rotation") else 0
    fontsize = _font_size_points(_entity_text_height(entity), pixels_per_unit)
    ax.text(x, y, text, fontsize=fontsize, color=color, rotation=rotation,
            ha="left", va="top", clip_on=True, **text_kwargs)


def _render_polyline(ax, entity, color):
    points = [(v.dxf.location.x, v.dxf.location.y) for v in entity.vertices]
    if not points:
        return
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    if entity.is_closed and len(points) > 2:
        xs.append(xs[0])
        ys.append(ys[0])
    ax.plot(xs, ys, color=color, linewidth=0.6)


def _merge_boxes(boxes: List[Tuple[float, float, float, float]]) -> Tuple[float, float, float, float]:
    min_x = min(b[0] for b in boxes)
    min_y = min(b[1] for b in boxes)
    max_x = max(b[2] for b in boxes)
    max_y = max(b[3] for b in boxes)
    return min_x, min_y, max_x, max_y


def _filter_outlier_boxes(
    boxes: List[Tuple[float, float, float, float]]
) -> List[Tuple[float, float, float, float]]:
    """使用 IQR 对实体中心点做稳健过滤。"""
    if len(boxes) < 20:
        return boxes

    centers_x = sorted((b[0] + b[2]) / 2.0 for b in boxes)
    centers_y = sorted((b[1] + b[3]) / 2.0 for b in boxes)

    q1x, q3x = _quantile(centers_x, 0.25), _quantile(centers_x, 0.75)
    q1y, q3y = _quantile(centers_y, 0.25), _quantile(centers_y, 0.75)
    iqr_x = max(q3x - q1x, 1.0)
    iqr_y = max(q3y - q1y, 1.0)

    min_x = q1x - 4.0 * iqr_x
    max_x = q3x + 4.0 * iqr_x
    min_y = q1y - 4.0 * iqr_y
    max_y = q3y + 4.0 * iqr_y

    filtered = []
    for box in boxes:
        cx = (box[0] + box[2]) / 2.0
        cy = (box[1] + box[3]) / 2.0
        if min_x <= cx <= max_x and min_y <= cy <= max_y:
            filtered.append(box)

    if len(filtered) < max(10, int(len(boxes) * 0.2)):
        return boxes
    return filtered


def _quantile(values: List[float], q: float) -> float:
    if not values:
        return 0.0
    if q <= 0:
        return values[0]
    if q >= 1:
        return values[-1]
    pos = (len(values) - 1) * q
    low = int(pos)
    high = min(low + 1, len(values) - 1)
    frac = pos - low
    return values[low] * (1.0 - frac) + values[high] * frac
