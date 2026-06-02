import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const electronMain = readFileSync(join(process.cwd(), 'electron/main.js'), 'utf-8');

test('electron opens the local dashboard through stable IPv4 loopback', () => {
  assert.match(electronMain, /mainWindow\.loadURL\(`http:\/\/127\.0\.0\.1:\$\{DASHBOARD_PORT\}`\)/);
  assert.doesNotMatch(electronMain, /mainWindow\.loadURL\(`http:\/\/localhost:\$\{DASHBOARD_PORT\}`\)/);
});

test('electron uses Chinese menus with close-to-tray control', () => {
  assert.match(electronMain, /function createApplicationMenu\(\)/);
  assert.match(electronMain, /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(template\)\)/);
  assert.match(electronMain, /label: '文件'/);
  assert.match(electronMain, /label: '编辑'/);
  assert.match(electronMain, /label: '视图'/);
  assert.match(electronMain, /label: '窗口'/);
  assert.match(electronMain, /label: '帮助'/);
  assert.match(electronMain, /label: '点 × 后隐藏到后台'/);
  assert.match(electronMain, /type: 'checkbox'/);
  assert.match(electronMain, /writeCloseToTrayPreference\(menuItem\.checked\)/);
  assert.doesNotMatch(electronMain, /label: 'File'/);
  assert.doesNotMatch(electronMain, /label: 'Edit'/);
  assert.doesNotMatch(electronMain, /label: 'View'/);
  assert.doesNotMatch(electronMain, /label: 'Window'/);
  assert.doesNotMatch(electronMain, /label: 'Help'/);
});

test('electron changes cwd to userData before reading close-to-tray menu preference', () => {
  const chdirIndex = electronMain.indexOf('process.chdir(userDataPath)');
  const menuCallIndex = electronMain.indexOf('createApplicationMenu();');

  assert.notEqual(chdirIndex, -1);
  assert.notEqual(menuCallIndex, -1);
  assert.equal(chdirIndex < menuCallIndex, true);
  assert.match(electronMain, /close-to-tray preferences are read from process\.cwd\(\)\/\.xiaoba\/catsco\.json/);
});

test('electron tray uses app icons and notifies after background hide', () => {
  assert.match(electronMain, /function createTrayIcon\(\)/);
  assert.match(electronMain, /build-resources\/icon\.ico/);
  assert.match(electronMain, /new Tray\(createTrayIcon\(\)\)/);
  assert.match(electronMain, /function notifyWindowHidden\(\)/);
  assert.match(electronMain, /tray\.displayBalloon/);
  assert.match(electronMain, /CatsCo 已在后台运行/);
  assert.match(electronMain, /notifyWindowHidden\(\)/);
});
