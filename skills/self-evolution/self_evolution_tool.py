"""
Self Evolution Tool - 自我进化工具
允许 XiaoBa 创建新的工具和技能来扩展自己的能力
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tools', 'global'))

from base_tool import BaseTool
from typing import Dict, Any
import json
import re


class SelfEvolutionTool(BaseTool):
    """自我进化工具 - 创建新的工具和技能"""

    def __init__(self):
        super().__init__()
        self.skills_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'skills'))

    def execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        执行自我进化操作

        Args:
            params: {
                'action': str,  # 'create_tool' 或 'create_skill'
                'name': str,    # 工具或技能名称
                'description': str,  # 描述
                'code': str,    # Python代码（仅用于create_tool）
                'parameters': dict,  # 参数定义（仅用于create_tool）
                'prompt': str,  # Skill prompt（仅用于create_skill）
                'timeout': int  # 超时时间（可选，默认30000）
            }

        Returns:
            {
                'success': bool,
                'message': str,
                'created_file': str
            }
        """
        # 验证必需参数
        self.validate_params(params, ['action', 'name', 'description'])

        action = params['action']
        name = params['name']
        description = params['description']

        # 验证名称安全性
        if not self._is_safe_name(name):
            return {
                'success': False,
                'message': f'名称不安全: {name}。只允许字母、数字、下划线和连字符。',
                'status': 'error'
            }

        try:
            if action == 'create_tool':
                return self._create_tool(params)
            elif action == 'create_skill':
                return self._create_skill(params)
            else:
                return {
                    'success': False,
                    'message': f'未知操作: {action}',
                    'status': 'error'
                }
        except Exception as e:
            return {
                'success': False,
                'message': f'执行失败: {str(e)}',
                'status': 'error'
            }

    def _is_safe_name(self, name: str) -> bool:
        """验证名称是否安全（只包含字母、数字、下划线、连字符）"""
        return bool(re.match(r'^[a-zA-Z0-9_-]+$', name))

    def _create_tool(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """创建新的Python工具（放在对应 skill 目录下）"""
        name = params['name']
        description = params['description']
        code = params.get('code', '')
        parameters = params.get('parameters', {})

        # 验证必需参数
        if not code:
            return {
                'success': False,
                'message': '缺少必需参数: code',
                'status': 'error'
            }

        # 工具脚本放在 skills/<name>/ 目录下
        tool_dir = os.path.join(self.skills_dir, name)
        os.makedirs(tool_dir, exist_ok=True)
        tool_file = os.path.join(tool_dir, f'{name}_tool.py')

        # 检查文件是否已存在
        if os.path.exists(tool_file):
            return {
                'success': False,
                'message': f'工具已存在: {name}',
                'status': 'error'
            }

        # 写入Python文件
        with open(tool_file, 'w', encoding='utf-8') as f:
            f.write(code)

        return {
            'success': True,
            'message': f'成功创建工具: {name}，脚本位于 skills/{name}/{name}_tool.py',
            'created_file': tool_file,
            'status': 'success'
        }

    def _create_skill(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """创建新的Skill（生成符合 SkillParser 的 YAML frontmatter 格式）"""
        name = params['name']
        description = params['description']
        prompt = params.get('prompt', '')
        invocable = params.get('invocable', 'user')
        argument_hint = params.get('argument_hint', '')
        max_turns = params.get('max_turns', 30)

        # 验证必需参数
        if not prompt:
            return {
                'success': False,
                'message': '缺少必需参数: prompt',
                'status': 'error'
            }

        # 验证 invocable 值
        if invocable not in ('user', 'auto', 'both'):
            invocable = 'user'

        # 创建skill目录
        skill_dir = os.path.join(self.skills_dir, name)
        if os.path.exists(skill_dir):
            return {
                'success': False,
                'message': f'Skill已存在: {name}',
                'status': 'error'
            }

        os.makedirs(skill_dir, exist_ok=True)

        # 生成 YAML frontmatter
        frontmatter = f"---\nname: {name}\ndescription: {description}\ninvocable: {invocable}\n"
        if argument_hint:
            frontmatter += f"argument-hint: \"{argument_hint}\"\n"
        if max_turns:
            frontmatter += f"max-turns: {max_turns}\n"
        frontmatter += "---\n\n"

        # 创建SKILL.md文件
        skill_file = os.path.join(skill_dir, 'SKILL.md')
        skill_content = frontmatter + prompt

        with open(skill_file, 'w', encoding='utf-8') as f:
            f.write(skill_content)

        return {
            'success': True,
            'message': f'成功创建Skill: {name}',
            'created_file': skill_file,
            'status': 'success'
        }


if __name__ == '__main__':
    tool = SelfEvolutionTool()
    tool.run()

