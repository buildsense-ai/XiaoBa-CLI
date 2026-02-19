"""
DWG 转 DXF 格式转换工具
从 brain-off-repo 移植，基于 ODA File Converter
"""

import os
from typing import Any, Dict

import sys; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tools', 'global')); from base_tool import BaseTool


class ConvertDwgToDxfTool(BaseTool):

    def execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self.validate_params(params, ["dwg_path"])

        dwg_path = params["dwg_path"]
        output_path = params.get("output_path")
        delete_original = params.get("delete_original", True)

        from cad.oda_converter import ODAConverter

        converter = ODAConverter()
        if not converter.is_available():
            raise RuntimeError(
                "ODA File Converter 未安装。"
                "请从 https://www.opendesign.com/guestfiles/oda_file_converter 下载安装"
            )

        result = converter.convert_dwg_to_dxf(
            dwg_path=dwg_path, output_path=output_path,
        )

        if not result.get("success"):
            raise RuntimeError(result.get("error", "转换失败"))

        data = result["data"]

        # 转换成功后可选删除原始文件
        if delete_original:
            try:
                os.remove(dwg_path)
                data["deleted_original"] = True
            except Exception as e:
                data["deleted_original"] = False
                data["warning"] = f"删除原始文件失败: {e}"

        return data


if __name__ == "__main__":
    ConvertDwgToDxfTool().run()
