import json
import random
from datetime import datetime

class Player:
    def __init__(self, name="冒险者"):
        self.name = name
        self.level = 1
        self.exp = 0
        self.exp_to_next_level = 100
        self.hp = 100
        self.max_hp = 100
        self.mp = 50
        self.max_mp = 50
        self.strength = 10
        self.agility = 10
        self.intelligence = 10
        self.defense = 5
        self.gold = 50
        self.inventory = {
            "weapons": ["木剑"],
            "armor": ["布衣"],
            "potions": ["小治疗药水 x3"],
            "misc": []
        }
        self.skills = ["基础攻击"]
        self.location = "新手村"
        self.quests = []
        self.created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
    def level_up(self):
        self.level += 1
        self.exp -= self.exp_to_next_level
        self.exp_to_next_level = int(self.exp_to_next_level * 1.5)
        
        # 属性提升
        self.max_hp += 20
        self.hp = self.max_hp
        self.max_mp += 10
        self.mp = self.max_mp
        self.strength += 3
        self.agility += 2
        self.intelligence += 2
        self.defense += 2
        
        # 随机获得新技能
        new_skills = ["强力斩", "快速连击", "魔法弹", "治疗术", "防御姿态"]
        if len(self.skills) < 5:
            new_skill = random.choice(new_skills)
            if new_skill not in self.skills:
                self.skills.append(new_skill)
        
        return f"恭喜！{self.name} 升级到 {self.level} 级！"
    
    def gain_exp(self, amount):
        self.exp += amount
        if self.exp >= self.exp_to_next_level:
            return self.level_up()
        return f"获得 {amount} 经验值"
    
    def take_damage(self, damage):
        actual_damage = max(1, damage - self.defense)
        self.hp -= actual_damage
        if self.hp < 0:
            self.hp = 0
        return actual_damage
    
    def heal(self, amount):
        self.hp = min(self.max_hp, self.hp + amount)
        return amount
    
    def use_mp(self, amount):
        if self.mp >= amount:
            self.mp -= amount
            return True
        return False
    
    def restore_mp(self, amount):
        self.mp = min(self.max_mp, self.mp + amount)
        return amount
    
    def get_status(self):
        return {
            "name": self.name,
            "level": self.level,
            "exp": f"{self.exp}/{self.exp_to_next_level}",
            "hp": f"{self.hp}/{self.max_hp}",
            "mp": f"{self.mp}/{self.max_mp}",
            "stats": {
                "力量": self.strength,
                "敏捷": self.agility,
                "智力": self.intelligence,
                "防御": self.defense
            },
            "gold": self.gold,
            "location": self.location,
            "skills": self.skills,
            "inventory": self.inventory,
            "quests": len(self.quests)
        }
    
    def save_game(self, filename="save_game.json"):
        data = {
            "player": {
                "name": self.name,
                "level": self.level,
                "exp": self.exp,
                "exp_to_next_level": self.exp_to_next_level,
                "hp": self.hp,
                "max_hp": self.max_hp,
                "mp": self.mp,
                "max_mp": self.max_mp,
                "strength": self.strength,
                "agility": self.agility,
                "intelligence": self.intelligence,
                "defense": self.defense,
                "gold": self.gold,
                "inventory": self.inventory,
                "skills": self.skills,
                "location": self.location,
                "quests": self.quests,
                "created_at": self.created_at,
                "last_saved": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            }
        }
        
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        
        return f"游戏已保存到 {filename}"
    
    @classmethod
    def load_game(cls, filename="save_game.json"):
        try:
            with open(filename, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            player_data = data["player"]
            player = cls(player_data["name"])
            
            for key, value in player_data.items():
                if hasattr(player, key):
                    setattr(player, key, value)
            
            return player
        except FileNotFoundError:
            return None
        except Exception as e:
            print(f"加载游戏失败: {e}")
            return None
    
    def __str__(self):
        status = self.get_status()
        output = f"=== {status['name']} 的状态 ===\n"
        output += f"等级: {status['level']} | 经验: {status['exp']}\n"
        output += f"生命: {status['hp']} | 魔力: {status['mp']}\n"
        output += f"位置: {status['location']} | 金币: {status['gold']}\n"
        output += f"技能: {', '.join(status['skills'])}\n"
        output += f"任务: {status['quests']} 个进行中\n"
        return output

if __name__ == "__main__":
    # 测试代码
    player = Player("测试角色")
    print(player)
    print(player.gain_exp(50))
    print(player.gain_exp(60))  # 应该升级
    print(player)
