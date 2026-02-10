"""
检查 CAD 指定区域 - 渲染高清图 + 提取区域实体数据
从 brain-off-repo 移植
"""

import io
import os
import contextlib
from typing import Any, Dict, Optional

from utils.base_tool import BaseTool


def _encode_image_preview_base64(
    image_path: str, max_side: int = 768, jpeg_quality: int = 60,
) -> Optional[str]:
    """压缩预览图为 base64，减少 token 消耗"""
    try:
        import base64
        from PIL import Image

        with Image.open(image_path) as image:
            image = image.convert("RGB")
            image.thumbnail((max_side, max_side))
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=jpeg_quality, optimize=True)
            return base64.b64encode(buffer.getvalue()).decode("utf-8")
    except Exception:
        return None


@contextlib.contextmanager
def _suppress_ezdxf_noise():
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        yield


def _iter_entities_with_virtual(msp):
    for entity in msp:
        if entity.dxftype() == "INSERT":
            try:
                with _suppress_ezdxf_noise():
                    for sub in entity.virtual_entities():
                        yield sub
            except Exception:
                pass
        yield entity


class InspectRegionTool(BaseTool):

    def execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self.validate_params(params, ["file_path", "x", "y", "width", "height"])

        file_path = params["file_path"]
        x = float(params["x"])
        y = float(params["y"])
        width = float(params["width"])
        height = float(params["height"])
        output_size = int(params.get("output_size", 2048))
        include_image_base64 = bool(params.get("include_image_base64", False))

        if width <= 0 or height <= 0:
            raise ValueError(f"无效区域尺寸: width={width}, height={height}")

        import ezdxf
        from ezdxf.tools.text import plain_mtext
        from cad.cad_renderer import (
            decode_cad_text, entity_intersects_bbox, render_drawing_region,
        )

        bbox = {"x": x, "y": y, "width": width, "height": height}

        # 渲染区域图片
        render_result = render_drawing_region(
            file_path, bbox=bbox, output_size=(output_size, output_size),
        )
        if not render_result.get("success"):
            raise RuntimeError(f"渲染失败: {render_result['error']}")

        image_path = render_result["image_path"]
        image_base64 = _encode_image_preview_base64(image_path) if include_image_base64 else None

        # 统计区域内实体
        doc = ezdxf.readfile(file_path)
        msp = doc.modelspace()

        entities_by_type = {}
        entities_by_layer = {}
        texts = []

        for entity in _iter_entities_with_virtual(msp):
            if not entity_intersects_bbox(entity, bbox):
                continue
            entity_type = entity.dxftype()
            layer_name = getattr(entity.dxf, "layer", "0")
            entities_by_type[entity_type] = entities_by_type.get(entity_type, 0) + 1
            entities_by_layer[layer_name] = entities_by_layer.get(layer_name, 0) + 1

            try:
                if entity_type == "TEXT":
                    texts.append({
                        "text": decode_cad_text(entity.dxf.text),
                        "position": [entity.dxf.insert.x, entity.dxf.insert.y],
                        "height": getattr(entity.dxf, "height", None),
                        "layer": layer_name,
                    })
                elif entity_type == "MTEXT":
                    texts.append({
                        "text": decode_cad_text(plain_mtext(entity.text)),
                        "position": [entity.dxf.insert.x, entity.dxf.insert.y],
                        "height": getattr(entity.dxf, "char_height", None),
                        "layer": layer_name,
                    })
            except Exception:
                pass

        area_m2 = round((width * height) / 1_000_000, 2)

        return {
            "image_path": image_path,
            "image_base64": image_base64,
            "region_info": {
                "bbox": bbox,
                "area_m2": area_m2,
                "scale": render_result.get("scale"),
            },
            "entity_summary": {
                "total_count": sum(entities_by_type.values()),
                "by_type": entities_by_type,
                "by_layer": entities_by_layer,
            },
            "key_content": {
                "texts": texts[:50],
                "text_count": len(texts),
            },
        }


if __name__ == "__main__":
    InspectRegionTool().run()
