#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DELIVERY_TYPES = new Set(['report', 'one-pager', 'slides']);
const PUBLIC_BLOCK_TYPES = new Set(['heading', 'paragraph', 'list', 'table', 'figure', 'callout', 'divider', 'slide', 'raw_html']);

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) usage('Missing input file.');

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) usage(`Input file not found: ${inputPath}`);

  const ext = path.extname(inputPath).toLowerCase();
  const outPath = path.resolve(args.out || defaultOutputPath(inputPath));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  if (ext === '.html' || ext === '.htm') {
    const raw = fs.readFileSync(inputPath, 'utf8');
    let html;
    let template = null;
    if (looksLikeFullHtml(raw)) {
      html = ensureRenderReady(raw, args.type || 'report');
    } else {
      const rendered = renderDocument(htmlFragmentToDocument(raw, args.type), inputPath, args);
      html = rendered.html;
      template = rendered.template;
    }
    fs.writeFileSync(outPath, html, 'utf8');
    console.log(JSON.stringify({ ok: true, output: outPath, input: inputPath, mode: 'html', template }, null, 2));
    return;
  }

  const document = ext === '.json'
    ? readJsonDocument(inputPath, args.type)
    : ext === '.md' || ext === '.markdown'
      ? markdownToDocument(fs.readFileSync(inputPath, 'utf8'), args.type)
      : usage(`Unsupported input extension: ${ext || '(none)'}`);

  const rendered = renderDocument(document, inputPath, args);
  const html = rendered.html;
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    output: outPath,
    input: inputPath,
    delivery_type: document.delivery_type,
    template: rendered.template,
    blocks: document.content.length
  }, null, 2));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--out' || item === '-o') {
      args.out = argv[++i];
    } else if (item === '--type') {
      args.type = argv[++i];
    } else if (item === '--template') {
      args.template = argv[++i];
    } else if (item === '--allow-remote-assets') {
      args.allowRemoteAssets = true;
    } else if (item === '--help' || item === '-h') {
      usage('', 0);
    } else if (!args.input) {
      args.input = item;
    } else {
      usage(`Unknown argument: ${item}`);
    }
  }
  if (args.type && !DELIVERY_TYPES.has(args.type)) {
    usage(`Invalid --type "${args.type}". Expected report, one-pager, or slides.`);
  }
  return args;
}

function usage(message, code = 1) {
  if (message) console.error(message);
  console.error('Usage: node render-html.mjs <input.json|input.md|input.html> [--type report|one-pager|slides] [--template id] [--out output.html] [--allow-remote-assets]');
  process.exit(code);
}

function defaultOutputPath(inputPath) {
  const name = `${path.basename(inputPath, path.extname(inputPath))}.html`;
  return path.join(process.cwd(), 'work', 'pdf-author-editor-runs', name);
}

function readJsonDocument(inputPath, typeOverride) {
  let data;
  try {
    data = JSON.parse(stripJsonBom(fs.readFileSync(inputPath, 'utf8')));
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
  const doc = normalizeDocument(data, typeOverride);
  validateDocument(doc);
  return doc;
}

function normalizeDocument(data, typeOverride) {
  const deliveryType = typeOverride || data.delivery_type || data.type || 'report';
  if (!DELIVERY_TYPES.has(deliveryType)) {
    throw new Error(`Invalid delivery_type "${deliveryType}". Expected report, one-pager, or slides.`);
  }
  const meta = data.meta || {};
  const title = String(meta.title || data.title || 'Untitled Document').trim() || 'Untitled Document';
  const page = data.page || {};
  return {
    schema_version: data.schema_version || 1,
    delivery_type: deliveryType,
    meta: {
      ...meta,
      title
    },
    page: {
      size: page.size || (deliveryType === 'slides' ? '16:9' : 'A4'),
      orientation: page.orientation || 'portrait',
      margins: page.margins || 'normal',
      ...page
    },
    template: data.template || data.theme?.template || null,
    theme: data.theme || {},
    summary_metrics: normalizeMetrics(data.summary_metrics || data.metrics || data.dashboard?.metrics || data.kpis),
    status_badges: normalizeBadges(data.status_badges || data.badges || data.dashboard?.status_badges || data.status),
    content: Array.isArray(data.content) ? data.content : [],
    assets: Array.isArray(data.assets) ? data.assets : [],
    export: data.export || {}
  };
}

function validateDocument(doc) {
  if (!doc.meta.title) throw new Error('Document meta.title is required.');
  if (!Array.isArray(doc.content)) throw new Error('Document content must be an array.');
  if (doc.content.length === 0) throw new Error('Document content cannot be empty.');
  doc.content.forEach((block, index) => validateBlock(block, `content[${index}]`, doc.delivery_type));
}

function validateBlock(block, where, deliveryType) {
  if (!block || typeof block !== 'object') throw new Error(`${where} must be an object.`);
  if (!block.type) throw new Error(`${where}.type is required.`);
  if (!PUBLIC_BLOCK_TYPES.has(block.type) && block.type !== 'raw') {
    throw new Error(`${where}.type "${block.type}" is not supported.`);
  }
  if (block.type === 'heading' && !nonEmpty(block.text || block.title)) throw new Error(`${where}: heading requires text or title.`);
  if (block.type === 'paragraph' && !nonEmpty(block.text)) throw new Error(`${where}: paragraph requires text.`);
  if (block.type === 'list' && (!Array.isArray(block.items) || block.items.length === 0)) throw new Error(`${where}: list requires a non-empty items array.`);
  if (block.type === 'table' && (!Array.isArray(block.rows) || block.rows.length === 0)) throw new Error(`${where}: table requires a non-empty rows array.`);
  if (block.type === 'figure' && !nonEmpty(block.src)) throw new Error(`${where}: figure requires src.`);
  if (block.type === 'callout' && !nonEmpty(block.text) && !nonEmpty(block.title)) throw new Error(`${where}: callout requires text or title.`);
  if ((block.type === 'raw_html' || block.type === 'raw') && !nonEmpty(block.html)) throw new Error(`${where}: ${block.type} requires html.`);
  if (block.type === 'slide') {
    if (deliveryType !== 'slides') throw new Error(`${where}: slide blocks are only valid for delivery_type "slides".`);
    const blocks = Array.isArray(block.blocks) ? block.blocks : [];
    if (!nonEmpty(block.title) && blocks.length === 0) throw new Error(`${where}: slide requires title or blocks.`);
    blocks.forEach((child, index) => validateBlock(child, `${where}.blocks[${index}]`, 'report'));
  }
}

function nonEmpty(value) {
  return String(value ?? '').trim().length > 0;
}

function markdownToDocument(markdown, typeOverride) {
  const blocks = parseMarkdown(markdown);
  const firstHeading = blocks.find(block => block.type === 'heading');
  const title = firstHeading ? firstHeading.text : 'Markdown Document';
  return normalizeDocument({
    schema_version: 1,
    delivery_type: typeOverride || 'report',
    meta: { title },
    content: blocks
  }, typeOverride);
}

function parseMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const language = fence[1].trim();
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'callout', title: language || 'Code', text: code.join('\n'), preformatted: true });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }
    const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (image) {
      blocks.push({ type: 'figure', alt: image[1].trim(), src: image[2].trim(), caption: image[1].trim() });
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      const parsed = parseMarkdownTable(lines, i);
      blocks.push(parsed.block);
      i = parsed.nextIndex;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, '').trim());
        i += 1;
      }
      blocks.push({ type: 'list', style: 'bullet', items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, '').trim());
        i += 1;
      }
      blocks.push({ type: 'list', style: 'number', items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, '').trim());
        i += 1;
      }
      blocks.push({ type: 'callout', title: 'Note', text: quote.join(' ') });
      continue;
    }

    const paragraph = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }
  return blocks.length ? blocks : [{ type: 'paragraph', text: 'No content.' }];
}

function isTableStart(lines, index) {
  return index + 1 < lines.length &&
    lines[index].includes('|') &&
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]);
}

function parseMarkdownTable(lines, start) {
  const columns = splitTableRow(lines[start]);
  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
    rows.push(splitTableRow(lines[i]));
    i += 1;
  }
  return { block: { type: 'table', columns, rows }, nextIndex: i };
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function htmlFragmentToDocument(html, typeOverride) {
  return normalizeDocument({
    schema_version: 1,
    delivery_type: typeOverride || 'report',
    meta: { title: 'HTML Fragment' },
    content: [{ type: 'raw_html', html }]
  }, typeOverride);
}

function renderDocument(doc, sourcePath, options = {}) {
  validateDocument(doc);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const selectedTemplate = resolveTemplate(doc.delivery_type, options.template || doc.template || doc.theme?.template);
  const template = fs.readFileSync(selectedTemplate.path, 'utf8');
  const context = {
    sourceDir: sourcePath ? path.dirname(path.resolve(sourcePath)) : process.cwd(),
    allowRemoteAssets: options.allowRemoteAssets === true,
    deliveryType: doc.delivery_type,
    templateId: selectedTemplate.info.id
  };
  const content = doc.delivery_type === 'slides'
    ? renderSlides(doc.content, doc.meta, context)
    : selectedTemplate.info.id === 'tabler-report'
      ? renderTablerReportContent(doc.content, context)
      : renderBlocks(doc.content, doc.delivery_type, context);
  return {
    html: fillTemplate(template, {
    TITLE: esc(doc.meta.title),
    SUBTITLE: esc(doc.meta.subtitle || ''),
    META: renderMeta(doc.meta, sourcePath),
    SUMMARY_METRICS: renderSummaryMetrics(doc.summary_metrics),
    STATUS_BADGES: renderStatusBadges(doc.status_badges),
    CONTENT: content,
    CSS: baseCss(),
    PAGE_SIZE: pageSize(doc),
    PAGE_ORIENTATION: pageOrientation(doc),
    PAGE_MARGIN: pageMargin(doc)
    }),
    template: selectedTemplate.info
  };
}

function resolveTemplate(deliveryType, requestedId) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const templatesRoot = path.resolve(scriptDir, '..', '..', 'assets', 'templates');
  const registryPath = path.join(templatesRoot, 'templates.json');
  if (!fs.existsSync(registryPath)) {
    return {
      path: path.join(templatesRoot, deliveryType, 'template.html'),
      info: {
        id: `${deliveryType}-default`,
        delivery_type: deliveryType
      }
    };
  }

  const registry = JSON.parse(stripJsonBom(fs.readFileSync(registryPath, 'utf8')));
  const templateId = requestedId || registry.default_by_delivery_type?.[deliveryType];
  const templates = Array.isArray(registry.templates) ? registry.templates : [];
  const selected = templates.find(item => item.id === templateId);
  if (!selected) {
    const available = templates
      .filter(item => item.delivery_type === deliveryType)
      .map(item => item.id)
      .join(', ');
    throw new Error(`Unknown template "${templateId}" for ${deliveryType}. Available: ${available || '(none)'}`);
  }
  if (selected.delivery_type !== deliveryType) {
    throw new Error(`Template "${selected.id}" is for ${selected.delivery_type}, not ${deliveryType}.`);
  }
  const templatePath = path.join(templatesRoot, selected.path);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template file not found for "${selected.id}": ${selected.path}`);
  }
  return {
    path: templatePath,
    info: {
      id: selected.id,
      delivery_type: selected.delivery_type,
      label: selected.label || selected.id,
      path: selected.path
    }
  };
}

function fillTemplate(template, values) {
  return Object.entries(values).reduce((html, [key, value]) => html.replaceAll(`{{${key}}}`, String(value)), template);
}

function renderMeta(meta, sourcePath) {
  const parts = [meta.author, meta.date].filter(Boolean).map(esc);
  if (!parts.length && sourcePath) parts.push(`Source: ${esc(path.basename(sourcePath))}`);
  return parts.join(' &middot; ');
}

function pageSize(doc) {
  if (doc.delivery_type === 'slides') return '16in 9in';
  return doc.page.size === 'Letter' ? 'Letter' : 'A4';
}

function pageOrientation(doc) {
  if (doc.delivery_type === 'slides') return '';
  return doc.page.orientation === 'landscape' ? 'landscape' : 'portrait';
}

function pageMargin(doc) {
  const margins = {
    compact: '10mm',
    normal: doc.delivery_type === 'one-pager' ? '12mm' : '16mm',
    wide: '22mm'
  };
  return margins[doc.page.margins] || margins.normal;
}

function renderBlocks(blocks, deliveryType, context = {}) {
  return blocks.map(block => renderBlock(block, deliveryType, context)).join('\n');
}

function renderTablerReportContent(blocks, context = {}) {
  const groups = [];
  let current = null;
  const prelude = [];

  for (const block of blocks) {
    const level = block.type === 'heading' ? Math.min(4, Math.max(1, Number(block.level || 2))) : null;
    if (block.type === 'heading' && level === 1) {
      if (current) groups.push(current);
      current = {
        title: block.text || block.title || 'Section',
        blocks: []
      };
      continue;
    }
    if (current) current.blocks.push(block);
    else prelude.push(block);
  }
  if (current) groups.push(current);

  const rendered = [];
  if (prelude.length) {
    rendered.push(renderTablerSection('Overview', prelude, context, { muted: true }));
  }
  if (groups.length) {
    for (const group of groups) {
      rendered.push(renderTablerSection(group.title, group.blocks, context));
    }
  }
  if (!rendered.length) {
    rendered.push(renderTablerSection('Report', blocks, context, { muted: true }));
  }
  return rendered.join('\n');
}

function renderTablerSection(title, blocks, context = {}, options = {}) {
  const body = blocks.length ? renderBlocks(blocks, 'report', context) : '<p class="content-block text-muted">No section content.</p>';
  const kicker = options.muted ? 'Overview' : 'Section';
  return `<section class="section-card content-block">
    <div class="section-card-header">
      <div>
        <p class="section-kicker">${esc(kicker)}</p>
        <h2 class="section-title">${esc(title)}</h2>
      </div>
    </div>
    <div class="section-card-body">${body}</div>
  </section>`;
}

function renderSummaryMetrics(metrics) {
  if (!Array.isArray(metrics) || metrics.length === 0) return '';
  return `<section class="metric-grid">${metrics.slice(0, 8).map(metric => {
    const tone = metric.tone ? ` tone-${safeClass(metric.tone)}` : '';
    return `<div class="metric-card${tone}">
      <p class="metric-label">${esc(metric.label || '')}</p>
      <p class="metric-value">${esc(metric.value || '')}</p>
      ${metric.note ? `<p class="metric-note">${esc(metric.note)}</p>` : ''}
    </div>`;
  }).join('')}</section>`;
}

function renderStatusBadges(badges) {
  if (!Array.isArray(badges) || badges.length === 0) return '';
  return `<div class="status-row">${badges.slice(0, 12).map(badge => {
    const tone = badge.tone ? ` ${safeClass(badge.tone)}` : '';
    return `<span class="status-pill${tone}">${esc(badge.label || '')}</span>`;
  }).join('')}</div>`;
}

function renderBlock(block, deliveryType, context = {}) {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(4, Math.max(1, Number(block.level || 2)));
      return `<h${level} class="content-block">${esc(block.text || block.title || '')}</h${level}>`;
    }
    case 'paragraph':
      return `<p class="content-block${deliveryType === 'one-pager' ? ' wide' : ''}">${formatText(block.text || '')}</p>`;
    case 'list': {
      const tag = block.style === 'number' ? 'ol' : 'ul';
      const items = Array.isArray(block.items) ? block.items : [];
      return `<${tag} class="content-block">${items.map(item => `<li>${formatText(String(item))}</li>`).join('')}</${tag}>`;
    }
    case 'table':
      return renderTable(block);
    case 'figure':
      return renderFigure(block, context);
    case 'callout':
      return renderCallout(block);
    case 'divider':
      return '<hr class="divider">';
    case 'raw':
    case 'raw_html':
      return String(block.html || '');
    default:
      return '';
  }
}

function renderTable(block) {
  const columns = normalizeColumns(block.columns, block.rows);
  const rows = Array.isArray(block.rows) ? block.rows : [];
  const head = columns.length
    ? `<thead><tr>${columns.map(col => `<th>${esc(col.label)}</th>`).join('')}</tr></thead>`
    : '';
  const body = rows.map(row => {
    const cells = columns.length
      ? columns.map(col => cellValue(row, col))
      : (Array.isArray(row) ? row : Object.values(row || {}));
    return `<tr>${cells.map(cell => `<td>${formatText(String(cell ?? ''))}</td>`).join('')}</tr>`;
  }).join('');
  const caption = block.caption ? `<div class="table-caption">${esc(block.caption)}</div>` : '';
  return `<div class="content-block wide"><table>${head}<tbody>${body}</tbody></table>${caption}</div>`;
}

function normalizeColumns(columns, rows) {
  if (Array.isArray(columns) && columns.length) {
    return columns.map((col, index) => typeof col === 'string'
      ? { key: col, label: col, index }
      : { key: col.key || col.label || String(index), label: col.label || col.key || String(index + 1), index });
  }
  const first = Array.isArray(rows) ? rows[0] : null;
  if (Array.isArray(first)) return first.map((_, index) => ({ key: String(index), label: `Column ${index + 1}`, index }));
  if (first && typeof first === 'object') return Object.keys(first).map((key, index) => ({ key, label: key, index }));
  return [];
}

function cellValue(row, col) {
  if (Array.isArray(row)) return row[col.index];
  return row ? row[col.key] : '';
}

function renderFigure(block, context = {}) {
  if (!block.src) return '';
  const src = resolveAssetSource(block.src, context);
  return `<figure class="content-block wide"><img src="${escAttr(src)}" alt="${escAttr(block.alt || block.caption || '')}">${block.caption ? `<figcaption>${esc(block.caption)}</figcaption>` : ''}</figure>`;
}

function renderCallout(block) {
  const tone = ['warning', 'success'].includes(block.tone) ? block.tone : '';
  const body = block.preformatted
    ? `<pre><code>${esc(block.text || '')}</code></pre>`
    : `<div>${formatText(block.text || '')}</div>`;
  return `<aside class="callout ${tone} content-block wide">${block.title ? `<div class="callout-title">${esc(block.title)}</div>` : ''}${body}</aside>`;
}

function normalizeMetrics(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') {
        return { label: 'Metric', value: String(item), note: '' };
      }
      if (!item || typeof item !== 'object') return null;
      const label = String(item.label || item.name || item.title || '').trim();
      const metricValue = String(item.value ?? item.count ?? item.total ?? '').trim();
      if (!label && !metricValue) return null;
      return {
        label: label || 'Metric',
        value: metricValue || '-',
        note: String(item.note || item.caption || item.description || '').trim(),
        tone: String(item.tone || item.status || '').trim()
      };
    })
    .filter(Boolean);
}

function normalizeBadges(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') {
        return { label: String(item), tone: '' };
      }
      if (!item || typeof item !== 'object') return null;
      const label = String(item.label || item.text || item.name || item.status || '').trim();
      if (!label) return null;
      return {
        label,
        tone: String(item.tone || item.type || item.variant || '').trim()
      };
    })
    .filter(Boolean);
}

function safeClass(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function renderSlides(content, meta, context = {}) {
  const slides = content.filter(block => block.type === 'slide');
  const normalizedSlides = slides.length ? slides : [{ type: 'slide', title: meta.title, subtitle: meta.subtitle, blocks: content }];
  return normalizedSlides.map((slide, index) => {
    const title = slide.title || (index === 0 ? meta.title : `Slide ${index + 1}`);
    const subtitle = slide.subtitle || '';
    const blocks = Array.isArray(slide.blocks) ? slide.blocks : [];
    return `<section class="slide" data-slide-index="${index + 1}">
      <h1 class="slide-title">${esc(title)}</h1>
      ${subtitle ? `<p class="slide-subtitle">${esc(subtitle)}</p>` : ''}
      <div class="slide-body">${renderBlocks(blocks, 'slides', context)}</div>
    </section>`;
  }).join('\n');
}

function formatText(text) {
  return formatInline(text).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
}

function formatInline(text) {
  let safe = esc(text);
  safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
  safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  safe = safe.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => `<a href="${escAttr(href)}">${label}</a>`);
  return safe;
}

function resolveAssetSource(src, context) {
  const value = String(src || '').trim();
  if (!value) return value;
  if (/^(data|blob):/i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) {
    if (context.allowRemoteAssets) return value;
    throw new Error(`Remote asset is not allowed by default: ${value}. Provide a local file or pass --allow-remote-assets.`);
  }
  const assetPath = path.isAbsolute(value) ? value : path.resolve(context.sourceDir || process.cwd(), value);
  if (!fs.existsSync(assetPath)) {
    throw new Error(`Asset not found: ${value} (resolved to ${assetPath})`);
  }
  const stat = fs.statSync(assetPath);
  if (!stat.isFile()) throw new Error(`Asset is not a file: ${assetPath}`);
  if (stat.size > 2 * 1024 * 1024) {
    throw new Error(`Asset is too large to inline safely: ${assetPath} (${stat.size} bytes)`);
  }
  const mime = mimeType(assetPath);
  const data = fs.readFileSync(assetPath).toString('base64');
  return `data:${mime};base64,${data}`;
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function escAttr(value) {
  return esc(value).replace(/`/g, '&#96;');
}

function looksLikeFullHtml(text) {
  return /<!doctype html/i.test(text) || /<html[\s>]/i.test(text);
}

function ensureRenderReady(html, deliveryType = 'report') {
  let output = ensureDeliveryType(html, deliveryType);
  if (output.includes('__RENDER_READY__')) return output;
  const script = '<script>window.__RENDER_READY__ = true;</script>';
  return output.includes('</body>') ? output.replace('</body>', `${script}\n</body>`) : `${output}\n${script}`;
}

function stripJsonBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

function ensureDeliveryType(html, deliveryType) {
  if (/<html\b[^>]*\bdata-delivery-type=/i.test(html)) return html;
  return html.replace(/<html\b([^>]*)>/i, (_match, attrs) => `<html${attrs} data-delivery-type="${escAttr(deliveryType)}">`);
}

function baseCss() {
  return `
    :root {
      color-scheme: light;
    }
    * {
      box-sizing: border-box;
    }
    a {
      color: #1f6feb;
      text-decoration: none;
    }
    pre {
      background: #111827;
      border-radius: 6px;
      color: #f8fafc;
      font-size: 12px;
      margin: 8px 0 0;
      overflow-wrap: anywhere;
      padding: 10px 12px;
      white-space: pre-wrap;
    }
    code {
      font-family: Consolas, "Courier New", monospace;
    }
  `;
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
