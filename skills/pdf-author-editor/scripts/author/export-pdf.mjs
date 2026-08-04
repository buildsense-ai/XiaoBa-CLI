#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import Module from 'node:module';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) usage('Missing input HTML file.');

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) usage(`Input HTML file not found: ${inputPath}`);

  const outPath = path.resolve(args.out || inputPath.replace(/\.html?$/i, '.pdf'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const { chromium } = loadPlaywright();
  const browser = await launchChromium(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(inputPath).href, { waitUntil: 'networkidle' });
    await waitForRenderReady(page);
    const deliveryType = await page.evaluate(() => document.documentElement.dataset.deliveryType || '');
    if (deliveryType === 'slides') {
      await page.setViewportSize({ width: 1600, height: 900 });
    }
    await page.addStyleTag({
      content: '*,*::before,*::after{animation:none!important;transition:none!important;}'
    });
    await page.pdf({
      path: outPath,
      printBackground: true,
      preferCSSPageSize: true
    });
    if (args.screenshot) {
      const screenshotPath = path.resolve(args.screenshot);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: deliveryType !== 'slides' });
    }
    console.log(JSON.stringify({
      ok: true,
      input: inputPath,
      output: outPath,
      screenshot: args.screenshot ? path.resolve(args.screenshot) : undefined,
      delivery_type: deliveryType || undefined
    }, null, 2));
  } finally {
    await browser.close();
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--out' || item === '-o') args.out = argv[++i];
    else if (item === '--screenshot') args.screenshot = argv[++i];
    else if (item === '--help' || item === '-h') usage('', 0);
    else if (!args.input) args.input = item;
    else usage(`Unknown argument: ${item}`);
  }
  return args;
}

function usage(message, code = 1) {
  if (message) console.error(message);
  console.error('Usage: node export-pdf.mjs <input.html> [--out output.pdf] [--screenshot preview.png]');
  process.exit(code);
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  extendNodePath();
  try {
    return require('playwright');
  } catch (error) {
    const hint = [
      'Playwright could not be resolved.',
      'Install playwright in the runtime, or set NODE_PATH to include:',
      '  <xiaoba-app>/resources/node_modules',
      '  <runtime>/node/node_modules',
      '  <dependencies>/node/node_modules',
      'or set PDF_AUTHOR_EDITOR_NODE_MODULES / XIAOBA_NODE_MODULES.',
      `Original error: ${error.message}`
    ].join('\n');
    throw new Error(hint);
  }
}

async function launchChromium(chromium) {
  const executablePath = findChromiumExecutable();
  if (executablePath) {
    return chromium.launch({ headless: true, executablePath });
  }
  return chromium.launch({ headless: true });
}

function findChromiumExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate));
}

function extendNodePath() {
  const execDir = path.dirname(process.execPath);
  const parentDir = path.resolve(execDir, '..');
  const runtimeRoot = path.basename(execDir).toLowerCase() === 'node'
    ? parentDir
    : path.resolve(execDir, '..', '..');
  const appRoot = path.resolve(runtimeRoot, '..');
  const candidates = [
    process.env.PDF_AUTHOR_EDITOR_NODE_MODULES,
    process.env.XIAOBA_NODE_MODULES,
    process.env.CATSCO_NODE_MODULES,
    path.join(execDir, 'node_modules'),
    path.join(parentDir, 'node_modules'),
    path.join(parentDir, 'node_modules', '.pnpm', 'node_modules'),
    path.join(runtimeRoot, 'node', 'node_modules'),
    path.join(runtimeRoot, 'node', 'node_modules', '.pnpm', 'node_modules'),
    path.join(appRoot, 'resources', 'node_modules'),
    path.join(appRoot, 'resources', 'app', 'node_modules'),
    path.join(process.cwd(), 'node_modules')
  ];
  const existing = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
  process.env.NODE_PATH = [...existing, ...candidates]
    .filter(candidate => candidate && fs.existsSync(candidate))
    .join(path.delimiter);
  Module._initPaths();
}

async function waitForRenderReady(page) {
  try {
    await page.waitForFunction(() => window.__RENDER_READY__ === true, null, { timeout: 5000 });
  } catch (_) {
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  }
  await page.evaluate(() => document.fonts && document.fonts.ready ? document.fonts.ready : true).catch(() => {});
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
