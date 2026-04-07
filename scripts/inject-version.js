/**
 * 构建时注入版本号：从 Git tag 提取版本，写入 package.json、前端和 API
 * 
 * 使用方式：
 *   node scripts/inject-version.js           # 自动从 git tag 读取
 *   node scripts/inject-version.js 0.1.2     # 手动指定版本
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');

// 获取版本号：命令行参数 > Git tag > package.json
let version;
if (process.argv[2]) {
  version = process.argv[2];
} else {
  try {
    // 优先从环境变量 GITHUB_REF 取（CI 环境）
    const ref = process.env.GITHUB_REF || '';
    const tagMatch = ref.match(/refs\/tags\/v?([\d.]+)/);
    if (tagMatch) {
      version = tagMatch[1];
    } else {
      // 回退：从本地 git tag 取最新
      const localTag = execSync('git describe --tags --abbrev=0', { cwd: rootDir })
        .toString().trim().replace(/^v/, '');
      version = localTag || require(path.join(rootDir, 'package.json')).version;
    }
  } catch {
    version = require(path.join(rootDir, 'package.json')).version;
  }
}

console.log(`Injecting version: ${version}`);

// 1. 更新 package.json
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('✓ Updated package.json');

// 2. 更新 dashboard/index.html
const htmlPath = path.join(rootDir, 'dashboard', 'index.html');
if (fs.existsSync(htmlPath)) {
  let html = fs.readFileSync(htmlPath, 'utf-8');
  html = html.replace(/sidebar-brand-ver">v[\d.]+</, `sidebar-brand-ver">v${version}<`);
  fs.writeFileSync(htmlPath, html);
  console.log('✓ Updated dashboard/index.html');
}

// 3. 更新 src/dashboard/routes/api.ts
const apiPath = path.join(rootDir, 'src', 'dashboard', 'routes', 'api.ts');
if (fs.existsSync(apiPath)) {
  let api = fs.readFileSync(apiPath, 'utf-8');
  api = api.replace(/version:\s*'[\d.]+'/, `version: '${version}'`);
  fs.writeFileSync(apiPath, api);
  console.log('✓ Updated src/dashboard/routes/api.ts');
}

console.log('Version injection complete.');
