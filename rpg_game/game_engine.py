import random
import json
from datetime import datetime
from player import Player
from monsters import MonsterFactory

class GameEngine:
    def __init__(self):
        self.player = None
        self.current_monster = None
        self.game_running = False
        self.locations = {
            "新手村": {
                "description": "一个宁静的小村庄，冒险者的起点。",
                "monster_chance": 0.2,
                "shop_available": True,
                "quest_giver": True
            },
            "森林": {
                "description": "茂密的森林，隐藏着各种野兽和宝藏。",
                "monster_chance": 0.6,
                "shop_available": False,
                "quest_giver": False
            },
            "墓地": {
                "description": "阴森的墓地，亡灵生物在此游荡。",
                "monster_chance": 0.7,
                "shop_available": False,
                "quest_giver": False
            },
            "洞穴": {
                "description": "黑暗的洞穴，恶魔和元素生物的家园。",
                "monster_chance": 0.8,
                "shop_available": False,
                "quest_giver": False
            },
            "城镇": {
                "description": "繁华的城镇，可以休息和交易。",
                "monster_chance": 0.1,
                "shop_available": True,
                "quest_giver": True
            }
        }
        
        self.quests = {
            "新手任务": {
                "description": "击败3只森林中的野兽",
                "target": "野兽",
                "required": 3,
                "reward_exp": 100,
                "reward_gold": 50,
                "location": "森林"
            },
            "亡灵清除": {
                "description": "消灭5只墓地中的亡灵",
                "target": "亡灵",
                "required": 5,
                "reward_exp": 200,
                "reward_gold": 100,
                "location": "墓地"
            },
            "恶魔猎手": {
                "description": "击败洞穴中的3只恶魔",
                "target": "恶魔",
                "required": 3,
                "reward_exp": 300,
                "reward_gold": 150,
                "location": "洞穴"
            }
        }
        
        self.shop_items = {
            "小治疗药水": {"price": 20, "effect": "恢复50HP", "type": "potion"},
            "中治疗药水": {"price": 50, "effect": "恢复100HP", "type": "potion"},
            "小魔力药水": {"price": 30, "effect": "恢复30MP", "type": "potion"},
            "铁剑": {"price": 100, "effect": "攻击力+5", "type": "weapon"},
            "皮甲": {"price": 80, "effect": "防御力+3", "type": "armor"},
            "魔法书": {"price": 150, "effect": "智力+5", "type": "misc"}
        }
    
    def start_new_game(self, player_name="冒险者"):
        self.player = Player(player_name)
        self.game_running = True
        return f"欢迎来到《龙之传说》！\n{player_name}，你的冒险开始了！\n当前位置：{self.player.location}\n输入 'help' 查看可用命令。"
    
    def load_game(self, filename="save_game.json"):
        self.player = Player.load_game(filename)
        if self.player:
            self.game_running = True
            return f"游戏加载成功！\n欢迎回来，{self.player.name}！\n当前位置：{self.player.location}"
        else:
            return "没有找到保存的游戏文件。"
    
    def save_game(self, filename="save_game.json"):
        if self.player:
            return self.player.save_game(filename)
        return "没有玩家数据可以保存。"
    
    def explore(self):
        if not self.game_running or not self.player:
            return "游戏未开始。"
        
        location = self.player.location
        location_info = self.locations.get(location, {})
        
        result = f"你在{location}探索...\n"
        result += f"{location_info.get('description', '未知区域')}\n"
        
        # 检查是否遇到怪物
        monster_chance = location_info.get('monster_chance', 0.3)
        if random.random() < monster_chance:
            self.current_monster = MonsterFactory.create_monster(self.player.level, location)
            result += f"\n⚠️ 遭遇了 {self.current_monster}！\n"
            result += "输入 '战斗' 开始战斗，或 '逃跑' 尝试逃跑。"
        else:
            # 可能找到物品
            if random.random() < 0.3:
                found_items = ["草药", "小金币袋", "旧装备", "魔法碎片"]
                found_item = random.choice(found_items)
                if found_item == "小金币袋":
                    gold = random.randint(10, 30)
                    self.player.gold += gold
                    result += f"\n💰 你找到了一个小金币袋，获得 {gold} 金币！"
                else:
                    self.player.inventory["misc"].append(found_item)
                    result += f"\n📦 你找到了 {found_item}！"
            else:
                result += "\n这次探索没有发现特别的东西。"
        
        return result
    
    def travel_to(self, destination):
        if not self.game_running or not self.player:
            return "游戏未开始。"
        
        if destination not in self.locations:
            return f"无法前往 {destination}，该位置不存在。"
        
        if self.current_monster:
            return "战斗中无法移动！"
        
        self.player.location = destination
        return f"你已到达 {destination}。\n{self.locations[destination]['description']}"
    
    def show_status(self):
        if not self.game_running or not self.player:
            return "游戏未开始。"
        
        status = self.player.get_status()
        output = "=" * 40 + "\n"
        output += f"角色: {status['name']}\n"
        output += f"等级: {status['level']} | 经验: {status['exp']}\n"
        output += f"生命: {status['hp']} | 魔力: {status['mp']}\n"
        output += f"位置: {status['location']} | 金币: {status['gold']}\n"
        output += "\n属性:\n"
        for stat_name, value in status['stats'].items():
            output += f"  {stat_name}: {value}\n"
        
        output += "\n技能: " + ", ".join(status['skills']) + "\n"
        
        output += "\n背包:\n"
        for category, items in status['inventory'].items():
            if items:
                output += f"  {category}: {', '.join(items)}\n"
        
        output += f"\n进行中的任务: {status['quests']} 个\n"
        output += "=" * 40
        
        return output
    
    def show_skills(self):
        if not self.game_running or not self.player:
            return "游戏未开始。"
        
        skills = self.player.skills
        output = "可用技能:\n"
        for i, skill in enumerate(skills, 1):
            output += f"{i}. {skill}\n"
            if skill == "基础攻击":
                output += "   消耗: 无 | 效果: 造成力量×1的伤害\n"
            elif skill == "强力斩":
                output += "   消耗: 10MP | 效果: 造成力量×2的伤害\n"
            elif skill == "快速连击":
                output += "   消耗: 15MP | 效果: 造成敏捷×1.5的伤害（2次）\n"
            elif skill == "魔法弹":
                output += "   消耗: 20MP | 效果: 造成智力×2的魔法伤害\n"
            elif skill == "治疗术":
                output += "   消耗: 25MP | 效果: 恢复智力×3的生命值\n"
            elif skill == "防御姿态":
                output += "   消耗: 5MP | 效果: 本回合防御力翻倍\n"
        
        return output
    
    def use_skill(self, skill_name):
        if not self.game_running or not self.player:
            return "游戏未开始。"
        
        if not self.current_monster:
            return "没有目标可以攻击。"
        
        if skill_name not in self.player.skills:
            return f"你没有学会技能 '{skill_name}'。"
        
        # 计算伤害
        damage = 0
        mp_cost = 0
        extra_effect = ""
        
        if skill_name == "基础攻击":
            damage = self.player.strength
            mp_cost = 0
        elif skill_name == "强力斩":
            mp_cost = 10
            if self.player.use_mp(mp_cost):
                damage = self.player.strength * 2
            else:
                return "魔力不足！"
        elif skill_name == "快速连击":
            mp_cost = 15
            if self.player.use_mp(mp_cost):
                damage = int(self.player.agility * 1.5) * 2
            else:
                return "魔力不足！"
        elif skill_name == "魔法弹":
            mp_cost = 20
            if self.player.use_mp(mp_cost):
                damage = self.player.intelligence * 2
            else:
                return "魔力不足！"
        elif skill_name == "治疗术":
            mp_cost = 25
            if self.player.use_mp(mp_cost):
                heal_amount = self.player.intelligence * 3
                healed = self.player.heal(heal_amount)
                return f"你使用了治疗术，恢复了 {healed} 点生命值。"
            else:
                return "魔力不足！"
        elif skill_name == "防御姿态":
            mp_cost = 5
            if self.player.use_mp(mp_cost):
                self.player.defense *= 2
                extra_effect = "（防御力翻倍）"
                return f"你进入了防御姿态{extra_effect}。"
            else:
                return "魔力不足！"
        
        # 对怪物造成伤害
        actual_damage = self.current_monster.take_damage(damage)
        
        result = f"你使用了 {skill_name}{extra_effect}，对 {self.current_monster.name} 造成了 {actual_damage} 点伤害！\n"
        
        if not self.current_monster.is_alive():
            result += self._defeat_monster()
        else:
            # 怪物反击
            monster_damage = self.current_monster.attack_player(self.player.defense)
            self.player.take_damage(monster_damage)
            result += f"{self.current_monster.name} 对你造成了 {monster_damage} 点伤害！\n"
            
            if self.player.hp <= 0:
                result += "\n💀 你被击败了！游戏结束。"
                self.game_running = False
        
        return result
    
    def _defeat_monster(self):
        if not self.current_monster:
            return ""
        
        monster = self.current_monster
        exp_gain = monster.exp_reward
        gold_gain = monster.gold_reward
        
        # 获得经验和金币
        level_up_msg = self.player.gain_exp(exp_gain)
        self.player.gold += gold_gain
        
        # 获得掉落物品
        drops = monster.drops
        for item in drops:
            if "药水" in item:
                self.player.inventory["potions"].append(item)
            elif "装备" in item or "武器" in item:
                self.player.inventory["weapons"].append(item)
            else:
                self.player.inventory["misc"].append(item)
        
        result = f"\n🎉 你击败了 {monster.name}！\n"
        result += f"获得 {exp_gain} 经验值 | 获得 {gold_gain} 金币\n"
        
        if level_up_msg:
            result += f"\n{level_up_msg}\n"
        
        if drops:
            result += f"掉落物品: {', '.join(drops)}\n"
        
        # 检查任务进度
        quest_updates = self._update_quests(monster.type)
        if quest_updates:
            result += f"\n{quest_updates}\n"
        
        self.current_monster = None
        return result
    
    def _update_quests(self, monster_type):
        if not self.player.quests:
            return ""
        
        completed_quests = []
        for quest_name in self.player.quests[:]:
            quest = self.quests.get(quest_name)
            if quest and quest["target"] == monster_type:
                # 这里简化处理，实际应该有任务进度跟踪
                if random.random() < 0.3:  # 30%几率完成任务
                    completed_quests.append(quest_name)
        
        if completed_quests:
            for quest_name in completed_quests:
                self.player.quests.remove(quest_name)
                quest = self.quests[quest_name]
                self.player.gain_exp(quest["reward_exp"])
                self.player.gold += quest["reward_gold"]
            
            return f"完成任务: {', '.join(completed_quests)}！"
        
        return ""
    
    def show_shop(self):
        if not self.game_running or not self.player:
            return "游戏未开始。"
        
        location = self.player.location
        if not self.locations.get(location, {}).get('shop_available', False):
            return f"{location} 没有商店。"
        
        output = "🏪 商店商品:\n"
        for item_name, item_info in self.shop_items.items():
            output += f"{item_name}: {item_info['price']}金币 - {item_info['effect']}\n"
        
        output += f"\n你的金币: {self.player.gold}"
        return output
    
    def buy_item(self, item_name):
        if not self.game_running or not self.player:
            return "游戏未开始。"
        
        if item_name not in self.shop_items:
            return f"商店没有 '{item_name}'。"
        
        item_info = self.shop_items[item_name]
        price = item_info["price"]
        
        if self.player.gold < price:
            return f"金币不足！需要 {price} 金币，你只有 {self.player.gold} 金币。"
        
        self.player.gold -= price
        
        # 添加到背包
        item_type = item_info["type"]
        if item_type == "potion":
            self.player.inventory["potions"].append(item_name)
        elif item_type == "weapon":
            self.player.inventory["weapons"].append(item_name)
        elif item_type == "armor":
            self.player.inventory["armor"].append(item_name)
        else:
            self.player.inventory["misc"].append(item_name)
        
        # 应用效果（简化版）
        if "攻击力" in item_info["effect"]:
            self.player.strength += 5
        elif "防御力" in item_info["effect"]:
            self.player.defense += 3
        elif "智力" in item_info["effect"]:
            self.player.intelligence += 5
        
        return f"购买了 {item_name}！消耗 {price} 金币。\n剩余金币: {self.player.gold}"
    
    def show_quests(self):
        if not self.game_running or not self.player:
            return "游戏未开始。"
        
        location = self.player.location
        if not self.locations.get(location, {}).get('quest_giver', False):
            return f"{location} 没有任务发布者。"
        
        output = "📜 可用任务:\n"
        for quest_name, quest_info in self.quests.items():
            if quest_name not in self.player.quests:
                output += f"{quest_name}: {quest_info['description']}\n"
                output += f"   奖励: {quest_info['reward_exp']}经验, {quest_info['reward_gold']}金币\n"
                output += f"   地点: {quest_info['location']}\n"
        
        output += "\n进行中的任务:\n"
        if self.player.quests:
            for quest_name in self.player.quests:
                quest_info = self.quests.get(quest_name, {})
                output += f"{quest_name}: {quest_info.get('description', '未知任务')}\n"
        else:
            output += "无\n"
        
        return output
    
    def accept_quest(self, quest_name):
        if not self.game_running or not self.player:
            return "游戏未开始。"
        
        if quest_name not in self.quests:
            return f"任务 '{quest_name}' 不存在。"
        
        if quest_name in self.player.quests:
            return f"你已经接受了任务 '{quest_name}'。"
        
        self.player.quests.append(quest_name)
        quest_info = self.quests[quest_name]
        return f"接受了任务: {quest_name}\n{quest_info['description']}\n前往 {quest_info['location']} 完成任务。"
    
    def rest(self):
        if not self.game_running or not self.player:
            return "游戏未开始。"
        
        location = self.player.location
        if location not in ["新手村", "城镇"]:
            return f"在 {location} 无法休息。"
        
        # 恢复生命和魔力
        hp_restored = self.player.heal(self.player.max_hp)
        mp_restored = self.player.restore_mp(self.player.max_mp)
        
        # 消耗一些金币
        cost = 10
        if self.player.gold >= cost:
            self.player.gold -= cost
            return f"你在旅店休息了一晚。\n恢复 {hp_restored} HP | 恢复 {mp_restored} MP\n花费 {cost} 金币。剩余金币: {self.player.gold}"
        else:
            return f"休息需要 {cost} 金币，但你只有 {self.player.gold} 金币。"
    
    def show_help(self):
        help_text = """
=== 游戏命令帮助 ===

基础命令:
  状态 - 显示角色状态
  探索 - 在当前地点探索
  移动 [地点] - 移动到指定地点
  技能 - 显示可用技能
  使用 [技能名] - 使用技能（战斗中）
  背包 - 显示背包物品
  休息 - 在安全地点恢复生命和魔力

战斗命令:
  战斗 - 开始与遭遇的怪物战斗
  逃跑 - 尝试从战斗中逃跑（50%成功率）

任务系统:
  任务 - 查看可用任务
  接受 [任务名] - 接受任务
  商店 - 查看商店商品
  购买 [物品名] - 购买物品

游戏管理:
  保存 - 保存游戏进度
  加载 - 加载游戏进度
  帮助 - 显示此帮助信息
  退出 - 退出游戏

可用地点: 新手村, 森林, 墓地, 洞穴, 城镇
        """
        return help_text
    
    def run_away(self):
        if not self.current_monster:
            return "没有战斗可以逃跑。"
        
        if random.random() < 0.5:  # 50%逃跑成功率
            self.current_monster = None
            return "你成功逃跑了！"
        else:
            # 逃跑失败，受到怪物攻击
            monster_damage = self.current_monster.attack_player(self.player.defense)
            self.player.take_damage(monster_damage)
            
            result = f"逃跑失败！{self.current_monster.name} 对你造成了 {monster_damage} 点伤害！\n"
            
            if self.player.hp <= 0:
                result += "\n💀 你被击败了！游戏结束。"
                self.game_running = False
            
            return result

if __name__ == "__main__":
    # 测试代码
    game = GameEngine()
    print(game.start_new_game("测试玩家"))
    print(game.show_status())
    print(game.explore())
