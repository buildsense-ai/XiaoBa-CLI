#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from game_engine import GameEngine

class InteractiveRPG:
    def __init__(self):
        self.game = GameEngine()
        self.game_started = False
        
    def start_game(self, player_name="冒险者"):
        """开始新游戏"""
        result = self.game.start_new_game(player_name)
        self.game_started = True
        return result
    
    def load_game(self):
        """加载游戏"""
        result = self.game.load_game()
        if "成功" in result:
            self.game_started = True
        return result
    
    def save_game(self):
        """保存游戏"""
        return self.game.save_game()
    
    def get_status(self):
        """获取角色状态"""
        if not self.game_started:
            return "游戏未开始。请先使用'开始游戏'或'加载游戏'。"
        return self.game.show_status()
    
    def explore(self):
        """探索当前地点"""
        if not self.game_started:
            return "游戏未开始。"
        return self.game.explore()
    
    def travel(self, destination):
        """移动到指定地点"""
        if not self.game_started:
            return "游戏未开始。"
        return self.game.travel_to(destination)
    
    def show_skills(self):
        """显示技能"""
        if not self.game_started:
            return "游戏未开始。"
        return self.game.show_skills()
    
    def use_skill(self, skill_name):
        """使用技能"""
        if not self.game_started:
            return "游戏未开始。"
        return self.game.use_skill(skill_name)
    
    def show_quests(self):
        """显示任务"""
        if not self.game_started:
            return "游戏未开始。"
        return self.game.show_quests()
    
    def accept_quest(self, quest_name):
        """接受任务"""
        if not self.game_started:
            return "游戏未开始。"
        return self.game.accept_quest(quest_name)
    
    def show_shop(self):
        """显示商店"""
        if not self.game_started:
            return "游戏未开始。"
        return self.game.show_shop()
    
    def buy_item(self, item_name):
        """购买物品"""
        if not self.game_started:
            return "游戏未开始。"
        return self.game.buy_item(item_name)
    
    def rest(self):
        """休息恢复"""
        if not self.game_started:
            return "游戏未开始。"
        return self.game.rest()
    
    def run_away(self):
        """逃跑"""
        if not self.game_started:
            return "游戏未开始。"
        return self.game.run_away()
    
    def show_help(self):
        """显示帮助"""
        return self.game.show_help()
    
    def get_current_situation(self):
        """获取当前游戏状态摘要"""
        if not self.game_started or not self.game.player:
            return "游戏未开始。"
        
        player = self.game.player
        situation = f"角色: {player.name} | 等级: {player.level} | 位置: {player.location}\n"
        situation += f"生命: {player.hp}/{player.max_hp} | 魔力: {player.mp}/{player.max_mp} | 金币: {player.gold}\n"
        
        if self.game.current_monster:
            situation += f"战斗中: {self.game.current_monster}\n"
        
        return situation
    
    def process_command(self, command_text):
        """处理用户命令"""
        command = command_text.strip().lower()
        
        # 解析命令
        if command.startswith("开始游戏"):
            parts = command.split()
            if len(parts) > 1:
                return self.start_game(" ".join(parts[1:]))
            else:
                return self.start_game()
        
        elif command == "加载游戏":
            return self.load_game()
        
        elif command == "保存游戏":
            return self.save_game()
        
        elif command == "状态":
            return self.get_status()
        
        elif command == "探索":
            return self.explore()
        
        elif command.startswith("移动"):
            parts = command.split()
            if len(parts) > 1:
                return self.travel(parts[1])
            else:
                return "请指定要移动到的地点。例如：移动 森林"
        
        elif command == "技能":
            return self.show_skills()
        
        elif command.startswith("使用"):
            parts = command.split()
            if len(parts) > 1:
                return self.use_skill(parts[1])
            else:
                return "请指定要使用的技能。例如：使用 基础攻击"
        
        elif command == "战斗":
            if self.game.current_monster:
                return "战斗已经开始！使用'使用 [技能名]'进行攻击。"
            else:
                return "没有遭遇怪物。使用'探索'来寻找怪物。"
        
        elif command == "逃跑":
            return self.run_away()
        
        elif command == "任务":
            return self.show_quests()
        
        elif command.startswith("接受"):
            parts = command.split()
            if len(parts) > 1:
                return self.accept_quest(parts[1])
            else:
                return "请指定要接受的任务名称。例如：接受 新手任务"
        
        elif command == "商店":
            return self.show_shop()
        
        elif command.startswith("购买"):
            parts = command.split()
            if len(parts) > 1:
                return self.buy_item(parts[1])
            else:
                return "请指定要购买的物品名称。例如：购买 小治疗药水"
        
        elif command == "休息":
            return self.rest()
        
        elif command == "背包":
            if self.game_started and self.game.player:
                status = self.game.player.get_status()
                output = "📦 背包物品:\n"
                for category, items in status['inventory'].items():
                    if items:
                        output += f"{category}: {', '.join(items)}\n"
                return output
            else:
                return "游戏未开始。"
        
        elif command == "帮助":
            return self.show_help()
        
        elif command == "当前状态":
            return self.get_current_situation()
        
        elif command in ["退出", "结束"]:
            return "游戏结束。感谢游玩！"
        
        else:
            return f"未知命令: {command_text}\n输入'帮助'查看可用命令。"

# 创建游戏实例
game = InteractiveRPG()

def play_rpg():
    """游戏主函数"""
    print("="*60)
    print("欢迎来到《龙之传说》文字RPG游戏！")
    print("我是你的游戏助手，将作为传声筒和操作者帮你玩游戏。")
    print("="*60)
    print("\n你可以通过我发送命令来玩游戏。")
    print("输入 '帮助' 查看所有可用命令。")
    print("输入 '退出' 结束游戏。")
    print("\n" + "="*60)
    
    # 初始选择
    print("\n请选择：")
    print("1. 开始新游戏")
    print("2. 加载游戏")
    print("3. 查看帮助")
    
    choice = input("请输入选择 (1-3): ").strip()
    
    if choice == "1":
        player_name = input("请输入角色名称（直接回车使用默认名称）: ").strip()
        if player_name:
            print(game.start_game(player_name))
        else:
            print(game.start_game())
    elif choice == "2":
        print(game.load_game())
    elif choice == "3":
        print(game.show_help())
    else:
        print("无效选择，开始新游戏。")
        print(game.start_game())
    
    # 游戏主循环
    while True:
        print("\n" + "="*60)
        print("当前游戏状态:")
        print(game.get_current_situation())
        print("="*60)
        
        command = input("\n请输入命令: ").strip()
        
        if command.lower() in ["退出", "结束", "exit", "quit"]:
            print("感谢游玩《龙之传说》！再见！")
            break
        
        result = game.process_command(command)
        print("\n" + result)

if __name__ == "__main__":
    try:
        play_rpg()
    except KeyboardInterrupt:
        print("\n\n游戏被中断。")
    except Exception as e:
        print(f"\n游戏发生错误: {e}")
