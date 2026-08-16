#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "pdf-author-editor";
const VERSION = "1.2.5";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const WORKSPACE_DIR = process.cwd();

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.outDir || path.join(WORKSPACE_DIR, "work", "pdf-author-editor-runs", `self-test-${stamp()}`));
  const fixtureDir = path.join(outDir, "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const state = {
    skill: SKILL_NAME,
    version: VERSION,
    created_at: new Date().toISOString(),
    out_dir: outDir,
    ok: true,
    summary: {
      steps: 0,
      failed_steps: 0,
      assertions: 0,
      failed_assertions: 0
    },
    artifacts: {
      fixtures: fixtureDir
    },
    steps: [],
    assertions: [],
    notes: []
  };

  const reportPath = path.join(outDir, "self-test-report.json");
  state.artifacts.selfTestReport = reportPath;

  try {
    createFixturePdfs(state, fixtureDir);
    createFixtureRequests(state, fixtureDir);

    const packageCheck = runNodeStep(state, "package_check", [path.join(SKILL_DIR, "scripts", "package-check.mjs")]);
    addAssertion(state, "package_check_ok", packageCheck.exit_code === 0 && parseJson(packageCheck.stdout)?.ok === true, "package-check.mjs should report ok:true");

    const capabilities = runNodeStep(state, "capabilities", [path.join(SKILL_DIR, "scripts", "pdf-author-editor.mjs"), "--capabilities"]);
    const capabilitiesJson = parseJson(capabilities.stdout);
    addAssertion(state, "capabilities_ok", capabilities.exit_code === 0 && capabilitiesJson?.ok === true, "router --capabilities should return JSON");
    addAssertion(state, "capability_route_count", Number(capabilitiesJson?.capability_matrix?.routes?.length || 0) >= 7, "capability matrix should include all core routes");

    const authorDir = path.join(outDir, "author");
    runMainAndCheck(state, "author_report", [path.join(SKILL_DIR, "examples", "author-report-request.json"), "--out-dir", authorDir], {
      expectedRouteKind: "author",
      expectedStatus: "success",
      requirePdf: true,
      requireQaOk: true,
      expectedTemplate: "formal-report"
    });

    const formalDir = path.join(outDir, "author-formal-report");
    runMainAndCheck(state, "author_formal_report", [path.join(SKILL_DIR, "examples", "author-formal-report-request.json"), "--out-dir", formalDir], {
      expectedRouteKind: "author",
      expectedStatus: "success",
      requirePdf: true,
      requireQaOk: true,
      expectedTemplate: "formal-report"
    });

    const briefingDir = path.join(outDir, "author-briefing-note");
    runMainAndCheck(state, "author_briefing_note", [path.join(SKILL_DIR, "examples", "author-briefing-note-request.json"), "--out-dir", briefingDir], {
      expectedRouteKind: "author",
      expectedStatus: "success",
      requirePdf: true,
      requireQaOk: true,
      expectedTemplate: "briefing-note"
    });

    const tablerDir = path.join(outDir, "author-tabler-report");
    runMainAndCheck(state, "author_tabler_report", [path.join(SKILL_DIR, "examples", "author-tabler-report-request.json"), "--out-dir", tablerDir], {
      expectedRouteKind: "author",
      expectedStatus: "success",
      requirePdf: true,
      requireQaOk: true,
      expectedTemplate: "tabler-report"
    });

    const onePagerDir = path.join(outDir, "author-one-pager");
    runMainAndCheck(state, "author_one_pager", [path.join(SKILL_DIR, "examples", "author-one-pager-request.json"), "--out-dir", onePagerDir], {
      expectedRouteKind: "author",
      expectedStatus: "success",
      requirePdf: true,
      requireQaOk: true,
      expectedTemplate: "executive-brief",
      expectedPdfPages: 1
    });

    const modifyDir = path.join(outDir, "modify-merge");
    runMainAndCheck(state, "modify_merge", [path.join(fixtureDir, "modify-merge-request.json"), "--out-dir", modifyDir], {
      expectedRouteKind: "modify",
      expectedStatus: "success",
      requirePdf: true,
      requireQaOk: true,
      expectedPdfPages: 3
    });

    const semanticDir = path.join(outDir, "semantic-normalized");
    runMainAndCheck(state, "semantic_normalized", [path.join(fixtureDir, "semantic-normalized-request.json"), "--out-dir", semanticDir], {
      expectedRouteKind: "semantic",
      expectedStatus: "success",
      requirePdf: true,
      requireQaOk: true,
      requireSemanticVisualDiff: true
    });

    const preflightDir = path.join(outDir, "semantic-ambiguous-preflight");
    const preflight = runNodeStep(state, "semantic_ambiguous_preflight", [
      path.join(SKILL_DIR, "scripts", "pdf-author-editor.mjs"),
      path.join(fixtureDir, "semantic-ambiguous-request.json"),
      "--preflight",
      "--out-dir",
      preflightDir
    ]);
    const preflightJson = parseJson(preflight.stdout);
    const preflightCapability = readJsonIfExists(path.join(preflightDir, "capability-report.json"));
    addAssertion(state, "preflight_exit_ok", preflight.exit_code === 0 && preflightJson?.ok === true, "preflight should return route JSON");
    addAssertion(state, "preflight_capability_report_exists", Boolean(preflightCapability), "preflight should write capability-report.json");
    addAssertion(state, "preflight_skips_manifest", !fs.existsSync(path.join(preflightDir, "manifest.json")), "preflight should skip execution modules");
    addAssertion(
      state,
      "preflight_boundary_lists_duplicate_text",
      Array.isArray(preflightCapability?.blocked_conditions) && preflightCapability.blocked_conditions.includes("target_text_not_unique"),
      "selected capability should declare duplicate target text as a boundary condition"
    );

    const rebuildDir = path.join(outDir, "semantic-rebuild");
    runMainAndCheck(state, "semantic_rebuild", [path.join(SKILL_DIR, "examples", "semantic-rebuild-request.json"), "--out-dir", rebuildDir], {
      expectedRouteKind: "semantic",
      expectedStatus: "success",
      requirePdf: true,
      requireQaOk: true,
      requireRebuildSource: true
    });
  } catch (error) {
    state.ok = false;
    state.notes.push(String(error?.stack || error));
  } finally {
    finalizeState(state);
    writeJson(reportPath, state);
    console.log(JSON.stringify({
      ok: state.ok,
      out_dir: outDir,
      self_test_report: reportPath,
      summary: state.summary
    }, null, 2));
    if (!state.ok) process.exit(1);
  }
}

function runMainAndCheck(state, name, args, expectations) {
  const step = runNodeStep(state, name, [path.join(SKILL_DIR, "scripts", "pdf-author-editor.mjs"), ...args]);
  const stdoutJson = parseJson(step.stdout);
  const runDir = stdoutJson?.out_dir || args[args.indexOf("--out-dir") + 1];
  const manifest = readJsonIfExists(path.join(runDir, "manifest.json"));
  const qaReport = readJsonIfExists(path.join(runDir, "qa-report.json"));
  const capabilityReport = readJsonIfExists(path.join(runDir, "capability-report.json"));
  const authorManifest = readJsonIfExists(manifest?.outputs?.authorManifest);

  state.artifacts[name] = {
    outDir: runDir,
    manifest: path.join(runDir, "manifest.json"),
    qaReport: path.join(runDir, "qa-report.json"),
    capabilityReport: path.join(runDir, "capability-report.json"),
    authorManifest: manifest?.outputs?.authorManifest || null,
    pdf: manifest?.outputs?.pdf || null,
    preview: manifest?.outputs?.preview || null,
    semanticVisualDiff: manifest?.outputs?.semanticVisualDiff || null,
    rebuildSource: manifest?.outputs?.rebuildSource || null
  };

  addAssertion(state, `${name}_exit_ok`, step.exit_code === 0, `${name} should exit 0`);
  addAssertion(state, `${name}_manifest_exists`, Boolean(manifest), `${name} should write manifest.json`);
  addAssertion(state, `${name}_capability_report_exists`, Boolean(capabilityReport), `${name} should write capability-report.json`);
  addAssertion(state, `${name}_qa_report_exists`, Boolean(qaReport), `${name} should write qa-report.json`);
  addAssertion(state, `${name}_route_kind`, manifest?.route?.kind === expectations.expectedRouteKind, `${name} should route to ${expectations.expectedRouteKind}`);
  addAssertion(state, `${name}_status`, manifest?.status === expectations.expectedStatus, `${name} should finish with status ${expectations.expectedStatus}`);

  if (expectations.requireQaOk) {
    addAssertion(state, `${name}_qa_ok`, qaReport?.ok === true, `${name} qa-report should be ok`);
  }
  if (expectations.requirePdf) {
    addAssertion(state, `${name}_pdf_exists`, Boolean(manifest?.outputs?.pdf && fs.existsSync(manifest.outputs.pdf)), `${name} should write a PDF`);
  }
  if (Number.isFinite(expectations.expectedPdfPages)) {
    addAssertion(state, `${name}_page_count`, qaReport?.summary?.pdf_pages === expectations.expectedPdfPages, `${name} should have ${expectations.expectedPdfPages} PDF pages`);
  }
  if (expectations.expectedTemplate) {
    addAssertion(state, `${name}_template_id`, authorManifest?.template?.id === expectations.expectedTemplate, `${name} should use template ${expectations.expectedTemplate}`);
  }
  if (expectations.requireSemanticVisualDiff) {
    addAssertion(state, `${name}_visual_diff_exists`, Boolean(manifest?.outputs?.semanticVisualDiff && fs.existsSync(manifest.outputs.semanticVisualDiff)), `${name} should write semantic-visual-diff.json`);
    addAssertion(state, `${name}_visual_diff_changed`, Number(qaReport?.summary?.changed_visual_regions || 0) > 0, `${name} should record changed visual regions`);
  }
  if (expectations.requireRebuildSource) {
    addAssertion(state, `${name}_rebuild_source_exists`, Boolean(manifest?.outputs?.rebuildSource && fs.existsSync(manifest.outputs.rebuildSource)), `${name} should write rebuild-content.json`);
  }
}

function createFixturePdfs(state, fixtureDir) {
  const pythonCode = String.raw`
from pathlib import Path
import sys
import fitz

out_dir = Path(sys.argv[1])
out_dir.mkdir(parents=True, exist_ok=True)

def write_pdf(path, pages):
    doc = fitz.open()
    for index, lines in enumerate(pages, start=1):
        page = doc.new_page(width=595, height=842)
        y = 72
        page.insert_text((72, y), f"{path.stem} page {index}", fontsize=18)
        y += 36
        for line in lines:
            page.insert_text((72, y), line, fontsize=12)
            y += 24
    doc.save(str(path))
    doc.close()

write_pdf(out_dir / "input-a.pdf", [
    ["Project overview", "Owner: Operations", "Section: Summary"],
    ["Second page", "Archive notes", "Reference material available"]
])
write_pdf(out_dir / "input-b.pdf", [
    ["Appendix", "One extra page for merge testing"]
])
write_pdf(out_dir / "semantic-source.pdf", [
    [
        "Service Summary",
        "Service plan: Basic.",
        "Seat count: 10.",
        "Budget value: USD 10,000."
    ]
])
print("fixtures-ok")
`;

  const step = runCommand(state, "fixture_pdfs", resolvePythonExecutable(), ["-c", pythonCode, fixtureDir]);
  addAssertion(state, "fixture_pdfs_ok", step.exit_code === 0, "fixture PDFs should be created with PyMuPDF");
  for (const fileName of ["input-a.pdf", "input-b.pdf", "semantic-source.pdf"]) {
    const filePath = path.join(fixtureDir, fileName);
    addAssertion(state, `fixture_${fileName}_exists`, fs.existsSync(filePath), `${fileName} should exist`);
  }
}

function createFixtureRequests(state, fixtureDir) {
  const mergeRequest = {
    mode: "modify",
    intent: "Merge two fixture PDFs.",
    operation: "merge",
    input: {
      path: "input-a.pdf",
      type: "pdf"
    },
    inputs: [
      {
        path: "input-b.pdf",
        type: "pdf"
      }
    ],
    options: {
      name: "self-test-merge"
    }
  };

  const normalizedRequest = {
    mode: "semantic",
    operation: "overlay_edit",
    intent: "Replace text that spans visual lines by normalized word matching.",
    input: {
      path: "semantic-source.pdf",
      type: "pdf"
    },
    changes: [
      {
        id: "chg-001",
        kind: "text_replace",
        target_text: "Service plan: Basic. Seat count: 10.",
        replacement_text: "Service plan: Pro. Seat count: 12.",
        pages: [1],
        match_mode: "normalized"
      }
    ],
    options: {
      name: "self-test-semantic-normalized"
    }
  };

  const ambiguousRequest = {
    mode: "semantic",
    operation: "overlay_edit",
    intent: "Attempt a targeted replacement where the target appears more than once.",
    input: {
      path: "semantic-source.pdf",
      type: "pdf"
    },
    changes: [
      {
        id: "chg-001",
        kind: "text_replace",
        target_text: "Budget value: USD 10,000.",
        replacement_text: "Budget value: USD 12,000.",
        pages: [1]
      }
    ],
    options: {
      name: "self-test-semantic-ambiguous"
    }
  };

  writeJson(path.join(fixtureDir, "modify-merge-request.json"), mergeRequest);
  writeJson(path.join(fixtureDir, "semantic-normalized-request.json"), normalizedRequest);
  writeJson(path.join(fixtureDir, "semantic-ambiguous-request.json"), ambiguousRequest);
  addAssertion(state, "fixture_requests_written", true, "fixture request JSON files should be written");
}

function parseArgs(argv) {
  const args = {
    outDir: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--out-dir") {
      args.outDir = takeValue(argv, ++index, token);
    } else if (token === "--help" || token === "-h") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown option: ${token}`);
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
  console.log("Usage: node scripts/self-test.mjs [--out-dir <dir>]");
  process.exit(0);
}

function runNodeStep(state, name, args) {
  return runCommand(state, name, resolveNodeExecutable(), args);
}

function runCommand(state, name, command, args) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: WORKSPACE_DIR,
    env: buildChildEnv(),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });
  const step = {
    name,
    command,
    args,
    exit_code: typeof result.status === "number" ? result.status : 1,
    ok: result.status === 0,
    duration_ms: Date.now() - started,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error.message || result.error) : null
  };
  state.steps.push(step);
  return step;
}

function addAssertion(state, name, ok, detail) {
  state.assertions.push({
    name,
    ok: Boolean(ok),
    detail
  });
}

function finalizeState(state) {
  const failedSteps = state.steps.filter((step) => !step.ok);
  const failedAssertions = state.assertions.filter((item) => !item.ok);
  state.summary = {
    steps: state.steps.length,
    failed_steps: failedSteps.length,
    assertions: state.assertions.length,
    failed_assertions: failedAssertions.length
  };
  state.ok = state.ok && failedSteps.length === 0 && failedAssertions.length === 0;
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
  const candidates = [
    process.env.PDF_AUTHOR_EDITOR_PYTHON,
    process.env.PYTHON,
    dependencyRoot ? path.join(dependencyRoot, "python", process.platform === "win32" ? "python.exe" : "bin/python") : null,
    "python"
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === "python" || fs.existsSync(candidate)) || "python";
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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
