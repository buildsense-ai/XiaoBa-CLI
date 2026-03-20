// Electron子进程：启动dashboard HTTP server
const path = require('path');

// 设置工作目录为项目根目录
process.chdir(path.join(__dirname, '..'));

// 加载dotenv
require('dotenv').config({ path: path.join(process.cwd(), '.env'), quiet: true });

const { startDashboard } = require('../dist/dashboard/server');

const port = parseInt(process.env.DASHBOARD_PORT || '3800', 10);

startDashboard(port).then(() => {
  // 通知主进程server已就绪
  if (process.send) {
    process.send('ready');
  }
});
