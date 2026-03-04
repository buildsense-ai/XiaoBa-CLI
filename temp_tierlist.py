from PIL import Image, ImageDraw, ImageFont
import os

# 创建图片
width = 1200
height = 800
img = Image.new('RGB', (width, height), color='white')
draw = ImageDraw.Draw(img)

# 尝试加载中文字体
try:
    font_title = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 32)
    font_tier = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 28)
    font_item = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 20)
except:
    font_title = ImageFont.load_default()
    font_tier = ImageFont.load_default()
    font_item = ImageFont.load_default()

# 标题
draw.text((width//2, 30), "XiaoBa Skills 从夯到拉", fill='black', font=font_title, anchor='mm')

# 定义层级和内容
tiers = {
    "夯": ["paper-analysis", "pr-codereview", "excalidraw"],
    "顶级": ["paper-review", "literature-review", "sci-paper-writing", "experiment-design", "hang-to-la-rating"],
    "人上人": ["critical-reading", "agent-browser", "research-orchestrator", "paper-to-ppt", "self-evolution"],
    "NPC": ["xhs-vibe-write", "cad-supervision"]
}

colors = {
    "夯": (255, 100, 100),
    "顶级": (255, 200, 100),
    "人上人": (255, 255, 150),
    "NPC": (200, 200, 200)
}

y = 100
for tier, items in tiers.items():
    # 绘制层级标签
    draw.rectangle([20, y, 150, y+80], fill=colors[tier], outline='black', width=2)
    draw.text((85, y+40), tier, fill='black', font=font_tier, anchor='mm')
    
    # 绘制项目
    x = 180
    for item in items:
        item_width = len(item) * 12 + 20
        draw.rectangle([x, y+10, x+item_width, y+70], fill=(100, 150, 200), outline='black', width=1)
        draw.text((x+item_width//2, y+40), item, fill='white', font=font_item, anchor='mm')
        x += item_width + 15
    
    y += 120

img.save('xiaoba_skills_tierlist.png')
print('{"file_path": "xiaoba_skills_tierlist.png", "file_name": "XiaoBa_Skills从夯到拉.png"}')
