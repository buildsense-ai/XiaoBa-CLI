"""
提取 CAD 实体结构化数据（线条、圆、文字等）
从 brain-off-repo 移植
"""

import io
import contextlib
from typing import Any, Dict, List, Optional

import sys; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tools', 'global')); from base_tool import BaseTool


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


class ExtractCadEntitiesTool(BaseTool):

    def execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self.validate_params(params, ["file_path"])

        file_path = params["file_path"]
        entity_types: Optional[List[str]] = params.get("entity_types")
        layers: Optional[List[str]] = params.get("layers")
        bbox: Optional[Dict[str, float]] = params.get("bbox")

        import ezdxf
        from ezdxf.tools.text import plain_mtext
        from cad.cad_renderer import decode_cad_text, entity_intersects_bbox

        doc = ezdxf.readfile(file_path)
        msp = doc.modelspace()

        entities = []
        entity_count: Dict[str, int] = {}

        for entity in _iter_entities_with_virtual(msp):
            etype = entity.dxftype()
            if entity_types and etype not in entity_types:
                continue
            layer_name = getattr(entity.dxf, "layer", "0")
            if layers and layer_name not in layers:
                continue
            if bbox and not entity_intersects_bbox(entity, bbox):
                continue

            info: Dict[str, Any] = {
                "type": etype,
                "layer": layer_name,
                "color": getattr(entity.dxf, "color", None),
            }

            try:
                if etype == "LINE":
                    info["start"] = [entity.dxf.start.x, entity.dxf.start.y]
                    info["end"] = [entity.dxf.end.x, entity.dxf.end.y]
                elif etype == "CIRCLE":
                    info["center"] = [entity.dxf.center.x, entity.dxf.center.y]
                    info["radius"] = entity.dxf.radius
                elif etype == "TEXT":
                    info["text"] = decode_cad_text(entity.dxf.text)
                    info["position"] = [entity.dxf.insert.x, entity.dxf.insert.y]
                    info["height"] = getattr(entity.dxf, "height", None)
                elif etype == "MTEXT":
                    info["text"] = decode_cad_text(plain_mtext(entity.text))
                    info["position"] = [entity.dxf.insert.x, entity.dxf.insert.y]
                    info["height"] = getattr(entity.dxf, "char_height", None)
            except Exception:
                pass

            entities.append(info)
            entity_count[etype] = entity_count.get(etype, 0) + 1

        return {
            "entities": entities[:100],
            "total_count": len(entities),
            "entity_count": entity_count,
        }


if __name__ == "__main__":
    ExtractCadEntitiesTool().run()
