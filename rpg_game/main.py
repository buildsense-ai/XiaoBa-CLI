#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from game_engine import GameEngine

class RPGGame:
    def __init__(self):
        self.game = GameEngine()
        self.running = True
        
    def print_welcome(self):
        welcome = """
╔══════════════════════════════════════════════════════════╗
║                    《龙之传说》文字RPG游戏               ║
║                                                          ║
║  欢迎来到这个充满冒险的世界！在这里你可以：             ║
║  • 探索神秘的地点                                        ║
║  • 与各种怪物战斗                                        ║
║  • 完成任务获得奖励                                      ║
║  • 购买装备提升实力                                      ║
║  • 升级学习新技能                                        ║
╚══════════════════════════════════════════════════════════╝
        """
        print(welcome)
    
    def process_command(self, command):
        cmd_parts = command.strip().split()
        if not cmd_parts:
            return "请输入命令。输入'帮助'查看可用命令。"
        
        main_cmd = cmd_parts[0].lower()
        
        # 处理中文命令
        if main_cmd in ["帮助", "help"]:
            return self.game.show_help()
        
        elif main_cmd in ["开始", "start"]:
            if len(cmd_parts) > 1:
                player_name = cmd_parts[1]
                return self.game.start_new_game(player_name)
            else:
                return self.game.start_new_game()
        
        elif main_cmd in ["加载", "load"]:
            return self.game.load_game()
        
        elif main_cmd in ["保存", "save"]:
            return self.game.save_game()
        
        elif main_cmd in ["状态", "status"]:
            return self.game.show_status()
        
        elif main_cmd in ["探索", "explore"]:
            return self.game.explore()
        
        elif main_cmd in ["移动", "travel", "go"]:
            if len(cmd_parts) > 1:
                destination = cmd_parts[1]
                return self.game.travel_to(destination)
            else:
                return "请指定要移动到的地点。例如：移动 森林"
        
        elif main_cmd in ["技能", "skills"]:
            return self.game.show_skills()
        
        elif main_cmd in ["使用", "use"]:
            if len(cmd_parts) > 1:
                skill_name = cmd_parts[1]
                return self.game.use_skill(skill_name)
            else:
                return "请指定要使用的技能。例如：使用 基础攻击"
        
        elif main_cmd in ["战斗", "fight", "attack"]:
            if self.game.current_monster:
                return "战斗已经开始！使用'使用 [技能名]'进行攻击。"
            else:
                return "没有遭遇怪物。使用'探索'来寻找怪物。"
        
        elif main_cmd in ["逃跑", "run", "flee"]:
            return self.game.run_away()
        
        elif main_cmd in ["任务", "quests"]:
            return self.game.show_quests()
        
        elif main_cmd in ["接受", "accept"]:
            if len(cmd_parts) > 1:
                quest_name = cmd_parts[1]
                return self.game.accept_quest(quest_name)
            else:
                return "请指定要接受的任务名称。例如：接受 新手任务"
        
        elif main_cmd in ["商店", "shop"]:
            return self.game.show_shop()
        
        elif main_cmd in ["购买", "buy"]:
            if len(cmd_parts) > 1:
                item_name = cmd_parts[1]
                return self.game.buy_item(item_name)
            else:
                return "请指定要购买的物品名称。例如：购买 小治疗药水"
        
        elif main_cmd in ["休息", "rest"]:
            return self.game.rest()
        
        elif main_cmd in ["背包", "inventory", "inv"]:
            status = self.game.player.get_status() if self.game.player else None
            if status:
                output = "📦 背包物品:\n"
                for category, items in status['inventory'].items():
                    if items:
                        output += f"{category}: {', '.join(items)}\n"
                return output
            else:
                return "游戏未开始。"
        
        elif main_cmd in ["退出", "quit", "exit"]:
            self.running = False
            return "感谢游玩《龙之传说》！再见！"
        
        else:
            return f"未知命令: {command}\n输入'帮助'查看可用命令。"
    
    def run(self):
        self.print_welcome()
        
        print("\n请选择：")
        print("1. 开始新游戏")
        print("2. 加载游戏")
        print("3. 退出")
        
        choice = input("请输入选择 (1-3): ").strip()
        
        if choice == "1":
            player_name = input("请输入角色名称（直接回车使用默认名称）: ").strip()
            if player_name:
                print(self.game.start_new_game(player_name))
            else:
                print(self.game.start_new_game())
        elif choice == "2":
            print(self.game.load_game())
        elif choice == "3":
            print("再见！")
            return
        else:
            print("无效选择，开始新游戏。")
            print(self.game.start_new_game())
        
        # 主游戏循环
        while self.running and self.game.game_running:
            print("\n" + "="*50)
            if self.game.current_monster:
                print(f"⚠️ 战斗中: {self.game.current_monster}")
            
            print(f"当前位置: {self.game.player.location if self.game.player else '未知'}")
            command = input("请输入命令: ").strip()
            
            if command:
                result = self.process_command(command)
                print("\n" + result)
            
            # 检查游戏是否结束
            if not self.game.game_running:
                print("\n游戏结束！")
                restart = input("是否重新开始？(y/n): ").strip().lower()
                if restart == 'y':
                    self.game = GameEngine()
                    print(self.game.start_new_game())
                else:
                    self.running = False

if __name__ == "__main__":
    try:
        game = RPGGame()
        game.run()
    except KeyboardInterrupt:
        print("\n\n游戏被中断。")
    except Exception as e:
        print(f"\n游戏发生错误: {e}")
        print("请报告此错误给开发者。")
