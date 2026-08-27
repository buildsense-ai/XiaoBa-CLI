// Electron子进程：启动dashboard HTTP server
const path = require('path');

// 设置工作目录为项目根目录
process.chdir(path.join(__dirname, '..'));

// 加载dotenv
require('dotenv').config({ path: path.join(process.cwd(), '.env'), quiet: true });

const { startDashboard } = require('../dist/dashboard/server');

const port = parseInt(process.env.DASHBOARD_PORT || '3800', 10);

startDashboard(port).then((handle) => {
  // 通知主进程server已就绪
  if (process.send) {
    process.send('ready');
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await handle.stop();
      process.exit(0);
    } catch (error) {
      console.error('Failed to stop dashboard server:', error);
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}).catch((error) => {
  console.error('Failed to start dashboard server:', error);
  process.exit(1);
});
