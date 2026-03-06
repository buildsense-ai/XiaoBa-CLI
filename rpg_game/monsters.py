import random

class Monster:
    def __init__(self, name, level, monster_type):
        self.name = name
        self.level = level
        self.type = monster_type
        self.hp = 20 + (level * 15)
        self.max_hp = self.hp
        self.attack = 5 + (level * 3)
        self.defense = 2 + (level * 2)
        self.exp_reward = 10 + (level * 8)
        self.gold_reward = random.randint(5, 15) + (level * 5)
        self.drops = []
        
        # 根据怪物类型调整属性
        if monster_type == "野兽":
            self.attack += 3
            self.hp += 10
        elif monster_type == "亡灵":
            self.defense += 2
            self.exp_reward += 5
        elif monster_type == "恶魔":
            self.attack += 5
            self.hp -= 5
        elif monster_type == "元素":
            self.defense += 3
            self.exp_reward += 3
        
        # 设置掉落物品
        self._set_drops()
    
    def _set_drops(self):
        common_drops = ["怪物牙齿", "怪物皮毛", "小魔核"]
        uncommon_drops = ["强化魔核", "稀有材料", "魔法碎片"]
        rare_drops = ["史诗材料", "技能书", "稀有装备"]
        
        # 基础掉落
        for _ in range(random.randint(1, 3)):
            self.drops.append(random.choice(common_drops))
        
        # 根据等级增加掉落
        if self.level >= 3:
            if random.random() < 0.4:
                self.drops.append(random.choice(uncommon_drops))
        
        if self.level >= 5:
            if random.random() < 0.2:
                self.drops.append(random.choice(rare_drops))
    
    def take_damage(self, damage):
        actual_damage = max(1, damage - self.defense)
        self.hp -= actual_damage
        if self.hp < 0:
            self.hp = 0
        return actual_damage
    
    def is_alive(self):
        return self.hp > 0
    
    def attack_player(self, player_defense):
        base_damage = self.attack
        # 随机波动
        damage = random.randint(int(base_damage * 0.8), int(base_damage * 1.2))
        actual_damage = max(1, damage - player_defense)
        return actual_damage
    
    def get_status(self):
        return {
            "name": self.name,
            "level": self.level,
            "type": self.type,
            "hp": f"{self.hp}/{self.max_hp}",
            "attack": self.attack,
            "defense": self.defense,
            "exp_reward": self.exp_reward,
            "gold_reward": self.gold_reward,
            "drops": self.drops
        }
    
    def __str__(self):
        status = self.get_status()
        hp_percent = (self.hp / self.max_hp) * 100
        
        if hp_percent > 70:
            hp_status = "健康"
        elif hp_percent > 40:
            hp_status = "受伤"
        elif hp_percent > 10:
            hp_status = "重伤"
        else:
            hp_status = "濒死"
        
        return f"{self.name} (Lv.{self.level} {self.type}) - {hp_status} [{self.hp}/{self.max_hp} HP]"

class MonsterFactory:
    @staticmethod
    def create_monster(player_level, location):
        # 根据玩家等级和位置生成适当难度的怪物
        base_level = max(1, player_level - 1)
        level_variation = random.randint(-1, 2)
        monster_level = max(1, base_level + level_variation)
        
        # 怪物类型池
        monster_types = ["野兽", "亡灵", "恶魔", "元素", "人形"]
        
        # 根据位置调整怪物类型
        if location == "森林":
            type_weights = {"野兽": 0.5, "元素": 0.3, "人形": 0.2}
        elif location == "墓地":
            type_weights = {"亡灵": 0.6, "恶魔": 0.3, "野兽": 0.1}
        elif location == "洞穴":
            type_weights = {"恶魔": 0.4, "元素": 0.3, "野兽": 0.2, "亡灵": 0.1}
        else:
            type_weights = {t: 0.2 for t in monster_types}
        
        monster_type = random.choices(
            list(type_weights.keys()),
            weights=list(type_weights.values())
        )[0]
        
        # 怪物名称
        names_by_type = {
            "野兽": ["野狼", "巨熊", "毒蜘蛛", "剑齿虎", "狂暴野猪"],
            "亡灵": ["骷髅战士", "僵尸", "幽灵", "巫妖仆从", "死亡骑士"],
            "恶魔": ["小恶魔", "地狱犬", "魅魔", "深渊魔物", "炎魔"],
            "元素": ["火元素", "水元素", "土元素", "风元素", "雷元素"],
            "人形": ["强盗", "叛军士兵", "黑暗教徒", "雇佣兵", "刺客"]
        }
        
        name = random.choice(names_by_type.get(monster_type, ["未知怪物"]))
        
        return Monster(name, monster_level, monster_type)
    
    @staticmethod
    def create_boss(player_level):
        boss_level = player_level + 2
        boss_names = ["巨龙", "魔王", "远古巨兽", "深渊领主", "混沌之神"]
        boss_types = ["恶魔", "元素", "亡灵", "野兽", "神性"]
        
        name = random.choice(boss_names)
        monster_type = random.choice(boss_types)
        
        boss = Monster(name, boss_level, monster_type)
        # 强化BOSS
        boss.hp = int(boss.hp * 2.5)
        boss.max_hp = boss.hp
        boss.attack = int(boss.attack * 1.8)
        boss.defense = int(boss.defense * 1.5)
        boss.exp_reward = int(boss.exp_reward * 3)
        boss.gold_reward = int(boss.gold_reward * 5)
        
        # BOSS特殊掉落
        boss.drops.extend(["BOSS核心", "传奇装备碎片", "大量金币"])
        
        return boss

if __name__ == "__main__":
    # 测试代码
    factory = MonsterFactory()
    monster = factory.create_monster(3, "森林")
    print(monster)
    print("状态:", monster.get_status())
    
    boss = factory.create_boss(5)
    print("\nBOSS:", boss)
    print("BOSS状态:", boss.get_status())
