"""
Echo Tool - 测试工具
用于测试 Python 工具调用机制
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from utils.base_tool import BaseTool
from typing import Dict, Any


class EchoTool(BaseTool):
    """Echo 测试工具"""

    def execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        回显输入参数

        Args:
            params: {
                'message': str  # 要回显的消息
            }

        Returns:
            {
                'echo': str,
                'params': dict
            }
        """
        # 验证必需参数
        self.validate_params(params, ['message'])

        message = params['message']

        return {
            'echo': f"收到消息: {message}",
            'params': params,
            'status': 'success'
        }


if __name__ == '__main__':
    tool = EchoTool()
    tool.run()
