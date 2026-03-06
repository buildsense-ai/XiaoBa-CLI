#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
《龙之传说》AI代理游戏 - 启动脚本
通过这个脚本，AI将作为你的游戏代理，代替你操作游戏
"""

import sys
import os

# 添加当前目录到Python路径
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(current_dir)

from game_proxy import play_game_via_proxy, start_proxy_game_session

class AIGameMaster:
    """
    AI游戏大师 - 管理整个游戏会话
    """
    
    def __init__(self):
        self.session_active = True
        self.player_name = None
        
    def start_session(self):
        """开始游戏会话"""
        print(start_proxy_game_session())
        print("\n" + "="*60)
        
        # 初始交互
        print("🤖 AI游戏代理: 你好！我是你的游戏代理。")
        print("🤖 AI游戏代理: 请告诉我你的角色名，或者直接说'开始游戏'使用默认名称。")
        
        while self.session_active:
            try:
                # 获取玩家输入
                player_input = input("\n👤 你: ").strip()
                
                if not player_input:
                    continue
                
                # 处理退出命令
                if player_input.lower() in ["退出", "结束", "exit", "quit"]:
                    print("\n🤖 AI游戏代理: 感谢游玩《龙之传说》！再见！ 👋")
                    self.session_active = False
                    break
                
                # 处理游戏命令
                response = play_game_via_proxy(player_input)
                
                # 显示响应
                print(f"\n🤖 AI游戏代理: {response}")
                
                # 如果是开始游戏，记录玩家名
                if player_input.lower().startswith("开始游戏"):
                    parts = player_input.split()
                    self.player_name = " ".join(parts[1:]) if len(parts) > 1 else "冒险者"
                    
            except KeyboardInterrupt:
                print("\n\n🤖 AI游戏代理: 游戏被中断。")
                self.session_active = False
                break
            except Exception as e:
                print(f"\n🤖 AI游戏代理: 抱歉，发生了错误: {str(e)}")
                print("🤖 AI游戏代理: 请重新输入命令。")

def main():
    """主函数"""
    print("正在启动《龙之传说》AI代理游戏系统...")
    print("="*60)
    
    try:
        game_master = AIGameMaster()
        game_master.start_session()
    except Exception as e:
        print(f"启动游戏时发生错误: {e}")
        print("请确保所有游戏文件完整。")

if __name__ == "__main__":
    main()
