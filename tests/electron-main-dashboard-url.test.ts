import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const electronMain = readFileSync(join(process.cwd(), 'electron/main.js'), 'utf-8');

test('electron opens the local dashboard through stable IPv4 loopback', () => {
  assert.match(electronMain, /mainWindow\.loadURL\(`http:\/\/127\.0\.0\.1:\$\{DASHBOARD_PORT\}`\)/);
  assert.doesNotMatch(electronMain, /mainWindow\.loadURL\(`http:\/\/localhost:\$\{DASHBOARD_PORT\}`\)/);
});
