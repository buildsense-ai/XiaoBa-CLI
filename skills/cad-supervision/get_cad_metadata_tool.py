"""
获取 CAD 文件全局概览信息（元数据 + 缩略图）
从 brain-off-repo 移植
"""

import os
from pathlib import Path
from typing import Any, Dict

import sys; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tools', 'shared')); from base_tool import BaseTool


class GetCadMetadataTool(BaseTool):

    def execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self.validate_params(params, ["file_path"])
        file_path = params["file_path"]

        import ezdxf
        from cad.cad_renderer import get_renderable_bounds, render_drawing_region

        if not os.path.exists(file_path):
            raise FileNotFoundError(f"文件不存在: {file_path}")

        doc = ezdxf.readfile(file_path)
        msp = doc.modelspace()

        # 提取图层信息
        layers_info = {}
        total_entities = 0
        for entity in msp:
            total_entities += 1
            layer_name = getattr(entity.dxf, "layer", "0")
            if layer_name not in layers_info:
                layers_info[layer_name] = {"entity_count": 0, "entity_types": {}}
            layers_info[layer_name]["entity_count"] += 1
            entity_type = entity.dxftype()
            layers_info[layer_name]["entity_types"][entity_type] = (
                layers_info[layer_name]["entity_types"].get(entity_type, 0) + 1
            )

        bounds_result = get_renderable_bounds(file_path)
        bounds = bounds_result["bounds"] if bounds_result.get("success") else None

        result = {
            "filename": Path(file_path).name,
            "file_path": file_path,
            "metadata": {
                "dxf_version": doc.dxfversion,
                "file_size": os.path.getsize(file_path),
                "units": str(doc.units),
            },
            "bounds": bounds,
            "layers": layers_info,
            "entity_count": total_entities,
            "layer_count": len(layers_info),
        }

        if bounds_result.get("success"):
            result["bounds_source"] = "renderable_entities"
            result["bounds_quality"] = {
                "raw_entity_count": bounds_result.get("raw_entity_count", 0),
                "used_entity_count": bounds_result.get("used_entity_count", 0),
            }

        if bounds:
            thumbnail_result = render_drawing_region(
                file_path,
                bbox={
                    "x": bounds["min_x"],
                    "y": bounds["min_y"],
                    "width": bounds["width"],
                    "height": bounds["height"],
                },
                output_size=(800, 800),
                color_mode="by_layer",
            )
            if thumbnail_result.get("success"):
                result["thumbnail"] = thumbnail_result["image_path"]

        return result


if __name__ == "__main__":
    GetCadMetadataTool().run()
