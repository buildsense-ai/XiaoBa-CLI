#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

const SKILL_NAME = "pdf-author-editor";
const VERSION = "1.2.5";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const CAPABILITY_MATRIX_PATH = path.join(SKILL_DIR, "references", "capability-matrix.json");

main().catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.capabilities) {
    console.log(JSON.stringify({
      ok: true,
      skill: SKILL_NAME,
      version: VERSION,
      capability_matrix: loadCapabilityMatrix()
    }, null, 2));
    return;
  }

  const request = normalizeRequest(args);
  const outDir = resolveOutDir(request, args);
  fs.mkdirSync(outDir, { recursive: true });

  const warnings = [];
  const route = decideRoute(request);
  const execution = assessExecution(request, route);
  const outputs = {};

  if (request.input?.path) {
    const inputPath = resolveMaybeRelative(request.input.path);
    if (!fs.existsSync(inputPath)) {
      warnings.push(`input_missing:${request.input.path}`);
    }
  }

  let editPlan = null;
  let editPlanPath = null;
  let status = route.kind === "semantic" ? "planned" : "routed";

  if (execution.requires_plan) {
    editPlan = createSemanticEditPlan(request, route);
    editPlanPath = path.join(outDir, "edit-plan.json");
    writeJson(editPlanPath, editPlan);
    outputs.editPlan = editPlanPath;

    if (editPlan.recommended_route === "blocked") {
      status = "blocked";
      warnings.push(`semantic_blocked:${editPlan.execution.fallback}`);
    }
  }

  const capabilityReportPath = path.join(outDir, "capability-report.json");
  outputs.capabilityReport = capabilityReportPath;
  const capabilityReport = buildCapabilityReport({
    request,
    route,
    execution,
    editPlan,
    status,
    warnings,
    outDir
  });
  writeJson(capabilityReportPath, capabilityReport);

  if (args.preflight) {
    console.log(JSON.stringify({
      ok: true,
      status,
      route: route.name,
      out_dir: outDir,
      capability_report: capabilityReportPath,
      will_execute: capabilityReport.will_execute,
      selected_capability: capabilityReport.selected_capability.name,
      warnings
    }, null, 2));
    return;
  }

  if (status !== "blocked") {
    const moduleResult = runSelectedModule(route, request, outDir, editPlan, editPlanPath);
    execution.module_status = moduleResult.module_status;
    execution.next_module = moduleResult.next_module;
    if (moduleResult.selected_route) execution.selected_route = moduleResult.selected_route;
    if (moduleResult.outputs) Object.assign(outputs, moduleResult.outputs);
    if (moduleResult.warnings?.length) warnings.push(...moduleResult.warnings);
    if (moduleResult.status) status = moduleResult.status;
  }

  const manifestPath = path.join(outDir, "manifest.json");
  outputs.manifest = manifestPath;
  const qaReportPath = path.join(outDir, "qa-report.json");
  outputs.qaReport = qaReportPath;

  const manifest = {
    skill: SKILL_NAME,
    version: VERSION,
    created_at: new Date().toISOString(),
    status,
    request,
    route,
    execution,
    outputs,
    warnings
  };

  const qaReport = buildQaReport({
    status,
    request,
    route,
    execution,
    outputs,
    warnings,
    manifestPath
  });
  writeJson(qaReportPath, qaReport);
  writeJson(manifestPath, manifest);

  console.log(JSON.stringify({
    ok: status !== "failed",
    status,
    route: route.name,
    out_dir: outDir,
    manifest: manifestPath,
    edit_plan: outputs.editPlan || null,
    warnings
  }, null, 2));
  if (status === "failed") process.exit(1);
}

function parseArgs(argv) {
  const args = {
    input: null,
    mode: null,
    intent: null,
    operation: null,
    outDir: null,
    name: null,
    template: null,
    preflight: false,
    capabilities: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--mode") {
      args.mode = takeValue(argv, ++i, token);
    } else if (token === "--intent") {
      args.intent = takeValue(argv, ++i, token);
    } else if (token === "--operation") {
      args.operation = takeValue(argv, ++i, token);
    } else if (token === "--out-dir") {
      args.outDir = takeValue(argv, ++i, token);
    } else if (token === "--name") {
      args.name = takeValue(argv, ++i, token);
    } else if (token === "--template") {
      args.template = takeValue(argv, ++i, token);
    } else if (token === "--preflight") {
      args.preflight = true;
    } else if (token === "--capabilities") {
      args.capabilities = true;
    } else if (token === "--help" || token === "-h") {
      printHelpAndExit();
    } else if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    } else if (!args.input) {
      args.input = token;
    } else {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
  }

  return args;
}

function takeValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function printHelpAndExit() {
  console.log(`Usage: node scripts/pdf-author-editor.mjs <input|request.json> [--mode auto|author|modify|semantic] [--template <id>] [--out-dir <dir>] [--preflight]
       node scripts/pdf-author-editor.mjs --capabilities`);
  process.exit(0);
}

function normalizeRequest(args) {
  let request = {};
  let requestBaseDir = null;
  let loadedRequestEnvelope = false;

  if (args.input && isJsonPath(args.input)) {
    const requestPath = resolveMaybeRelative(args.input);
    requestBaseDir = path.dirname(requestPath);
    const parsed = readJson(requestPath);
    if (looksLikeRequest(parsed)) {
      request = parsed;
      loadedRequestEnvelope = true;
    } else {
      request = {
        mode: "author",
        intent: "Render structured content as PDF.",
        input: {
          path: args.input,
          type: "json"
        }
      };
    }
  } else if (args.input) {
    request = {
      mode: "auto",
      intent: args.intent || "",
      input: {
        path: args.input,
        type: inferInputType(args.input)
      }
    };
  }

  if (!request.mode) request.mode = "auto";
  if (args.mode) request.mode = args.mode;
  if (args.intent) request.intent = args.intent;
  if (args.operation) request.operation = args.operation;

  if (!request.input && args.input && !loadedRequestEnvelope) {
    request.input = {
      path: args.input,
      type: inferInputType(args.input)
    };
  }

  if (!request.intent) request.intent = "";
  if (!request.options) request.options = {};
  if (args.name) request.options.name = args.name;
  if (args.template) request.options.template = args.template;
  if (args.outDir) request.options.output_dir = args.outDir;

  validateBasicRequest(request);
  normalizeInputObject(request);
  resolveRequestRelativePaths(request, requestBaseDir);
  loadReadPdfInput(request);

  return request;
}

function looksLikeRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Boolean(
    value.mode ||
    value.intent ||
    value.input ||
    value.operation ||
    value.actions ||
    value.changes ||
    value.read_pdf_result
  );
}

function validateBasicRequest(request) {
  const allowedModes = new Set(["auto", "author", "modify", "semantic"]);
  if (!allowedModes.has(request.mode)) {
    throw new Error(`Invalid mode: ${request.mode}`);
  }
}

function normalizeInputObject(request) {
  if (typeof request.input === "string") {
    request.input = {
      path: request.input,
      type: inferInputType(request.input)
    };
  }
  if (request.input && !request.input.type) {
    request.input.type = inferInputType(request.input.path || "");
  }
}

function resolveRequestRelativePaths(request, baseDir) {
  if (!baseDir) return;
  if (request.input?.path && !path.isAbsolute(request.input.path)) {
    request.input.path = path.resolve(baseDir, request.input.path);
  }
  if (Array.isArray(request.inputs)) {
    request.inputs = request.inputs.map((item) => {
      if (typeof item === "string") return path.isAbsolute(item) ? item : path.resolve(baseDir, item);
      if (item && typeof item === "object" && item.path && !path.isAbsolute(item.path)) {
        return { ...item, path: path.resolve(baseDir, item.path) };
      }
      return item;
    });
  }
}

function loadReadPdfInput(request) {
  if (request.read_pdf_result) return;
  if (request.input?.type !== "read-pdf-json") return;
  if (!request.input.path || !fs.existsSync(request.input.path)) return;
  request.read_pdf_result = readJson(request.input.path);
}

function decideRoute(request) {
  const explicit = routeFromExplicitMode(request);
  if (explicit) return explicit;

  const operation = lower(request.operation || "");
  if (operation) {
    if (isPageOpsOperation(operation)) return route("modify", "modify.page_ops", "operation");
    if (isOverlayOperation(operation)) return route("modify", "modify.overlay", "operation");
    if (isSemanticOperation(operation)) return route("semantic", "semantic.edit_plan", "operation");
    if (operation === "author") return route("author", "author", "operation");
  }

  const inputType = lower(request.input?.type || "");
  const intent = lower(request.intent || "");

  if (inputType === "pdf") {
    if (matchesAny(intent, semanticKeywords())) return route("semantic", "semantic.edit_plan", "intent");
    if (matchesAny(intent, overlayKeywords())) return route("modify", "modify.overlay", "intent");
    if (matchesAny(intent, pageOpsKeywords())) return route("modify", "modify.page_ops", "intent");
    return route("modify", "modify.page_ops", "pdf_default");
  }

  if (matchesAny(intent, semanticKeywords())) return route("semantic", "semantic.edit_plan", "intent");
  if (matchesAny(intent, overlayKeywords())) return route("modify", "modify.overlay", "intent");
  if (matchesAny(intent, pageOpsKeywords())) return route("modify", "modify.page_ops", "intent");

  return route("author", "author", "default");
}

function routeFromExplicitMode(request) {
  const mode = lower(request.mode || "auto");
  if (mode === "auto") return null;
  if (mode === "author") return route("author", "author", "explicit_mode");
  if (mode === "semantic") return route("semantic", "semantic.edit_plan", "explicit_mode");
  if (mode === "modify") {
    const operation = lower(request.operation || "");
    if (isOverlayOperation(operation)) return route("modify", "modify.overlay", "explicit_mode");
    return route("modify", "modify.page_ops", "explicit_mode");
  }
  return null;
}

function assessExecution(request, routeInfo) {
  const execution = {
    requires_plan: routeInfo.kind === "semantic",
    selected_route: routeInfo.name,
    complexity: routeInfo.kind === "semantic" ? "high" : "low",
    module_status: "pending"
  };

  if (routeInfo.name === "modify.overlay") execution.complexity = "medium";
  if (request.operation === "rebuild") execution.selected_route = "semantic.rebuild";
  if (request.operation === "short_text_edit") execution.selected_route = "semantic.short_text_edit";
  if (request.operation === "overlay_edit") execution.selected_route = "semantic.overlay_edit";

  return execution;
}

function createSemanticEditPlan(request, routeInfo) {
  const inputPath = request.input?.path || "";
  const sourcePdf = request.read_pdf_result?.source_pdf || (inferInputType(inputPath) === "pdf" ? inputPath : null);
  const changes = normalizeChanges(request);
  const hasReadPdf = Boolean(request.read_pdf_result);
  const hasStructuredContent = Boolean(request.structured_content || request.revised_content || request.content);
  const allTargeted = changes.length > 0 && changes.every((change) => change.target_text && change.replacement_text);

  const shortTextAllowed = allTargeted && changes.every((change) => fitsOriginalBox(change));
  const overlayAllowed = allTargeted;
  const rebuildAllowed = hasReadPdf || hasStructuredContent;

  const explicitOperation = lower(request.operation || "");
  let recommended = "blocked";
  let fallback = "semantic_input_missing";

  if (explicitOperation === "short_text_edit") {
    if (shortTextAllowed) {
      recommended = "short_text_edit";
      fallback = "blocked_if_target_cannot_be_located";
    }
  } else if (explicitOperation === "overlay_edit") {
    if (overlayAllowed) {
      recommended = "overlay_edit";
      fallback = "blocked_if_target_cannot_be_located";
    }
  } else if (explicitOperation === "rebuild") {
    if (rebuildAllowed) {
      recommended = "rebuild";
      fallback = "blocked_if_rebuild_content_missing";
    }
  } else if (matchesAny(lower(request.intent || ""), ["rebuild", "regenerate", "rewrite", unicode("91cd5199")])) {
    if (rebuildAllowed) {
      recommended = "rebuild";
      fallback = "blocked_if_rebuild_content_missing";
    }
  } else if (shortTextAllowed) {
    recommended = "short_text_edit";
    fallback = "blocked_if_target_cannot_be_located";
  } else if (rebuildAllowed) {
    recommended = "rebuild";
    fallback = "blocked_if_rebuild_content_missing";
  } else if (overlayAllowed) {
    recommended = "overlay_edit";
    fallback = "blocked_if_target_cannot_be_located";
  }

  const routesConsidered = [
    {
      route: "short_text_edit",
      allowed: shortTextAllowed,
      reason: shortTextAllowed
        ? "target and replacement are present and replacement is short enough for a local edit"
        : "requires unique target text and a replacement that fits the original text box"
    },
    {
      route: "overlay_edit",
      allowed: overlayAllowed,
      reason: overlayAllowed
        ? "target and replacement are present, so a visible overlay can be attempted"
        : "requires target text and replacement text"
    },
    {
      route: "rebuild",
      allowed: rebuildAllowed,
      reason: rebuildAllowed
        ? "structured read-pdf or revised content is available"
        : "requires read-pdf result or revised structured content"
    },
    {
      route: "blocked",
      allowed: recommended === "blocked",
      reason: recommended === "blocked"
        ? "no reliable execution route is available with current inputs"
        : "an executable route was selected"
    }
  ];

  return {
    mode: "semantic",
    source_pdf: sourcePdf,
    user_intent: request.intent || routeInfo.name,
    document_assessment: {
      pdf_type: request.read_pdf_result?.pdf_type || (sourcePdf ? "unknown_pdf" : "not_pdf"),
      layout_complexity: estimateLayoutComplexity(request, changes),
      requires_read_pdf: Boolean(sourcePdf && !hasReadPdf),
      confidence: Number.isFinite(request.read_pdf_result?.confidence) ? request.read_pdf_result.confidence : null
    },
    changes,
    recommended_route: recommended,
    routes_considered: routesConsidered,
    execution: {
      plan_required: true,
      auto_execute: recommended !== "blocked",
      fallback
    }
  };
}

function normalizeChanges(request) {
  if (Array.isArray(request.changes)) {
    return request.changes.map((change, index) => normalizeChange(change, index));
  }

  if (request.target_text || request.replacement_text) {
    return [normalizeChange({
      kind: "text_replace",
      target_text: request.target_text,
      replacement_text: request.replacement_text,
      pages: request.pages
    }, 0)];
  }

  return [];
}

function normalizeChange(change, index) {
  const normalized = {
    id: change.id || `chg-${String(index + 1).padStart(3, "0")}`,
    kind: change.kind || "text_replace",
    target_text: change.target_text || change.target || null,
    replacement_text: change.replacement_text || change.replacement || null,
    pages: Array.isArray(change.pages) ? change.pages : [],
    occurrence: change.occurrence ?? change.match_index ?? null,
    match_index: change.match_index ?? null,
    match_mode: change.match_mode || "auto",
    allow_multiple: Boolean(change.allow_multiple),
    page: change.page ?? null,
    rect: Array.isArray(change.rect) ? change.rect : null,
    complexity: change.complexity || estimateChangeComplexity(change),
    reason: change.reason || "planned semantic PDF change"
  };

  return normalized;
}

function estimateChangeComplexity(change) {
  const target = change.target_text || change.target || "";
  const replacement = change.replacement_text || change.replacement || "";
  if (!target || !replacement) return "high";
  if (replacement.length <= target.length + 8) return "low";
  if (replacement.length <= target.length * 1.5 + 12) return "medium";
  return "high";
}

function estimateLayoutComplexity(request, changes) {
  if (request.read_pdf_result?.layout_complexity) return request.read_pdf_result.layout_complexity;
  if (changes.some((change) => change.complexity === "high")) return "high";
  if (changes.length > 1) return "medium";
  return "unknown";
}

function fitsOriginalBox(change) {
  const target = change.target_text || "";
  const replacement = change.replacement_text || "";
  if (!target || !replacement) return false;
  return replacement.length <= Math.max(target.length + 8, Math.ceil(target.length * 1.25));
}

function runSelectedModule(routeInfo, request, outDir, editPlan = null, editPlanPath = null) {
  if (routeInfo.kind === "author") {
    return runAuthorModule(request, outDir);
  }
  if (routeInfo.kind === "modify") {
    return runModifyModule(routeInfo, request, outDir);
  }
  return runSemanticModule(routeInfo, request, outDir, editPlan, editPlanPath);
}

function runAuthorModule(request, outDir) {
  const inputPath = request.input?.path ? resolveMaybeRelative(request.input.path) : null;
  const nextModule = "scripts/author/render.mjs";
  if (!inputPath || !fs.existsSync(inputPath)) {
    return {
      status: "blocked",
      module_status: "blocked",
      next_module: nextModule,
      outputs: {},
      warnings: [`author_input_missing:${request.input?.path || "(none)"}`]
    };
  }

  const authorManifest = path.join(outDir, "author-render-manifest.json");
  const args = [
    path.join(SKILL_DIR, nextModule),
    inputPath,
    "--out-dir",
    outDir,
    "--manifest",
    authorManifest,
    "--name",
    sanitizeName(request.options?.name || path.basename(inputPath, path.extname(inputPath)))
  ];

  const deliveryType = request.delivery_type || request.options?.delivery_type || request.type;
  if (deliveryType && deliveryType !== "auto") args.push("--type", deliveryType);
  const templateId = request.template || request.options?.template || request.theme?.template;
  if (templateId) args.push("--template", templateId);
  if (request.options?.allow_remote_assets === true || request.allow_remote_assets === true) {
    args.push("--allow-remote-assets");
  }
  if (request.options?.pdf === false || request.pdf === false) {
    args.push("--no-pdf");
  } else {
    args.push("--pdf");
  }

  const nodeExecutable = resolveNodeExecutable();
  const result = spawnSync(nodeExecutable, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: buildChildEnv(),
    windowsHide: true
  });

  const outputs = { authorManifest };
  const warnings = [];
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (stdout) {
    const parsed = parseJsonMaybe(stdout);
    if (parsed) {
      if (parsed.html) outputs.sourceHtml = parsed.html;
      if (parsed.pdf) outputs.pdf = parsed.pdf;
      if (parsed.manifest) outputs.authorManifest = parsed.manifest;
    }
  }

  if (fs.existsSync(authorManifest)) {
    const renderManifest = readJson(authorManifest);
    const renderOutputs = renderManifest.outputs || {};
    if (renderOutputs.html) outputs.sourceHtml = renderOutputs.html;
    if (renderOutputs.pdf) outputs.pdf = renderOutputs.pdf;
    if (renderOutputs.htmlQa) outputs.htmlQa = renderOutputs.htmlQa;
    if (renderOutputs.pdfQa) outputs.pdfQa = renderOutputs.pdfQa;
    if (renderOutputs.screenshot) outputs.screenshot = renderOutputs.screenshot;
    if (renderOutputs.preview) outputs.preview = renderOutputs.preview;
  }

  if (result.status !== 0) {
    warnings.push(`author_module_failed:${stderr || stdout || result.status}`);
    return {
      status: "failed",
      module_status: "failed",
      next_module: nextModule,
      outputs,
      warnings
    };
  }

  return {
    status: "success",
    module_status: "success",
    next_module: nextModule,
    outputs,
    warnings
  };
}

function runModifyModule(routeInfo, request, outDir) {
  const nextModule = "scripts/modify/modify-pdf.py";
  const requestPath = path.join(outDir, "modify-request.json");
  writeJson(requestPath, request);

  const args = [
    path.join(SKILL_DIR, nextModule),
    requestPath,
    "--out-dir",
    outDir
  ];

  const pythonExecutable = resolvePythonExecutable();
  const result = spawnSync(pythonExecutable, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: buildChildEnv(),
    windowsHide: true
  });

  const outputs = {
    modifyRequest: requestPath,
    modifyResult: path.join(outDir, "modify-result.json")
  };
  const warnings = [];
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const parsed = parseJsonMaybe(stdout) || (fs.existsSync(outputs.modifyResult) ? readJson(outputs.modifyResult) : null);

  if (parsed) {
    if (parsed.output) outputs.pdf = parsed.output;
    if (parsed.qa) outputs.pdfQa = parsed.qa;
    if (parsed.preview) outputs.preview = parsed.preview;
    if (Array.isArray(parsed.outputs)) outputs.pdfs = parsed.outputs;
    if (Array.isArray(parsed.part_checks)) {
      outputs.partChecks = parsed.part_checks;
    }
  }

  if (result.status !== 0) {
    warnings.push(`modify_module_failed:${stderr || stdout || result.status}`);
    return {
      status: "failed",
      module_status: "failed",
      next_module: nextModule,
      selected_route: routeInfo.name,
      outputs,
      warnings
    };
  }

  return {
    status: "success",
    module_status: "success",
    next_module: nextModule,
    selected_route: routeInfo.name,
    outputs,
    warnings
  };
}

function runSemanticModule(routeInfo, request, outDir, editPlan, editPlanPath) {
  const nextModule = "scripts/semantic/semantic-edit.py";
  const requestPath = path.join(outDir, "semantic-request.json");
  const semanticResultPath = path.join(outDir, "semantic-result.json");
  writeJson(requestPath, request);

  if (!editPlanPath || !fs.existsSync(editPlanPath)) {
    return {
      status: "blocked",
      module_status: "blocked",
      next_module: nextModule,
      selected_route: routeInfo.name,
      outputs: {
        semanticRequest: requestPath,
        semanticResult: semanticResultPath
      },
      warnings: ["semantic_edit_plan_missing"]
    };
  }

  const args = [
    path.join(SKILL_DIR, nextModule),
    requestPath,
    editPlanPath,
    "--out-dir",
    outDir
  ];

  const pythonExecutable = resolvePythonExecutable();
  const result = spawnSync(pythonExecutable, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: buildChildEnv(),
    windowsHide: true
  });

  const outputs = {
    semanticRequest: requestPath,
    semanticResult: semanticResultPath
  };
  const warnings = [];
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const parsed = parseJsonMaybe(stdout) || (fs.existsSync(semanticResultPath) ? readJson(semanticResultPath) : null);

  if (parsed) {
    if (parsed.output) outputs.pdf = parsed.output;
    if (parsed.qa) outputs.pdfQa = parsed.qa;
    if (parsed.qa_summary) outputs.pdfQaSummary = parsed.qa_summary;
    if (parsed.preview) outputs.preview = parsed.preview;
    if (parsed.rebuild_source) outputs.rebuildSource = parsed.rebuild_source;
    if (parsed.verification) outputs.semanticVerification = parsed.verification;
    if (parsed.verification_summary) outputs.semanticVerificationSummary = parsed.verification_summary;
    if (parsed.visual_diff) outputs.semanticVisualDiff = parsed.visual_diff;
    if (parsed.visual_diff_summary) outputs.semanticVisualDiffSummary = parsed.visual_diff_summary;
  }

  if (result.status !== 0) {
    warnings.push(`semantic_module_failed:${stderr || stdout || result.status}`);
    return {
      status: "failed",
      module_status: "failed",
      next_module: nextModule,
      selected_route: routeInfo.name,
      outputs,
      warnings
    };
  }

  if (parsed?.status === "blocked") {
    warnings.push(`semantic_blocked:${parsed.reason || "blocked"}`);
    return {
      status: "blocked",
      module_status: "blocked",
      next_module: nextModule,
      selected_route: `semantic.${editPlan?.recommended_route || "blocked"}`,
      outputs,
      warnings
    };
  }

  if (parsed?.status === "rebuild_ready" && parsed.rebuild_source) {
    const authorRequest = {
      ...request,
      mode: "author",
      input: {
        path: parsed.rebuild_source,
        type: "json"
      },
      options: {
        ...(request.options || {}),
        name: sanitizeName(request.options?.name || "semantic-rebuild")
      }
    };
    const authorResult = runAuthorModule(authorRequest, outDir);
    if (authorResult.outputs) Object.assign(outputs, authorResult.outputs);
    if (authorResult.warnings?.length) warnings.push(...authorResult.warnings);
    return {
      status: authorResult.status,
      module_status: authorResult.module_status,
      next_module: `${nextModule} -> scripts/author/render.mjs`,
      selected_route: "semantic.rebuild",
      outputs,
      warnings
    };
  }

  return {
    status: "success",
    module_status: "success",
    next_module: nextModule,
    selected_route: `semantic.${parsed?.operation || editPlan?.recommended_route || "edit"}`,
    outputs,
    warnings
  };
}

function resolveNodeExecutable() {
  const dependencyRoot = resolveBundledDependencyRoot();
  const candidates = [
    process.env.PDF_AUTHOR_EDITOR_NODE,
    dependencyRoot ? path.join(dependencyRoot, "node", "bin", process.platform === "win32" ? "node.exe" : "node") : null,
    process.execPath
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || process.execPath;
}

function resolvePythonExecutable() {
  const dependencyRoot = resolveBundledDependencyRoot();
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const candidates = [
    process.env.PDF_AUTHOR_EDITOR_PYTHON,
    process.env.PYTHON,
    dependencyRoot ? path.join(dependencyRoot, "python", process.platform === "win32" ? "python.exe" : "bin/python") : null,
    localAppData ? path.join(localAppData, "Programs", "Python", "Python312", "python.exe") : null,
    localAppData ? path.join(localAppData, "Programs", "Python", "Python311", "python.exe") : null,
    localAppData ? path.join(localAppData, "Programs", "Python", "Python310", "python.exe") : null,
    programFiles ? path.join(programFiles, "Python312", "python.exe") : null,
    programFiles ? path.join(programFiles, "Python311", "python.exe") : null,
    programFilesX86 ? path.join(programFilesX86, "Python312", "python.exe") : null,
    "python"
  ].filter(Boolean);
  return candidates.find(isPythonUsable) || "python";
}

function isPythonUsable(candidate) {
  if (candidate !== "python" && !fs.existsSync(candidate)) return false;
  const result = spawnSync(candidate, ["-c", "import sys; print(sys.version_info[0])"], {
    encoding: "utf8",
    windowsHide: true
  });
  return !result.error && result.status === 0;
}

function buildChildEnv() {
  const env = { ...process.env };
  env.PYTHONDONTWRITEBYTECODE = "1";
  const dependencyRoot = resolveBundledDependencyRoot();
  if (!dependencyRoot) return env;

  const nodeModules = path.join(dependencyRoot, "node", "node_modules");
  const pnpmModules = path.join(nodeModules, ".pnpm", "node_modules");
  const appRoot = path.resolve(dependencyRoot, "..");
  const resourceNodeModules = path.join(appRoot, "resources", "node_modules");
  const resourceAppNodeModules = path.join(appRoot, "resources", "app", "node_modules");
  const python = path.join(dependencyRoot, "python", process.platform === "win32" ? "python.exe" : "bin/python");
  const nativeBin = path.join(dependencyRoot, "bin");

  const nodePathParts = [
    env.NODE_PATH,
    fs.existsSync(nodeModules) ? nodeModules : null,
    fs.existsSync(pnpmModules) ? pnpmModules : null,
    fs.existsSync(resourceNodeModules) ? resourceNodeModules : null,
    fs.existsSync(resourceAppNodeModules) ? resourceAppNodeModules : null
  ].filter(Boolean);
  env.NODE_PATH = nodePathParts.join(path.delimiter);

  if (!env.PYTHON && fs.existsSync(python)) env.PYTHON = python;
  if (fs.existsSync(nativeBin)) env.PATH = `${nativeBin}${path.delimiter}${env.PATH || ""}`;

  return env;
}

function resolveBundledDependencyRoot() {
  const execDir = process.execPath ? path.dirname(process.execPath) : "";
  const candidates = [
    process.env.PDF_AUTHOR_EDITOR_DEPENDENCIES,
    process.env.XIAOBA_RUNTIME_DEPENDENCIES,
    process.env.XIAOBA_RUNTIME_DIR,
    process.env.CATSCO_RUNTIME_DIR,
    execDir ? path.resolve(execDir, "..") : null,
    execDir ? path.resolve(execDir, "..", "..") : null,
    execDir ? path.join(execDir, "runtime") : null,
    execDir ? path.resolve(execDir, "..", "runtime") : null,
    process.env.PORTABLE_EXECUTABLE_DIR ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, "runtime") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "CatsCo", "runtime") : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "CatsCo", "runtime") : null,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "CatsCo", "runtime") : null,
    path.join(os.homedir(), "AppData", "Local", "Programs", "CatsCo", "runtime")
  ].filter(Boolean);
  const seen = new Set();
  return candidates
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => {
      const key = candidate.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .find(isDependencyRoot) || null;
}

function isDependencyRoot(candidate) {
  if (!candidate || !fs.existsSync(candidate)) return false;
  return fs.existsSync(path.join(candidate, "node", "node_modules"))
    || fs.existsSync(path.join(candidate, "python", process.platform === "win32" ? "python.exe" : "bin/python"));
}

function loadCapabilityMatrix() {
  return readJson(CAPABILITY_MATRIX_PATH);
}

function buildCapabilityReport({ request, route, execution, editPlan, status, warnings, outDir }) {
  const matrix = loadCapabilityMatrix();
  const selectedName = selectedCapabilityName(route, editPlan, status);
  const capability = matrix.routes.find((item) => item.name === selectedName)
    || matrix.routes.find((item) => item.name === route.name)
    || matrix.routes.find((item) => item.name === "blocked");

  const willExecute = status !== "blocked" && capability?.execution !== "no_execution";
  return {
    skill: SKILL_NAME,
    version: VERSION,
    matrix_version: matrix.version,
    mode: "capability_report",
    status,
    will_execute: willExecute,
    evaluation: {
      depth: "route_and_capability",
      file_content_checked: false,
      declared_blocked_conditions: true
    },
    route,
    selected_capability: capability || null,
    execution: {
      selected_route: execution.selected_route,
      module_status: execution.module_status,
      next_module: execution.next_module || null,
      complexity: execution.complexity
    },
    expected_outputs: capability?.outputs || [],
    required_inputs: capability?.required_inputs || [],
    optional_inputs: capability?.optional_inputs || [],
    blocked_conditions: capability?.blocked_conditions || [],
    boundaries: capability?.boundaries || [],
    edit_plan_summary: summarizeEditPlanForCapability(editPlan),
    request_digest: {
      mode: request.mode,
      operation: request.operation || null,
      input_type: request.input?.type || null,
      intent: request.intent || ""
    },
    output_dir: outDir,
    warnings
  };
}

function selectedCapabilityName(routeInfo, editPlan, status) {
  if (status === "blocked") return "blocked";
  if (routeInfo.kind !== "semantic") return routeInfo.name;
  const recommended = editPlan?.recommended_route;
  if (!recommended || recommended === "blocked") return "blocked";
  return `semantic.${recommended}`;
}

function summarizeEditPlanForCapability(editPlan) {
  if (!editPlan) return null;
  return {
    recommended_route: editPlan.recommended_route,
    changes: Array.isArray(editPlan.changes) ? editPlan.changes.length : 0,
    routes_considered: Array.isArray(editPlan.routes_considered)
      ? editPlan.routes_considered.map((item) => ({
        route: item.route,
        allowed: item.allowed,
        reason: item.reason
      }))
      : [],
    fallback: editPlan.execution?.fallback || null
  };
}

function buildQaReport({ status, request, route, execution, outputs, warnings, manifestPath }) {
  const htmlQa = readJsonIfExists(outputs.htmlQa);
  const pdfQa = readJsonIfExists(outputs.pdfQa);
  const authorManifest = readJsonIfExists(outputs.authorManifest);
  const modifyResult = readJsonIfExists(outputs.modifyResult);
  const semanticResult = readJsonIfExists(outputs.semanticResult);
  const semanticVerification = readJsonIfExists(outputs.semanticVerification);
  const semanticVisualDiff = readJsonIfExists(outputs.semanticVisualDiff);
  const capabilityReport = readJsonIfExists(outputs.capabilityReport);

  const checks = [];
  checks.push(checkItem("manifest_path_assigned", Boolean(manifestPath), manifestPath));
  checks.push(checkItem("outputs_outside_skill_folder", outputsOutsideSkillFolder(outputs), "all output paths should stay outside the skill folder"));

  if (outputs.sourceHtml) {
    checks.push(checkItem("source_html_exists", fs.existsSync(outputs.sourceHtml), outputs.sourceHtml));
  }
  if (outputs.capabilityReport) {
    checks.push(checkItem("capability_report_exists", fs.existsSync(outputs.capabilityReport), outputs.capabilityReport));
  }
  if (outputs.pdf) {
    checks.push(checkItem("pdf_exists", fs.existsSync(outputs.pdf), outputs.pdf));
  }
  if (outputs.preview) {
    checks.push(checkItem("preview_exists", fs.existsSync(outputs.preview), outputs.preview));
  }
  if (outputs.htmlQa) {
    checks.push(checkItem("html_qa_ok", Boolean(htmlQa?.ok), outputs.htmlQa, htmlQa?.errors, htmlQa?.warnings));
  }
  if (outputs.pdfQa) {
    checks.push(checkItem("pdf_qa_ok", Boolean(pdfQa?.ok), outputs.pdfQa, pdfQa?.errors, pdfQa?.warnings));
  }
  if (Array.isArray(outputs.partChecks)) {
    for (const [index, part] of outputs.partChecks.entries()) {
      checks.push(checkItem(`split_part_${index + 1}_pdf_exists`, fs.existsSync(part.pdf || ""), part.pdf));
      checks.push(checkItem(`split_part_${index + 1}_qa_ok`, Boolean(part.qa?.ok), part.qaPath || part.qa, part.qa?.errors, part.qa?.warnings));
      checks.push(checkItem(`split_part_${index + 1}_preview_exists`, fs.existsSync(part.preview || ""), part.preview));
    }
  }
  if (semanticVerification) {
    checks.push(checkItem("semantic_verification_ok", Boolean(semanticVerification.ok), outputs.semanticVerification, semanticVerification.errors, semanticVerification.warnings));
  }
  if (semanticVisualDiff) {
    const changedRegions = Number(semanticVisualDiff.summary?.regions_with_change || 0);
    checks.push(checkItem("semantic_visual_diff_has_change", changedRegions > 0, outputs.semanticVisualDiff, [], changedRegions > 0 ? [] : ["no_changed_regions"]));
  }

  const failedChecks = checks.filter((item) => item.status === "fail");
  const warningChecks = checks.filter((item) => item.warnings.length > 0);
  const reportWarnings = [...warnings, ...warningChecks.flatMap((item) => item.warnings.map((warning) => `${item.name}:${warning}`))];

  return {
    skill: SKILL_NAME,
    version: VERSION,
    status,
    ok: status !== "failed" && failedChecks.length === 0,
    route,
    execution: {
      selected_route: execution.selected_route,
      module_status: execution.module_status,
      next_module: execution.next_module,
      complexity: execution.complexity
    },
    summary: {
      checks: checks.length,
      failed_checks: failedChecks.length,
      warnings: reportWarnings.length,
      html_ok: htmlQa ? Boolean(htmlQa.ok) : null,
      pdf_ok: pdfQa ? Boolean(pdfQa.ok) : null,
      pdf_pages: pdfQa?.page_count ?? null,
      semantic_ok: semanticVerification ? Boolean(semanticVerification.ok) : null,
      visual_regions: semanticVisualDiff?.summary?.region_count ?? null,
      changed_visual_regions: semanticVisualDiff?.summary?.regions_with_change ?? null
    },
    artifacts: collectQaArtifacts(outputs, { htmlQa, pdfQa, authorManifest, modifyResult, semanticResult, semanticVerification, semanticVisualDiff, capabilityReport }),
    checks,
    warnings: reportWarnings,
    request_digest: {
      mode: request.mode,
      operation: request.operation || null,
      input_type: request.input?.type || null,
      intent: request.intent || ""
    },
    manifest: manifestPath
  };
}

function checkItem(name, ok, detail = null, errors = [], warnings = []) {
  return {
    name,
    status: ok ? "pass" : "fail",
    detail,
    errors: normalizeMessageList(errors),
    warnings: normalizeMessageList(warnings)
  };
}

function normalizeMessageList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}

function collectQaArtifacts(outputs, parsed) {
  const artifacts = {
    manifest: outputs.manifest || null,
    qaReport: outputs.qaReport || null,
    html: outputs.sourceHtml || null,
    pdf: outputs.pdf || null,
    preview: outputs.preview || null,
    screenshot: outputs.screenshot || null,
    htmlQa: outputs.htmlQa || null,
    pdfQa: outputs.pdfQa || null,
    authorManifest: outputs.authorManifest || null,
    capabilityReport: outputs.capabilityReport || null,
    modifyResult: outputs.modifyResult || null,
    semanticResult: outputs.semanticResult || null,
    semanticVerification: outputs.semanticVerification || null,
    semanticVisualDiff: outputs.semanticVisualDiff || null,
    rebuildSource: outputs.rebuildSource || null,
    splitParts: Array.isArray(outputs.partChecks) ? outputs.partChecks : []
  };

  if (parsed.pdfQa) {
    artifacts.pdfSummary = {
      page_count: parsed.pdfQa.page_count,
      blank_pages: parsed.pdfQa.blank_pages || [],
      errors: parsed.pdfQa.errors || [],
      warnings: parsed.pdfQa.warnings || []
    };
  }
  if (parsed.semanticVerification) {
    artifacts.semanticSummary = {
      mode: parsed.semanticVerification.mode,
      errors: parsed.semanticVerification.errors || [],
      warnings: parsed.semanticVerification.warnings || []
    };
  }
  if (parsed.semanticVisualDiff) {
    artifacts.visualSummary = parsed.semanticVisualDiff.summary || null;
  }
  if (parsed.modifyResult?.result) {
    artifacts.modifySummary = parsed.modifyResult.result;
  }
  if (parsed.authorManifest?.outputs) {
    artifacts.authorOutputs = parsed.authorManifest.outputs;
  }
  if (parsed.capabilityReport?.selected_capability) {
    artifacts.capabilitySummary = {
      name: parsed.capabilityReport.selected_capability.name,
      will_execute: parsed.capabilityReport.will_execute,
      expected_outputs: parsed.capabilityReport.expected_outputs || []
    };
  }
  return artifacts;
}

function outputsOutsideSkillFolder(outputs) {
  const paths = [];
  collectPathValues(outputs, paths);
  return paths.every((item) => !isInsidePath(item, SKILL_DIR));
}

function collectPathValues(value, paths) {
  if (!value) return;
  if (typeof value === "string") {
    if (looksLikePath(value)) paths.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathValues(item, paths);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectPathValues(item, paths);
  }
}

function looksLikePath(value) {
  return /[\\/]/.test(value) || /\.(pdf|png|html|json)$/i.test(value);
}

function isInsidePath(value, parent) {
  const resolved = path.resolve(value);
  const relative = path.relative(parent, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function route(kind, name, reason) {
  return { kind, name, reason };
}

function isPageOpsOperation(operation) {
  return ["page_ops", "merge", "split", "delete", "delete_pages", "rotate", "rotate_pages", "reorder", "reorder_pages", "extract", "extract_pages"].includes(operation);
}

function isOverlayOperation(operation) {
  return ["overlay", "watermark", "stamp", "page_number", "highlight", "note", "annotation", "cover_box"].includes(operation);
}

function isSemanticOperation(operation) {
  return ["semantic", "short_text_edit", "overlay_edit", "rebuild"].includes(operation);
}

function pageOpsKeywords() {
  return [
    "merge",
    "split",
    "delete page",
    "remove page",
    "rotate",
    "reorder",
    "extract page",
    unicode("5220"),       // delete/remove
    unicode("5408"),       // merge/combine
    unicode("65cb8f6c"),   // rotate
    unicode("9875")        // page
  ];
}

function overlayKeywords() {
  return [
    "watermark",
    "stamp",
    "page number",
    "highlight",
    "annotation",
    "note",
    "cover",
    unicode("6c345370"),   // watermark
    unicode("76d67ae0"),   // stamp
    unicode("98757801"),   // page number
    unicode("9ad84eae"),   // highlight
    unicode("62796ce8"),   // annotation
    unicode("906e76d6")    // cover
  ];
}

function semanticKeywords() {
  return [
    "rewrite",
    "replace text",
    "change wording",
    "revise content",
    "make it more formal",
    "entity",
    "owner",
    "status",
    "field",
    "amount",
    "date",
    "regenerate",
    unicode("65396210"),   // change to
    unicode("91cd5199"),   // rewrite
    unicode("66ff6362"),   // replace
    unicode("4f185316"),   // optimize
    unicode("4e3b4f53"),   // entity/subject
    unicode("72b66001"),   // status
    unicode("91d1989d"),   // amount
    unicode("65e5671f")    // date
  ];
}

function matchesAny(text, keywords) {
  return keywords.some((keyword) => text.includes(lower(keyword)));
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function unicode(hex) {
  return String.fromCodePoint(...hex.match(/.{1,4}/g).map((part) => Number.parseInt(part, 16)));
}

function inferInputType(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".json") return "json";
  return "unknown";
}

function isJsonPath(filePath) {
  return path.extname(filePath || "").toLowerCase() === ".json";
}

function resolveMaybeRelative(filePath) {
  if (!filePath) return process.cwd();
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(process.cwd(), filePath);
}

function resolveOutDir(request, args) {
  const requested = request.options?.output_dir || args.outDir;
  if (requested) return resolveMaybeRelative(requested);

  const name = sanitizeName(
    request.options?.name ||
    args.name ||
    (request.input?.path ? path.basename(request.input.path, path.extname(request.input.path)) : "request")
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(process.cwd(), "work", "pdf-author-editor-runs", `${name}-${stamp}`);
}

function sanitizeName(value) {
  return String(value || "request")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "request";
}

function readJson(filePath) {
  try {
    return JSON.parse(stripJsonBom(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    throw new Error(`Failed to read JSON ${filePath}: ${error.message}`);
  }
}

function readJsonIfExists(filePath) {
  if (!filePath || typeof filePath !== "string" || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(stripJsonBom(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function parseJsonMaybe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stripJsonBom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}
