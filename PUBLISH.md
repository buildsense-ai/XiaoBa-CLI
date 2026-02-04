# GitHub 发布清单

## 发布前检查

### 1. 代码清理
- [x] .gitignore 已配置
- [x] .env.example 已创建
- [x] 确保 .env 不会被提交（已在 .gitignore 中）

### 2. 文档完善
- [x] README.md 更新
- [x] DEPLOY.md 部署文档
- [ ] LICENSE 文件（建议添加 MIT）
- [ ] CHANGELOG.md（可选）

### 3. 代码质量
- [ ] 运行构建确保无错误：`npm run build`
- [ ] 测试基本功能：`npm run dev`
- [ ] 检查代码风格（可选）

### 4. 安全检查
- [ ] 确认 .env 文件不在仓库中
- [ ] 确认没有硬编码的 API 密钥
- [ ] 检查敏感信息（IP、密码等）

### 5. 信息更新
- [ ] package.json 中的 author 信息
- [ ] package.json 中的 repository 信息
- [ ] README.md 中的 GitHub 链接
- [ ] DEPLOY.md 中的联系方式

## 发布步骤

### 初始化 Git 仓库（如果还没有）

```bash
git init
git add .
git commit -m "Initial commit: XiaoBa CLI v0.1.0"
```

### 在 GitHub 创建仓库

1. 访问 https://github.com/new
2. 创建名为 `XiaoBa` 的新仓库
3. 不要初始化 README（我们已经有了）

### 推送到 GitHub

```bash
git remote add origin https://github.com/你的用户名/XiaoBa.git
git branch -M main
git push -u origin main
```

### 创建首个 Release（可选）

1. 在 GitHub 仓库页面，点击 "Releases"
2. 点击 "Create a new release"
3. Tag version: `v0.1.0`
4. Release title: `XiaoBa v0.1.0 - 首次发布`
5. 描述发布内容
6. 点击 "Publish release"

## 发布后

### 1. 更新 package.json

添加仓库信息：

```json
{
  "repository": {
    "type": "git",
    "url": "https://github.com/你的用户名/XiaoBa.git"
  },
  "bugs": {
    "url": "https://github.com/你的用户名/XiaoBa/issues"
  },
  "homepage": "https://github.com/你的用户名/XiaoBa#readme"
}
```

### 2. 添加徽章

在 README.md 中添加更多徽章：

```markdown
[![GitHub stars](https://img.shields.io/github/stars/你的用户名/XiaoBa?style=social)](https://github.com/你的用户名/XiaoBa)
[![GitHub issues](https://img.shields.io/github/issues/你的用户名/XiaoBa)](https://github.com/你的用户名/XiaoBa/issues)
```

### 3. 发布到 npm（可选）

如果想让用户通过 `npm install -g xiaoba-cli` 安装：

```bash
npm login
npm publish
```

注意：需要先在 https://www.npmjs.com/ 注册账号。

### 4. 宣传推广

- 在社交媒体分享
- 提交到 GitHub Trending
- 在相关社区发布

## 常用 Git 命令

```bash
# 查看状态
git status

# 添加所有更改
git add .

# 提交更改
git commit -m "描述信息"

# 推送到 GitHub
git push

# 拉取最新代码
git pull

# 查看提交历史
git log --oneline
```

## 注意事项

⚠️ **发布前务必检查：**
1. .env 文件是否在 .gitignore 中
2. 代码中是否有硬编码的密钥
3. 敏感信息（IP、密码）是否已移除
4. README 中的示例配置是否使用占位符

✅ **发布后记得：**
1. 更新 README 中的 GitHub 链接
2. 在项目设置中添加描述和标签
3. 启用 Issues 和 Discussions
4. 添加 Contributors 指南
