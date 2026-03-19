import express from 'express';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { createApiRouter } from './routes/api';
import { ServiceManager } from './service-manager';

const DEFAULT_PORT = 3800;

export async function startDashboard(port: number = DEFAULT_PORT): Promise<void> {
  const app = express();
  const projectRoot = process.cwd();
  const serviceManager = new ServiceManager(projectRoot);

  app.use(express.json());

  // API routes
  app.use('/api', createApiRouter(serviceManager));

  // Serve frontend
  const frontendPath = path.join(__dirname, '../../dashboard');
  app.use(express.static(frontendPath));

  // SPA fallback
  app.use((_req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  // 优雅退出
  process.on('SIGINT', () => {
    serviceManager.stopAll();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    serviceManager.stopAll();
    process.exit(0);
  });

  app.listen(port, () => {
    Logger.success(`\nXiaoBa Dashboard 已启动`);
    Logger.info(`打开浏览器访问: http://localhost:${port}\n`);
  });
}
