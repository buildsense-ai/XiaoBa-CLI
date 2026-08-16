#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DELIVERY_TYPES = new Set(['report', 'one-pager', 'slides']);
const MIN_PDF_BYTES = 1024;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) usage('Missing input file.');

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) usage(`Input file not found: ${inputPath}`);

  const inputMeta = inspectInput(inputPath);
  const deliveryType = args.type || inputMeta.delivery_type || 'report';
  if (!DELIVERY_TYPES.has(deliveryType)) usage(`Invalid delivery type: ${deliveryType}`);
  const templateId = args.template || inputMeta.template || null;

  const baseName = safeBaseName(args.name || path.basename(inputPath, path.extname(inputPath)));
  const outDir = path.resolve(args.outDir || path.join(process.cwd(), 'work', 'pdf-author-editor-runs', `${baseName}-${timestamp()}`));
  fs.mkdirSync(outDir, { recursive: true });

  const outputs = {
    html: path.join(outDir, `${baseName}.html`),
    htmlQa: path.join(outDir, `${baseName}.html-qa.json`),
    pdf: path.join(outDir, `${baseName}.pdf`),
    screenshot: path.join(outDir, `${baseName}.png`),
    pdfQa: path.join(outDir, `${baseName}.pdf-qa.json`),
    preview: path.join(outDir, `${baseName}-preview.png`),
    manifest: path.resolve(args.manifest || path.join(outDir, 'render-manifest.json'))
  };

  const manifest = {
    ok: false,
    input: inputPath,
    delivery_type: deliveryType,
    template: templateId,
    out_dir: outDir,
    outputs,
    steps: [],
    warnings: [],
    started_at: new Date().toISOString()
  };

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const node = process.execPath;
  const python = args.python || resolvePython();
  const shouldPdf = args.pdf === true || (args.pdf !== false && inputMeta.export_pdf === true);
  const shouldQa = args.qa !== false;

  try {
    const renderStep = runStep(manifest, 'render-html', node, [
      path.join(scriptDir, 'render-html.mjs'),
      inputPath,
      '--type', deliveryType,
      ...(templateId ? ['--template', templateId] : []),
      '--out', outputs.html,
      ...(args.allowRemoteAssets ? ['--allow-remote-assets'] : [])
    ]);
    const renderInfo = parseJsonMaybe(renderStep.stdout);
    if (renderInfo?.template) manifest.template = renderInfo.template;

    let htmlQa = null;
    if (shouldQa) {
      htmlQa = runHtmlQa({
        manifest,
        node,
        scriptDir,
        outputs,
        deliveryType
      });
    }

    if (shouldPdf) {
      runPdfExport({
        manifest,
        node,
        python,
        scriptDir,
        outputs
      });

      if (shouldQa) {
        const expectedPages = expectedPdfPages(deliveryType, htmlQa);
        runPdfQa({
          manifest,
          python,
          scriptDir,
          outputs,
          deliveryType,
          expectedPages
        });
      }
    }

    pruneMissingOptionalOutputs(outputs);
    manifest.ok = manifest.steps.filter(step => !step.optional).every(step => step.ok);
    manifest.finished_at = new Date().toISOString();
    fs.writeFileSync(outputs.manifest, JSON.stringify(manifest, null, 2), 'utf8');
    console.log(JSON.stringify({
      ok: manifest.ok,
      manifest: outputs.manifest,
      html: outputs.html,
      pdf: shouldPdf ? outputs.pdf : undefined,
      out_dir: outDir,
      warnings: manifest.warnings
    }, null, 2));
    process.exit(manifest.ok ? 0 : 1);
  } catch (error) {
    pruneMissingOptionalOutputs(outputs);
    manifest.error = error.message || String(error);
    manifest.finished_at = new Date().toISOString();
    fs.writeFileSync(outputs.manifest, JSON.stringify(manifest, null, 2), 'utf8');
    console.error(manifest.error);
    console.error(`Manifest written to ${outputs.manifest}`);
    process.exit(1);
  }
}

function parseArgs(argv) {
  const args = { qa: true };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--out-dir') args.outDir = argv[++i];
    else if (item === '--manifest') args.manifest = argv[++i];
    else if (item === '--name') args.name = argv[++i];
    else if (item === '--type') args.type = argv[++i];
    else if (item === '--template') args.template = argv[++i];
    else if (item === '--pdf') args.pdf = true;
    else if (item === '--no-pdf') args.pdf = false;
    else if (item === '--qa') args.qa = true;
    else if (item === '--no-qa') args.qa = false;
    else if (item === '--python') args.python = argv[++i];
    else if (item === '--allow-remote-assets') args.allowRemoteAssets = true;
    else if (item === '--help' || item === '-h') usage('', 0);
    else if (!args.input) args.input = item;
    else usage(`Unknown argument: ${item}`);
  }
  if (args.type && !DELIVERY_TYPES.has(args.type)) usage(`Invalid --type "${args.type}".`);
  return args;
}

function usage(message, code = 1) {
  if (message) console.error(message);
  console.error('Usage: node render.mjs <input.json|input.md|input.html> [--type report|one-pager|slides] [--template id] [--pdf|--no-pdf] [--qa|--no-qa] [--out-dir dir] [--name base] [--python python]');
  process.exit(code);
}

function runHtmlQa({ manifest, node, scriptDir, outputs, deliveryType }) {
  const primary = runStep(manifest, 'qa-html', node, [
    path.join(scriptDir, 'qa-html.mjs'),
    outputs.html,
    '--out', outputs.htmlQa,
    '--expect-type', deliveryType
  ], { optional: true, throwOnFail: false });

  if (primary.ok) return readJson(outputs.htmlQa);
  if (!isPlaywrightMissing(primary)) throw stepError(primary);

  const warning = 'playwright_unavailable_static_html_qa';
  manifest.warnings.push(warning);
  const qa = writeStaticHtmlQa(outputs.html, outputs.htmlQa, deliveryType, warning);
  addSyntheticStep(manifest, 'qa-html-static', qa.ok, {
    fallbackFor: 'qa-html',
    output: outputs.htmlQa,
    warnings: qa.warnings,
    errors: qa.errors
  });
  if (!qa.ok) throw new Error(`qa-html-static failed: ${qa.errors.join(', ')}`);
  return qa;
}

function runPdfExport({ manifest, node, python, scriptDir, outputs }) {
  const primary = runStep(manifest, 'export-pdf', node, [
    path.join(scriptDir, 'export-pdf.mjs'),
    outputs.html,
    '--out', outputs.pdf,
    '--screenshot', outputs.screenshot
  ], { optional: true, throwOnFail: false });

  if (primary.ok) return;
  if (!isPlaywrightMissing(primary)) throw stepError(primary);

  const warning = 'playwright_unavailable_edge_export';
  manifest.warnings.push(warning);
  const fallbackScript = resolveEdgeExporter(scriptDir);
  if (!fallbackScript) {
    throw new Error('export-pdf failed because Playwright is unavailable and no Edge/Chrome fallback exporter was found.');
  }

  const fallback = runStep(manifest, 'export-pdf-edge', python, [
    fallbackScript,
    outputs.html,
    outputs.pdf,
    '--overwrite'
  ], { fallbackFor: 'export-pdf', throwOnFail: false });

  if (!fallback.ok) throw stepError(fallback);
  manifest.warnings.push('screenshot_unavailable_without_playwright');
}

function runPdfQa({ manifest, python, scriptDir, outputs, deliveryType, expectedPages }) {
  const args = [
    path.join(scriptDir, 'qa-pdf.py'),
    outputs.pdf,
    '--out', outputs.pdfQa,
    '--preview', outputs.preview,
    '--expect-type', deliveryType,
    ...(expectedPages ? ['--expect-pages', String(expectedPages)] : [])
  ];
  const primary = runStep(manifest, 'qa-pdf', python, args, { optional: true, throwOnFail: false });

  if (primary.ok) return readJson(outputs.pdfQa);
  if (!isPyMuPdfMissing(primary)) throw stepError(primary);

  const warning = 'pymupdf_unavailable_static_pdf_qa';
  manifest.warnings.push(warning);
  const qa = writeStaticPdfQa(outputs.pdf, outputs.pdfQa, outputs.preview, deliveryType, expectedPages, warning);
  addSyntheticStep(manifest, 'qa-pdf-static', qa.ok, {
    fallbackFor: 'qa-pdf',
    output: outputs.pdfQa,
    warnings: qa.warnings,
    errors: qa.errors
  });
  if (!qa.ok) throw new Error(`qa-pdf-static failed: ${qa.errors.join(', ')}`);
  return qa;
}

function runStep(manifest, name, command, args, options = {}) {
  const started = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
    windowsHide: true
  });
  const step = {
    name,
    command,
    args,
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    started_at: started,
    finished_at: new Date().toISOString()
  };
  if (result.error) step.error = result.error.message;
  if (options.optional) step.optional = true;
  if (options.fallbackFor) step.fallback_for = options.fallbackFor;
  manifest.steps.push(step);
  if (!step.ok && options.throwOnFail !== false) throw stepError(step);
  return step;
}

function addSyntheticStep(manifest, name, ok, details = {}) {
  const step = {
    name,
    ok,
    status: ok ? 0 : 1,
    synthetic: true,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    ...details
  };
  if (details.fallbackFor) step.fallback_for = details.fallbackFor;
  manifest.steps.push(step);
  return step;
}

function stepError(step) {
  return new Error(`${step.name} failed with status ${step.status}: ${step.stderr || step.stdout || step.error || 'unknown error'}`);
}

function inspectInput(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext !== '.json') return {};
  try {
    const data = JSON.parse(stripJsonBom(fs.readFileSync(inputPath, 'utf8')));
    return {
      delivery_type: data.delivery_type || data.type,
      template: data.template || data.theme?.template,
      export_pdf: data.export && data.export.pdf === true
    };
  } catch {
    return {};
  }
}

function expectedPdfPages(deliveryType, htmlQa) {
  if (deliveryType === 'one-pager') return 1;
  if (deliveryType === 'slides') return htmlQa?.metrics?.slides || undefined;
  return undefined;
}

function writeStaticHtmlQa(htmlPath, outPath, expectedType, fallbackWarning) {
  const errors = [];
  const warnings = [fallbackWarning, 'browser_layout_checks_not_run'];
  let html = '';

  if (!fs.existsSync(htmlPath)) {
    errors.push('html_missing');
  } else {
    html = fs.readFileSync(htmlPath, 'utf8');
  }

  const text = stripHtml(html).trim();
  const deliveryType = extractDeliveryType(html);
  const remoteResources = countRemoteResources(html);
  const slides = countSlides(html);

  if (!text) errors.push('blank_body');
  if (expectedType && deliveryType && deliveryType !== expectedType) errors.push('delivery_type_mismatch');
  if (!deliveryType) warnings.push('delivery_type_not_found');
  if (remoteResources > 0) warnings.push('remote_resources_not_loaded_in_static_qa');
  if (expectedType === 'slides' && slides === 0) errors.push('slides_not_found');

  const result = {
    ok: errors.length === 0,
    input: path.resolve(htmlPath),
    expect_type: expectedType,
    errors,
    warnings,
    metrics: {
      delivery_type: deliveryType || null,
      body_text_length: text.length,
      remote_resources: remoteResources,
      slides
    }
  };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

function writeStaticPdfQa(pdfPath, outPath, previewPath, expectedType, expectedPages, fallbackWarning) {
  const errors = [];
  const warnings = [fallbackWarning, 'visual_blank_page_checks_not_run'];
  const resolved = path.resolve(pdfPath);
  let buffer = Buffer.alloc(0);

  if (!fs.existsSync(resolved)) {
    errors.push('pdf_missing');
  } else {
    buffer = fs.readFileSync(resolved);
  }

  const headerOk = buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  const sizeOk = buffer.length >= MIN_PDF_BYTES;
  const pageCount = estimatePdfPageCount(buffer);

  if (!headerOk) errors.push('pdf_header_invalid');
  if (!sizeOk) errors.push('pdf_too_small');
  if (expectedPages && pageCount && pageCount !== expectedPages) errors.push('page_count_mismatch');
  if (expectedPages && !pageCount) warnings.push('page_count_not_verified');

  const result = {
    ok: errors.length === 0,
    input: resolved,
    page_count: pageCount || null,
    expected_pages: expectedPages || null,
    expect_type: expectedType,
    errors,
    warnings,
    blank_pages: [],
    pages: [],
    preview: fs.existsSync(previewPath) ? path.resolve(previewPath) : null,
    validation: {
      exists: fs.existsSync(resolved),
      size_bytes: buffer.length,
      size_ok: sizeOk,
      pdf_header_ok: headerOk
    }
  };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

function resolveEdgeExporter(scriptDir) {
  const skillDir = path.resolve(scriptDir, '..', '..');
  const skillsDir = path.dirname(skillDir);
  const candidates = [
    path.join(scriptDir, 'export-pdf-edge.py'),
    path.join(skillsDir, 'export-pdf', 'scripts', 'export-pdf.py')
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function isPlaywrightMissing(step) {
  const text = `${step.stderr}\n${step.stdout}\n${step.error || ''}`.toLowerCase();
  return text.includes('playwright could not be resolved')
    || text.includes("cannot find module 'playwright'")
    || text.includes('cannot find package') && text.includes('playwright')
    || text.includes('no package named playwright');
}

function isPyMuPdfMissing(step) {
  const text = `${step.stderr}\n${step.stdout}\n${step.error || ''}`.toLowerCase();
  return text.includes('pymupdf is required')
    || text.includes("no module named 'fitz'")
    || text.includes('no module named fitz')
    || text.includes('modulenotfounderror') && text.includes('fitz');
}

function estimatePdfPageCount(buffer) {
  if (!buffer.length) return null;
  const text = buffer.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page\b/g);
  return matches && matches.length ? matches.length : null;
}

function stripHtml(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

function extractDeliveryType(html) {
  const match = html.match(/<html\b[^>]*\bdata-delivery-type=["']?([^"'\s>]+)/i);
  return match ? match[1] : null;
}

function countRemoteResources(html) {
  const matches = html.match(/\b(?:src|href)=["']https?:\/\//gi);
  return matches ? matches.length : 0;
}

function countSlides(html) {
  const matches = html.match(/<section\b[^>]*\bclass=["'][^"']*\bslide\b/gi);
  return matches ? matches.length : 0;
}

function pruneMissingOptionalOutputs(outputs) {
  for (const key of ['screenshot', 'preview']) {
    if (outputs[key] && !fs.existsSync(outputs[key])) delete outputs[key];
  }
}

function readJson(filePath) {
  return JSON.parse(stripJsonBom(fs.readFileSync(filePath, 'utf8')));
}

function parseJsonMaybe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolvePython() {
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  const candidates = [
    process.env.PYTHON,
    process.env.PDF_AUTHOR_EDITOR_PYTHON,
    path.resolve(path.dirname(process.execPath), '..', '..', 'python', 'python.exe'),
    path.resolve(path.dirname(process.execPath), '..', '..', 'python', 'bin', 'python'),
    localAppData ? path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe') : null,
    localAppData ? path.join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe') : null,
    localAppData ? path.join(localAppData, 'Programs', 'Python', 'Python310', 'python.exe') : null,
    programFiles ? path.join(programFiles, 'Python312', 'python.exe') : null,
    programFiles ? path.join(programFiles, 'Python311', 'python.exe') : null,
    programFilesX86 ? path.join(programFilesX86, 'Python312', 'python.exe') : null,
    'python',
    'py',
    'python3'
  ].filter(Boolean);
  return candidates.find(isPythonUsable) || 'python';
}

function isPythonUsable(candidate) {
  if (!['python', 'py', 'python3'].includes(candidate) && !fs.existsSync(candidate)) return false;
  const result = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], {
    encoding: 'utf8',
    windowsHide: true
  });
  return !result.error && result.status === 0;
}

function safeBaseName(value) {
  return String(value || 'document')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'document';
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function stripJsonBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

main();
