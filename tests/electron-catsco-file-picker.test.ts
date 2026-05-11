import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const electronMain = readFileSync(join(process.cwd(), 'electron/main.js'), 'utf-8');
const electronPreload = readFileSync(join(process.cwd(), 'electron/preload.js'), 'utf-8');

test('Electron exposes a safe CatsCo file picker bridge', () => {
  assert.match(electronMain, /ipcMain\.handle\('catsco:select-files'/);
  assert.match(electronMain, /dialog\.showOpenDialog/);
  assert.match(electronMain, /function isTrustedDashboardUrl\(value\)/);
  assert.match(electronMain, /owner !== mainWindow \|\| !isTrustedDashboardUrl\(frameUrl\)/);
  assert.match(electronMain, /createLocalFileGrant/);
  assert.doesNotMatch(electronMain, /path:\s*filePath/);
  assert.match(electronMain, /preload: path\.join\(__dirname, 'preload\.js'\)/);
  assert.match(electronPreload, /contextBridge\.exposeInMainWorld\('catscoDesktop'/);
  assert.match(electronPreload, /selectFiles: \(\) => ipcRenderer\.invoke\('catsco:select-files'\)/);
});
