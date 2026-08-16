#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(scriptDir, "..");

const required = [
  "SKILL.md",
  "scripts/pdf-author-editor.mjs",
  "scripts/self-test.mjs",
  "scripts/author/render.mjs",
  "scripts/author/render-html.mjs",
  "scripts/author/export-pdf.mjs",
  "scripts/author/qa-html.mjs",
  "scripts/author/qa-pdf.py",
  "scripts/modify/modify-pdf.py",
  "scripts/modify/page_ops.py",
  "scripts/modify/overlay_ops.py",
  "scripts/semantic/semantic-edit.py",
  "references/routing.md",
  "references/routing-rules.md",
  "references/execution-policy.md",
  "references/capability-matrix.json",
  "references/output-format.md",
  "references/qa-checklist.md",
  "schemas/template-registry.schema.json",
  "schemas/capability-report.schema.json",
  "schemas/capability-matrix.schema.json",
  "schemas/request.schema.json",
  "schemas/author.schema.json",
  "schemas/edit-plan.schema.json",
  "schemas/manifest.schema.json",
  "schemas/qa-report.schema.json",
  "schemas/self-test-report.schema.json",
  "assets/templates/templates.json",
  "assets/templates/report/template.html",
  "assets/templates/report/formal-report/template.html",
  "assets/templates/report/tabler-report/template.html",
  "assets/templates/report/briefing-note/template.html",
  "assets/templates/one-pager/template.html",
  "assets/templates/one-pager/executive-brief/template.html",
  "assets/templates/slides/template.html",
  "examples/author-report-request.json",
  "examples/author-report-content.json",
  "examples/author-formal-report-request.json",
  "examples/author-formal-report-content.json",
  "examples/author-briefing-note-request.json",
  "examples/author-briefing-note-content.json",
  "examples/author-tabler-report-request.json",
  "examples/author-tabler-report-content.json",
  "examples/author-one-pager-request.json",
  "examples/author-one-pager-content.json",
  "examples/modify-page-ops-request.json",
  "examples/modify-watermark-request.json",
  "examples/semantic-occurrence-request.json",
  "examples/semantic-normalized-request.json",
  "examples/semantic-short-text-request.json",
  "examples/semantic-rebuild-request.json",
  "examples/semantic-rewrite-request.json",
  "examples/semantic-read-pdf-result.json"
];

const errors = [];
const warnings = [];

for (const relative of required) {
  if (!fs.existsSync(path.join(skillDir, relative))) {
    errors.push(`missing:${relative}`);
  }
}

const skillMdPath = path.join(skillDir, "SKILL.md");
if (fs.existsSync(skillMdPath)) {
  const skillMd = fs.readFileSync(skillMdPath, "utf8");
  if (!/^---\n[\s\S]*?\n---/.test(skillMd)) errors.push("skill_md_missing_frontmatter");
  if (!/^name:\s*pdf-author-editor$/m.test(skillMd)) errors.push("skill_md_missing_name");
  if (!/^description:\s*.+$/m.test(skillMd)) errors.push("skill_md_missing_description");
}

for (const relative of required.filter((item) => item.endsWith(".json"))) {
  const filePath = path.join(skillDir, relative);
  if (!fs.existsSync(filePath)) continue;
  try {
    JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`invalid_json:${relative}:${error.message}`);
  }
}

const templateRegistryPath = path.join(skillDir, "assets", "templates", "templates.json");
if (fs.existsSync(templateRegistryPath)) {
  try {
    validateTemplateRegistry(JSON.parse(fs.readFileSync(templateRegistryPath, "utf8")));
  } catch (error) {
    errors.push(`invalid_template_registry:${error.message}`);
  }
}

for (const filePath of walk(skillDir)) {
  const relative = path.relative(skillDir, filePath).replace(/\\/g, "/");
  if (relative.includes("node_modules/")) errors.push(`forbidden_node_modules:${relative}`);
  if (relative.includes("__pycache__/")) errors.push(`forbidden_pycache:${relative}`);
  if (/\.pyc$/i.test(relative)) errors.push(`forbidden_pyc:${relative}`);
  if (/\.(pdf|png|jpg|jpeg|webp|zip)$/i.test(relative)) warnings.push(`binary_or_generated_candidate:${relative}`);
  if (/manifest\.json$|edit-plan\.json$|capability-report\.json$|qa-report\.json$|self-test-report\.json$|qa\.json$/i.test(relative)) warnings.push(`generated_json_candidate:${relative}`);
}

const result = {
  ok: errors.length === 0,
  skillDir,
  errors,
  warnings
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else {
      yield fullPath;
    }
  }
}

function validateTemplateRegistry(registry) {
  if (!registry || typeof registry !== "object") throw new Error("registry_not_object");
  if (!Array.isArray(registry.templates) || registry.templates.length === 0) throw new Error("templates_missing");
  const ids = new Set();
  for (const item of registry.templates) {
    if (!item.id) throw new Error("template_id_missing");
    if (ids.has(item.id)) throw new Error(`template_id_duplicate:${item.id}`);
    ids.add(item.id);
    if (!["report", "one-pager", "slides"].includes(item.delivery_type)) throw new Error(`template_delivery_type_invalid:${item.id}`);
    if (!item.path) throw new Error(`template_path_missing:${item.id}`);
    const templatePath = path.join(skillDir, "assets", "templates", item.path);
    if (!fs.existsSync(templatePath)) throw new Error(`template_file_missing:${item.id}:${item.path}`);
  }
  for (const deliveryType of ["report", "one-pager", "slides"]) {
    const defaultId = registry.default_by_delivery_type?.[deliveryType];
    if (!defaultId) throw new Error(`template_default_missing:${deliveryType}`);
    const found = registry.templates.find((item) => item.id === defaultId && item.delivery_type === deliveryType);
    if (!found) throw new Error(`template_default_invalid:${deliveryType}:${defaultId}`);
  }
}
