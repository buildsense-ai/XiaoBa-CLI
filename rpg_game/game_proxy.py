#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
游戏代理系统 - AI作为玩家的游戏代理
通过这个系统，AI可以代替玩家操作游戏，玩家只需给出指令
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from ai_game_assistant import handle_game_command, game_assistant

class GameProxy:
    """
    游戏代理类 - AI作为玩家的游戏操作代理
    """
    
    def __init__(self):
        self.game_history = []
        self.current_state = None
        
    def process_player_request(self, player_request):
        """
        处理玩家请求，返回游戏响应
        """
        # 记录请求
        self.game_history.append({
            "type": "player_request",
            "content": player_request,
            "timestamp": self._get_timestamp()
        })
        
        # 处理请求
        response = handle_game_command(player_request)
        
        # 记录响应
        self.game_history.append({
            "type": "game_response",
            "content": response,
            "timestamp": self._get_timestamp()
        })
        
        # 更新当前状态
        self.current_state = game_assistant.format_state_for_display()
        
        return response
    
    def get_game_summary(self):
        """获取游戏摘要"""
        if not game_assistant.game.player:
            return "游戏尚未开始"
        
        player = game_assistant.game.player
        summary = f"""
🎮 游戏摘要 🎮

角色信息:
  名称: {player.name}
  等级: {player.level}
  经验: {player.exp}/{player.exp_to_next_level}
  位置: {player.location}
  金币: {player.gold}

战斗状态: {'战斗中' if game_assistant.game.current_monster else '安全'}
历史记录: {len(self.game_history)//2} 次交互
        """
        return summary
    
    def get_recommended_actions(self):
        """获取推荐行动"""
        suggestions = game_assistant.get_suggestions()
        
        if not suggestions:
            return "没有特别建议，继续冒险吧！"
        
        recommendations = "💡 推荐行动:\n"
        for i, suggestion in enumerate(suggestions, 1):
            recommendations += f"{i}. {suggestion}\n"
        
        return recommendations
    
    def save_game_progress(self):
        """保存游戏进度"""
        result = game_assistant.execute_command("save")
        if result["success"]:
            return "✅ 游戏进度已保存"
        else:
            return f"❌ 保存失败: {result['message']}"
    
    def _get_timestamp(self):
        """获取时间戳"""
        from datetime import datetime
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    def get_command_help(self):
        """获取命令帮助"""
        return """
🎮 游戏命令帮助 🎮

【游戏管理】
• 开始游戏 [角色名] - 创建新角色
• 保存 - 保存游戏进度
• 帮助 - 显示此帮助

【角色操作】
• 状态 - 查看角色详细状态
• 技能 - 查看可用技能
• 背包 - 查看背包物品

【探索移动】
• 探索 - 在当前地点探索
• 移动 [地点] - 移动到指定地点
  可用地点: 新手村, 森林, 墓地, 洞穴, 城镇

【战斗系统】
• 使用 [技能名] - 使用技能攻击
• 逃跑 - 尝试从战斗中逃跑

【任务系统】
• 任务 - 查看可用任务
• 接受 [任务名] - 接受任务

【商店系统】
• 商店 - 查看商店商品
• 购买 [物品名] - 购买物品

【恢复系统】
• 休息 - 在安全地点恢复生命和魔力

【智能辅助】
• 建议 - 获取游戏建议
• 摘要 - 查看游戏摘要
        """

# 创建全局游戏代理实例
game_proxy = GameProxy()

def play_game_via_proxy(player_input):
    """
    通过代理玩游戏的主函数
    玩家输入 -> AI代理处理 -> 返回游戏响应
    """
    # 特殊命令处理
    if player_input.lower() in ["摘要", "游戏摘要"]:
        return game_proxy.get_game_summary()
    
    elif player_input.lower() in ["保存进度", "保存游戏"]:
        return game_proxy.save_game_progress()
    
    elif player_input.lower() in ["历史", "游戏历史"]:
        history_count = len(game_proxy.game_history) // 2
        return f"游戏历史记录: {history_count} 次交互"
    
    elif player_input.lower() in ["重置", "重新开始"]:
        # 重新初始化游戏助手
        global game_assistant
        from ai_game_assistant import AIGameAssistant
        game_assistant = AIGameAssistant()
        game_proxy.__init__()
        return "游戏已重置，可以重新开始游戏"
    
    # 正常游戏命令处理
    response = game_proxy.process_player_request(player_input)
    
    # 添加建议（如果不是建议命令本身）
    if player_input.lower() not in ["建议", "推荐"]:
        suggestions = game_assistant.get_suggestions()
        if suggestions and len(suggestions) > 0:
            response += "\n\n💡 提示: " + suggestions[0]
    
    return response

def start_proxy_game_session():
    """开始代理游戏会话"""
    welcome_message = """
✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨
          《龙之传说》AI代理游戏系统
✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨

🎯 游戏模式：AI代理操作
🤖 我是你的游戏代理，将代替你操作游戏角色
🎮 你只需告诉我想要做什么，我来执行

📋 核心功能：
• 🎭 AI代理操作 - 你指挥，我执行
• 📊 状态监控 - 实时显示游戏状态
• 💡 智能建议 - 根据情况提供最佳行动建议
• 💾 自动存档 - 随时保存游戏进度
• 📜 历史记录 - 记录所有游戏交互

🚀 快速开始：
输入"开始游戏 [你的角色名]" 来创建角色
然后告诉我你想要做什么！

💡 试试这些命令：
• "开始游戏 勇者"
• "状态"
• "探索"
• "建议"

输入"帮助"查看完整命令列表
输入"退出"结束游戏

准备好开始冒险了吗？ 🐉⚔️
"""
    return welcome_message

# 测试代码
if __name__ == "__main__":
    print(start_proxy_game_session())
    
    # 测试代理系统
    test_commands = [
        "开始游戏 测试玩家",
        "状态",
        "探索",
        "建议",
        "摘要"
    ]
    
    print("\n" + "="*60)
    print("测试代理系统:")
    
    for cmd in test_commands:
        print(f"\n>>> 玩家: {cmd}")
        response = play_game_via_proxy(cmd)
        print(f"<<< 游戏: {response}")
        print("-"*40)
