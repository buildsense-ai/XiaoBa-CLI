---
name: skill-publish
description: "发布 Skill 到官方 Skill Hub：创建独立仓库并注册到 registry，让所有 CatsCo 用户都能安装。"
invocable: user
autoInvocable: false
argument-hint: "<skill名称>"
---

# Skill Publish

将本地 skill 发布到 CatsCo 官方 Skill Hub（当前仓库名仍为 XiaoBa-Skill-Hub），供所有用户安装使用。

## 发布流程

1. **创建独立仓库** - 在 GitHub 创建 `xiaoba-skill-<name>` 仓库
2. **上传 skill 文件** - 将 skill 目录内容推送到新仓库
3. **注册到 Hub** - 往 XiaoBa-Skill-Hub 的 registry.json 提交 PR

## 执行步骤

### Step 1：确认要发布的 skill

用户提供 skill 名称，提取信息：

```bash
cat ~/Documents/xiaoba/skills/<name>/SKILL.md | head -10
```

检查必需字段：name、description、category
如果缺少 category，提示用户选择：核心、工具、效率、科研、运维、其他

### Step 2：创建 GitHub 仓库

告诉用户执行以下操作：

1. 打开 https://github.com/new
2. Repository name 填写：`xiaoba-skill-<name>`
3. 选择 Private 或 Public（建议 Public）
4. **不要勾选** "Add a README file"
5. 点击 Create repository

完成后提供仓库地址，格式：`https://github.com/YOUR_USER/xiaoba-skill-<name>`

### Step 3：上传 skill 文件

获取 GitHub 用户名并 clone 空仓库：

```bash
git config user.name
```

```bash
mkdir -p /tmp/xiaoba-publish && cd /tmp/xiaoba-publish && rm -rf xiaoba-skill-<name> && git clone https://github.com/<user>/xiaoba-skill-<name>.git
```

复制 skill 文件到仓库：

```bash
cd /tmp/xiaoba-publish && cp -r ~/Documents/xiaoba/skills/<name>/* xiaoba-skill-<name>/ && ls -la xiaoba-skill-<name>/
```

提交并推送：

```bash
cd /tmp/xiaoba-publish/xiaoba-skill-<name> && git add -A && git commit -m "Initial commit: <name> skill" && git push -u origin main
```

### Step 4：注册到 Skill Hub

告知用户需要提交 PR 到 XiaoBa-Skill-Hub：

1. 打开 https://github.com/buildsense-ai/XiaoBa-Skill-Hub
2. 点击右上角 **Fork**
3. Fork 完成后告知你 fork 地址

获取 fork 并更新 registry：

```bash
cd /tmp/xiaoba-publish && rm -rf XiaoBa-Skill-Hub && git clone https://github.com/<user>/XiaoBa-Skill-Hub.git
```

```bash
cd /tmp/xiaoba-publish/XiaoBa-Skill-Hub && python3 -c "
import json
d = json.load(open('registry.json'))
# 检查是否已存在
if any(e['name'] == '<name>' for e in d):
    print('Skill already exists in registry')
else:
    d.append({
        'name': '<name>',
        'description': '<description>',
        'category': '<category>',
        'recommended': False,
        'repo': 'https://github.com/<user>/xiaoba-skill-<name>'
    })
    json.dump(d, open('registry.json', 'w'), indent=2, ensure_ascii=False)
    print('registry.json updated')
"
```

提交 PR：

```bash
cd /tmp/xiaoba-publish/XiaoBa-Skill-Hub && git add registry.json && git commit -m "Add skill: <name>" && git push origin main
```

告诉用户去 GitHub 创建 PR：
1. 打开 https://github.com/YOUR_USER/XiaoBa-Skill-Hub
2. 点击 **Compare & pull request**
3. 提交后等待审核

### Step 5：清理

```bash
rm -rf /tmp/xiaoba-publish
```

## 完整流程总结

```
用户创建仓库 → 上传文件 → Fork Hub → 更新 registry → 提交 PR
```

## 注意事项

- **SSH Key**：确保本地配置了 SSH key 或使用 HTTPS + token
- **仓库命名**：必须是 `xiaoba-skill-<name>` 格式
- **skill 内容**：确保 SKILL.md 在仓库根目录
- **PR 审核**：提交后需要 CatsCo 维护者审核合入
