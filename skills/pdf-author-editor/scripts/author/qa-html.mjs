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
  const outPath = args.out ? path.resolve(args.out) : inputPath.replace(/\.html?$/i, '.html-qa.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const { chromium } = loadPlaywright();
  const consoleErrors = [];
  const failedRequests = [];
  const browser = await launchChromium(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', request => {
      failedRequests.push({
        url: request.url(),
        failure: request.failure()?.errorText || 'requestfailed'
      });
    });
    await page.goto(pathToFileURL(inputPath).href, { waitUntil: 'networkidle' });
    await waitForRenderReady(page);
    const deliveryType = await page.evaluate(() => document.documentElement.dataset.deliveryType || '');
    if (deliveryType === 'slides') await page.setViewportSize({ width: 1600, height: 900 });
    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      const visible = Array.from(document.querySelectorAll('body *')).filter(el => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
      const overflowElements = visible.filter(el => {
        const style = getComputedStyle(el);
        const clippedX = style.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 2;
        const clippedY = style.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 2;
        const wide = el.getBoundingClientRect().right > window.innerWidth + 2;
        return clippedX || clippedY || wide;
      }).slice(0, 25).map(el => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          className: String(el.className || ''),
          text: String(el.textContent || '').trim().slice(0, 80),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          scrollWidth: el.scrollWidth,
          scrollHeight: el.scrollHeight,
          clientWidth: el.clientWidth,
          clientHeight: el.clientHeight
        };
      });
      const bodyText = String(body.innerText || '').trim();
      return {
        title: document.title,
        delivery_type: doc.dataset.deliveryType || '',
        body_text_length: bodyText.length,
        images: document.images.length,
        tables: document.querySelectorAll('table').length,
        slides: document.querySelectorAll('.slide').length,
        blank_body: bodyText.length === 0 && document.images.length === 0 && document.querySelectorAll('svg,canvas').length === 0,
        horizontal_overflow: doc.scrollWidth > window.innerWidth + 2,
        document_width: doc.scrollWidth,
        viewport_width: window.innerWidth,
        document_height: doc.scrollHeight,
        viewport_height: window.innerHeight,
        overflow_elements: overflowElements,
        remote_resources: Array.from(document.querySelectorAll('img[src],script[src],link[href],iframe[src]'))
          .map(el => el.getAttribute('src') || el.getAttribute('href') || '')
          .filter(url => /^https?:\/\//i.test(url))
      };
    });
    const errors = [];
    if (consoleErrors.length) errors.push('console_errors');
    if (failedRequests.length) errors.push('failed_requests');
    if (metrics.blank_body) errors.push('blank_body');
    if (metrics.horizontal_overflow) errors.push('horizontal_overflow');
    if (metrics.overflow_elements.length) errors.push('element_overflow');
    if (metrics.remote_resources.length) errors.push('remote_resources');
    if (args.expectType && metrics.delivery_type !== args.expectType) errors.push('delivery_type_mismatch');
    if (Number.isFinite(args.expectSlides) && metrics.slides !== args.expectSlides) errors.push('slide_count_mismatch');
    const result = {
      ok: errors.length === 0,
      input: inputPath,
      errors,
      console_errors: consoleErrors,
      failed_requests: failedRequests,
      metrics
    };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: result.ok, output: outPath, errors }, null, 2));
    if (!result.ok) process.exit(1);
  } finally {
    await browser.close();
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--out' || item === '-o') args.out = argv[++i];
    else if (item === '--expect-type') args.expectType = argv[++i];
    else if (item === '--expect-slides') args.expectSlides = Number(argv[++i]);
    else if (item === '--help' || item === '-h') usage('', 0);
    else if (!args.input) args.input = item;
    else usage(`Unknown argument: ${item}`);
  }
  return args;
}

function usage(message, code = 1) {
  if (message) console.error(message);
  console.error('Usage: node qa-html.mjs <input.html> [--out html-qa.json] [--expect-type report|one-pager|slides] [--expect-slides N]');
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
