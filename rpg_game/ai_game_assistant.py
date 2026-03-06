#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from game_engine import GameEngine

class AIGameAssistant:
    """
    AI游戏助手 - 作为玩家的代理操作游戏
    你可以通过简单的命令让我帮你玩游戏
    """
    
    def __init__(self):
        self.game = GameEngine()
        self.player_name = None
        
    def initialize_game(self, player_name="冒险者"):
        """初始化游戏"""
        self.player_name = player_name
        result = self.game.start_new_game(player_name)
        return {
            "success": True,
            "message": result,
            "player_name": player_name
        }
    
    def get_game_state(self):
        """获取当前游戏状态"""
        if not self.game.player:
            return {
                "success": False,
                "message": "游戏未开始",
                "state": None
            }
        
        player = self.game.player
        state = {
            "player": {
                "name": player.name,
                "level": player.level,
                "exp": f"{player.exp}/{player.exp_to_next_level}",
                "hp": f"{player.hp}/{player.max_hp}",
                "mp": f"{player.mp}/{player.max_mp}",
                "gold": player.gold,
                "location": player.location,
                "skills": player.skills,
                "stats": {
                    "力量": player.strength,
                    "敏捷": player.agility,
                    "智力": player.intelligence,
                    "防御": player.defense
                }
            },
            "in_battle": self.game.current_monster is not None,
            "monster": str(self.game.current_monster) if self.game.current_monster else None
        }
        
        return {
            "success": True,
            "message": "游戏状态获取成功",
            "state": state
        }
    
    def execute_command(self, command_type, *args):
        """执行游戏命令"""
        if not self.game.player:
            return {
                "success": False,
                "message": "游戏未开始，请先初始化游戏"
            }
        
        try:
            if command_type == "explore":
                result = self.game.explore()
            elif command_type == "travel":
                if not args:
                    return {"success": False, "message": "请指定目的地"}
                result = self.game.travel_to(args[0])
            elif command_type == "status":
                result = self.game.show_status()
            elif command_type == "skills":
                result = self.game.show_skills()
            elif command_type == "use_skill":
                if not args:
                    return {"success": False, "message": "请指定技能名称"}
                result = self.game.use_skill(args[0])
            elif command_type == "quests":
                result = self.game.show_quests()
            elif command_type == "accept_quest":
                if not args:
                    return {"success": False, "message": "请指定任务名称"}
                result = self.game.accept_quest(args[0])
            elif command_type == "shop":
                result = self.game.show_shop()
            elif command_type == "buy":
                if not args:
                    return {"success": False, "message": "请指定物品名称"}
                result = self.game.buy_item(args[0])
            elif command_type == "rest":
                result = self.game.rest()
            elif command_type == "run_away":
                result = self.game.run_away()
            elif command_type == "save":
                result = self.game.save_game()
            elif command_type == "help":
                result = self.game.show_help()
            else:
                return {
                    "success": False,
                    "message": f"未知命令类型: {command_type}"
                }
            
            return {
                "success": True,
                "message": result,
                "command": command_type
            }
            
        except Exception as e:
            return {
                "success": False,
                "message": f"执行命令时出错: {str(e)}"
            }
    
    def get_suggestions(self):
        """根据当前状态提供建议"""
        if not self.game.player:
            return ["请先初始化游戏"]
        
        player = self.game.player
        suggestions = []
        
        # 检查生命值
        if player.hp < player.max_hp * 0.3:
            suggestions.append("⚠️ 生命值过低，建议使用'休息'或寻找治疗药水")
        
        # 检查魔力值
        if player.mp < 10:
            suggestions.append("⚠️ 魔力值不足，无法使用高级技能")
        
        # 检查位置
        if player.location in ["新手村", "城镇"]:
            suggestions.append(f"在{player.location}，你可以：'休息'恢复、'商店'购物、'任务'接任务")
        elif player.location in ["森林", "墓地", "洞穴"]:
            suggestions.append(f"在{player.location}，使用'探索'寻找怪物和宝藏")
        
        # 检查是否有怪物
        if self.game.current_monster:
            suggestions.append("战斗中！使用'使用 [技能名]'攻击或'逃跑'尝试撤退")
        
        # 检查任务
        if not player.quests and player.location in ["新手村", "城镇"]:
            suggestions.append("还没有接受任务，使用'任务'查看可用任务")
        
        # 检查金币
        if player.gold < 20:
            suggestions.append("金币不足，建议多探索击败怪物获取金币")
        
        if not suggestions:
            suggestions.append("一切正常，继续冒险吧！")
        
        return suggestions
    
    def format_state_for_display(self):
        """格式化游戏状态用于显示"""
        state = self.get_game_state()
        if not state["success"]:
            return "游戏未开始"
        
        data = state["state"]
        output = "=" * 50 + "\n"
        output += f"角色: {data['player']['name']} | 等级: {data['player']['level']}\n"
        output += f"位置: {data['player']['location']} | 金币: {data['player']['gold']}\n"
        output += f"生命: {data['player']['hp']} | 魔力: {data['player']['mp']}\n"
        output += f"经验: {data['player']['exp']}\n"
        
        if data['in_battle']:
            output += f"\n⚔️ 战斗中: {data['monster']}\n"
        
        output += "\n属性:\n"
        for stat, value in data['player']['stats'].items():
            output += f"  {stat}: {value}\n"
        
        output += f"\n技能: {', '.join(data['player']['skills'])}\n"
        output += "=" * 50
        
        return output

# 创建全局游戏助手实例
game_assistant = AIGameAssistant()

def handle_game_command(user_input):
    """
    处理用户输入的游戏命令
    返回格式化的响应
    """
    input_text = user_input.strip().lower()
    
    # 初始化游戏
    if input_text.startswith("开始游戏"):
        parts = input_text.split()
        player_name = " ".join(parts[1:]) if len(parts) > 1 else "冒险者"
        result = game_assistant.initialize_game(player_name)
        return result["message"]
    
    # 获取状态
    elif input_text in ["状态", "查看状态"]:
        return game_assistant.format_state_for_display()
    
    # 探索
    elif input_text == "探索":
        result = game_assistant.execute_command("explore")
        return result["message"]
    
    # 移动
    elif input_text.startswith("移动"):
        parts = input_text.split()
        if len(parts) > 1:
            result = game_assistant.execute_command("travel", parts[1])
            return result["message"]
        else:
            return "请指定目的地，例如：移动 森林"
    
    # 技能
    elif input_text == "技能":
        result = game_assistant.execute_command("skills")
        return result["message"]
    
    # 使用技能
    elif input_text.startswith("使用"):
        parts = input_text.split()
        if len(parts) > 1:
            result = game_assistant.execute_command("use_skill", parts[1])
            return result["message"]
        else:
            return "请指定技能名称，例如：使用 基础攻击"
    
    # 任务
    elif input_text == "任务":
        result = game_assistant.execute_command("quests")
        return result["message"]
    
    # 接受任务
    elif input_text.startswith("接受"):
        parts = input_text.split()
        if len(parts) > 1:
            result = game_assistant.execute_command("accept_quest", parts[1])
            return result["message"]
        else:
            return "请指定任务名称，例如：接受 新手任务"
    
    # 商店
    elif input_text == "商店":
        result = game_assistant.execute_command("shop")
        return result["message"]
    
    # 购买
    elif input_text.startswith("购买"):
        parts = input_text.split()
        if len(parts) > 1:
            result = game_assistant.execute_command("buy", parts[1])
            return result["message"]
        else:
            return "请指定物品名称，例如：购买 小治疗药水"
    
    # 休息
    elif input_text == "休息":
        result = game_assistant.execute_command("rest")
        return result["message"]
    
    # 逃跑
    elif input_text == "逃跑":
        result = game_assistant.execute_command("run_away")
        return result["message"]
    
    # 保存
    elif input_text == "保存":
        result = game_assistant.execute_command("save")
        return result["message"]
    
    # 帮助
    elif input_text in ["帮助", "help"]:
        result = game_assistant.execute_command("help")
        return result["message"]
    
    # 建议
    elif input_text in ["建议", "下一步", "该做什么"]:
        suggestions = game_assistant.get_suggestions()
        response = "💡 游戏建议:\n"
        for i, suggestion in enumerate(suggestions, 1):
            response += f"{i}. {suggestion}\n"
        return response
    
    # 未知命令
    else:
        return f"未知命令: {user_input}\n输入'帮助'查看可用命令。"

def start_game_session():
    """开始游戏会话"""
    welcome = """
🎮 《龙之传说》文字RPG游戏 🎮

你好！我是你的游戏助手，将作为传声筒和操作者帮你玩这个文字RPG游戏。

📋 游戏特色：
• 完整的角色属性系统
• 动态怪物生成
• 任务和商店系统
• 技能战斗系统
• 自动存档功能

🚀 快速开始：
1. 输入"开始游戏 [角色名]" 创建角色
2. 输入"帮助" 查看所有命令
3. 输入"建议" 获取游戏提示

💡 常用命令：
• 状态 - 查看角色状态
• 探索 - 在当前地点探索
• 移动 [地点] - 移动到新地点
• 使用 [技能] - 使用技能战斗
• 任务 - 查看和接受任务

现在，让我们开始冒险吧！
"""
    return welcome

# 测试函数
if __name__ == "__main__":
    print(start_game_session())
    
    # 测试一些命令
    print("\n" + "="*50)
    print("测试命令序列:")
    
    # 开始游戏
    print(handle_game_command("开始游戏 测试玩家"))
    print(handle_game_command("状态"))
    print(handle_game_command("探索"))
    print(handle_game_command("建议"))
