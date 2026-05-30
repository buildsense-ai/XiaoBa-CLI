import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const dashboardHtml = readFileSync(join(process.cwd(), 'dashboard/index.html'), 'utf-8');
const desktopPetHtml = readFileSync(join(process.cwd(), 'dashboard/desktop-pet.html'), 'utf-8');
const electronMain = readFileSync(join(process.cwd(), 'electron/main.js'), 'utf-8');
const electronPreload = readFileSync(join(process.cwd(), 'electron/preload.js'), 'utf-8');

test('dashboard companion panel exposes clone minimize and desktop pet controls', () => {
  assert.match(dashboardHtml, /id="companion-desktop-actions"/);
  assert.match(dashboardHtml, /桌面陪伴/);
  assert.match(dashboardHtml, /onclick="enterDesktopPetMode\(\)"/);
  assert.match(dashboardHtml, /onclick="minimizeDashboardToTray\(\)"/);
  assert.match(dashboardHtml, /onclick="openFocusDesktopConfirm\(\)"/);
  assert.match(dashboardHtml, /function enterDesktopPetMode\(\)/);
  assert.match(dashboardHtml, /function minimizeDashboardToTray\(\)/);
  assert.doesNotMatch(dashboardHtml, /贴边休息/);
});

test('desktop pet page is a free desktop companion instead of an edge tab', () => {
  assert.match(desktopPetHtml, /id="desktop-pet"/);
  assert.match(desktopPetHtml, /我在桌面陪你/);
  assert.match(desktopPetHtml, /window\.catscoDesktop\?\.showDashboard/);
  assert.match(desktopPetHtml, /window\.catscoDesktop\?\.moveDesktopPet/);
  assert.match(desktopPetHtml, /function startDesktopPetDrag\(/);
  assert.match(desktopPetHtml, /function moveDesktopPetDrag\(/);
  assert.match(desktopPetHtml, /function endDesktopPetDrag\(/);
  assert.match(desktopPetHtml, /pet\/idle\/01\.png/);
  assert.doesNotMatch(desktopPetHtml, /拉我回来|edge-tab|writing-mode/);
});

test('dashboard asks before showing desktop', () => {
  assert.match(dashboardHtml, /id="focus-desktop-modal"/);
  assert.match(dashboardHtml, /进入专注清桌面/);
  assert.match(dashboardHtml, /不会关闭程序或改动文件/);
  assert.match(dashboardHtml, /function openFocusDesktopConfirm\(\)/);
  assert.match(dashboardHtml, /function confirmFocusDesktop\(\)/);
  assert.match(dashboardHtml, /window\.catscoDesktop\.showDesktop/);
});

test('Electron exposes only companion desktop control IPC channels', () => {
  assert.match(electronMain, /ipcMain\.handle\('catsco:minimize-to-tray'/);
  assert.match(electronMain, /ipcMain\.handle\('catsco:enter-desktop-mode'/);
  assert.match(electronMain, /ipcMain\.handle\('catsco:show-dashboard'/);
  assert.match(electronMain, /ipcMain\.handle\('catsco:show-desktop'/);
  assert.match(electronMain, /ipcMain\.handle\('catsco:move-desktop-pet'/);
  assert.match(electronMain, /resolveDraggedDesktopPetBounds/);
  assert.match(electronMain, /createDesktopPetWindow\(\)/);
  assert.match(electronMain, /desktop-pet\.html/);
  assert.match(electronMain, /runDesktopAction\('minimize-all'\)/);
  assert.doesNotMatch(electronMain, /ipcMain\.handle\('catsco:run-command'/);

  assert.match(electronPreload, /minimizeToTray: \(\) => ipcRenderer\.invoke\('catsco:minimize-to-tray'\)/);
  assert.match(electronPreload, /enterDesktopMode: \(\) => ipcRenderer\.invoke\('catsco:enter-desktop-mode'\)/);
  assert.match(electronPreload, /moveDesktopPet: \(deltaX, deltaY\) => ipcRenderer\.invoke\('catsco:move-desktop-pet', \{ deltaX, deltaY \}\)/);
  assert.match(electronPreload, /showDashboard: \(\) => ipcRenderer\.invoke\('catsco:show-dashboard'\)/);
  assert.match(electronPreload, /showDesktop: \(\) => ipcRenderer\.invoke\('catsco:show-desktop'\)/);
});
