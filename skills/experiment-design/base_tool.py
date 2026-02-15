"""
Base Tool Class - 所有 Python 工具的基类
提供统一的输入输出处理、错误处理和日志功能
"""

import sys
import json
import traceback
from abc import ABC, abstractmethod
from typing import Dict, Any


class BaseTool(ABC):
    """工具基类"""

    def __init__(self):
        self.name = self.__class__.__name__

    @abstractmethod
    def execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        执行工具逻辑（子类必须实现）

        Args:
            params: 工具参数字典

        Returns:
            结果字典，包含 data 字段
        """
        pass

    def run(self):
        """
        运行工具：从 stdin 读取 JSON 输入，执行工具，输出 JSON 结果到 stdout
        """
        try:
            # 读取输入
            input_data = sys.stdin.read()
            params = json.loads(input_data)

            # 执行工具
            result = self.execute(params)

            # 构建成功响应
            response = {
                'success': True,
                'data': result,
                'error': None
            }

            # 输出结果
            print(json.dumps(response, ensure_ascii=False, indent=2))
            sys.exit(0)

        except json.JSONDecodeError as e:
            self._output_error(f"JSON 解析错误: {str(e)}")
            sys.exit(1)

        except Exception as e:
            error_msg = f"{str(e)}\n{traceback.format_exc()}"
            self._output_error(error_msg)
            sys.exit(1)

    def _output_error(self, error_msg: str):
        """输出错误信息"""
        response = {
            'success': False,
            'data': None,
            'error': error_msg
        }
        print(json.dumps(response, ensure_ascii=False, indent=2))

    def validate_params(self, params: Dict[str, Any], required_fields: list):
        """
        验证必需参数

        Args:
            params: 参数字典
            required_fields: 必需字段列表

        Raises:
            ValueError: 缺少必需参数时抛出
        """
        missing = [field for field in required_fields if field not in params]
        if missing:
            raise ValueError(f"缺少必需参数: {', '.join(missing)}")
