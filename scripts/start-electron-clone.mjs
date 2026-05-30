import { spawn } from 'node:child_process';
import path from 'node:path';
import electronPath from 'electron';

const env = {
  ...process.env,
  DASHBOARD_PORT: process.env.DASHBOARD_PORT || '3801',
  XIAOBA_DASHBOARD_EXTERNAL: process.env.XIAOBA_DASHBOARD_EXTERNAL || '1',
  XIAOBA_USER_DATA_DIR: process.env.XIAOBA_USER_DATA_DIR || path.join(process.cwd(), 'data', 'electron-clone-user-data'),
};
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
