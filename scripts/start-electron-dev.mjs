import { spawn } from 'node:child_process';
import fs from 'node:fs';
import electronPath from 'electron';
import { resolveElectronDevOptions } from './electron-dev-options.mjs';

const { env, port, userDataDir } = resolveElectronDevOptions();
fs.mkdirSync(userDataDir, { recursive: true });

console.log(`[dev] Dashboard port: ${port}`);
console.log(`[dev] User data: ${userDataDir}`);

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
