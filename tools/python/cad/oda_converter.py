"""
DWG 到 DXF 转换服务 - 基于 ODA File Converter

使用免费的 ODA File Converter 进行本地转换，无需网络访问
下载地址: https://www.opendesign.com/guestfiles/oda_file_converter
从 brain-off-repo 移植，增加 Windows 路径支持。
"""

import os
import shutil
import tempfile
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional


class ODAConverter:
    """ODA File Converter 包装器"""

    def __init__(self, oda_path: Optional[str] = None):
        self.oda_path = oda_path or self._find_oda_converter()

    def _find_oda_converter(self) -> Optional[str]:
        """自动查找 ODA File Converter 安装路径"""
        possible_paths = []

        if os.name == "nt":
            # Windows 常见安装位置
            program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
            program_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
            for pf in [program_files, program_files_x86]:
                possible_paths.append(os.path.join(pf, "ODA", "ODAFileConverter", "ODAFileConverter.exe"))
                possible_paths.append(os.path.join(pf, "ODA File Converter", "ODAFileConverter.exe"))
        else:
            # macOS / Linux
            possible_paths.extend([
                "/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter",
                "/usr/local/bin/ODAFileConverter",
                os.path.expanduser("~/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter"),
            ])

        for path in possible_paths:
            if os.path.exists(path) and os.access(path, os.X_OK):
                return path
        return None

    def is_available(self) -> bool:
        """检查 ODA File Converter 是否可用"""
        return self.oda_path is not None and os.path.exists(self.oda_path)

    def convert_dwg_to_dxf(
        self,
        dwg_path: str,
        output_path: Optional[str] = None,
        dxf_version: str = "ACAD2018",
        recursive: bool = False,
        audit: bool = True,
    ) -> Dict[str, Any]:
        """将 DWG 文件转换为 DXF 格式"""
        try:
            if not self.is_available():
                return {
                    "success": False,
                    "error": "ODA File Converter 未安装。请从 https://www.opendesign.com/guestfiles/oda_file_converter 下载",
                }

            if not os.path.exists(dwg_path):
                return {"success": False, "error": f"文件或目录不存在: {dwg_path}"}

            input_is_file = os.path.isfile(dwg_path)

            if input_is_file:
                return self._convert_single_file(dwg_path, output_path, dxf_version, audit)
            else:
                return self._convert_directory(dwg_path, output_path, dxf_version, recursive, audit)

        except Exception as e:
            return {"success": False, "error": f"转换失败: {str(e)}"}

    def _convert_single_file(
        self, dwg_path: str, output_path: Optional[str], dxf_version: str, audit: bool,
    ) -> Dict[str, Any]:
        """转换单个 DWG 文件"""
        if not dwg_path.lower().endswith(".dwg"):
            return {"success": False, "error": f"不是 DWG 文件: {dwg_path}"}

        if output_path is None:
            output_path = dwg_path.rsplit(".", 1)[0] + ".dxf"

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_input = os.path.join(temp_dir, "input")
            temp_output = os.path.join(temp_dir, "output")
            os.makedirs(temp_input)
            os.makedirs(temp_output)

            shutil.copy2(dwg_path, os.path.join(temp_input, os.path.basename(dwg_path)))

            result = self._run_conversion(temp_input, temp_output, dxf_version, recursive=False, audit=audit)
            if not result["success"]:
                return result

            converted = list(Path(temp_output).glob("*.dxf"))
            if not converted:
                return {"success": False, "error": "转换失败：未生成 DXF 文件"}

            shutil.copy2(str(converted[0]), output_path)

        return {
            "success": True,
            "data": {
                "output_path": output_path,
                "file_size": os.path.getsize(output_path),
                "converter": "oda",
            },
        }

    def _convert_directory(
        self, dwg_dir: str, output_path: Optional[str],
        dxf_version: str, recursive: bool, audit: bool,
    ) -> Dict[str, Any]:
        """批量转换目录中的 DWG 文件"""
        if output_path is None:
            output_path = os.path.join(os.path.dirname(dwg_dir), "converted")
        os.makedirs(output_path, exist_ok=True)

        result = self._run_conversion(dwg_dir, output_path, dxf_version, recursive=recursive, audit=audit)
        if result["success"]:
            glob_func = Path(output_path).rglob if recursive else Path(output_path).glob
            converted = list(glob_func("*.dxf"))
            result["data"]["files_converted"] = len(converted)
        return result

    def _run_conversion(
        self, input_dir: str, output_dir: str,
        output_version: str, recursive: bool = False, audit: bool = True,
    ) -> Dict[str, Any]:
        """执行 ODA File Converter 转换"""
        try:
            cmd = [
                self.oda_path,
                input_dir,
                output_dir,
                output_version,
                "DXF",
                "1" if recursive else "0",
                "1" if audit else "0",
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

            if result.returncode != 0:
                return {"success": False, "error": f"ODA 转换失败: {result.stderr or result.stdout}"}

            return {"success": True, "data": {"output_path": output_dir}}

        except subprocess.TimeoutExpired:
            return {"success": False, "error": "转换超时（超过5分钟）"}
        except Exception as e:
            return {"success": False, "error": f"执行转换失败: {str(e)}"}


_converter = None


def get_converter() -> ODAConverter:
    """获取全局转换器实例"""
    global _converter
    if _converter is None:
        _converter = ODAConverter()
    return _converter


def convert_dwg_to_dxf(
    dwg_path: str,
    output_path: Optional[str] = None,
    dxf_version: str = "ACAD2018",
    **kwargs,
) -> Dict[str, Any]:
    """便捷函数：将 DWG 文件转换为 DXF 格式"""
    return get_converter().convert_dwg_to_dxf(dwg_path, output_path, dxf_version, **kwargs)