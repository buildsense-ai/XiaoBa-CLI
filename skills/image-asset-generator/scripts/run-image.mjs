#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DreaminaImageError, errorRecord, extractLastJson } from "./lib/dreamina-cli.mjs";
import { image2FailurePolicy, isImage2ReferenceAttachmentRejected } from "./lib/failure-policy.mjs";
import {
  acquireRunLock,
  pathExists,
  readJson,
  sha256Text,
  writeJsonAtomic,
} from "./lib/run-state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const IMAGE2_SCRIPT = path.join(SCRIPT_DIR, "generate-image.mjs");
const DREAMINA_SCRIPT = path.join(SCRIPT_DIR, "generate-dreamina-image.mjs");
const PROVIDERS = new Set(["auto", "image2", "dreamina"]);

function now() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = {
    provider: String(process.env.IMAGE_GEN_PROVIDER || "auto").trim().toLowerCase(),
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--request") args.request = argv[++index];
    else if (token === "--out-dir") args.outDir = argv[++index];
    else if (token === "--task-id") args.taskId = argv[++index];
    else if (token === "--provider") args.provider = String(argv[++index] || "").toLowerCase();
    else if (token === "--wait-seconds") args.waitSeconds = argv[++index];
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new DreaminaImageError("INVALID_ARGUMENT", `Unknown argument: ${token}`);
  }
  if (args.help) return args;
  if (!args.request) throw new DreaminaImageError("INVALID_ARGUMENT", "--request is required.");
  if (!PROVIDERS.has(args.provider)) {
    throw new DreaminaImageError("INVALID_ARGUMENT", "--provider must be auto, image2, or dreamina.");
  }
  if (!args.dryRun && !args.outDir) throw new DreaminaImageError("INVALID_ARGUMENT", "--out-dir is required.");
  if (args.provider === "dreamina" && args.taskId) {
    throw new DreaminaImageError("INVALID_ARGUMENT", "--task-id applies only to Image2 asynchronous tasks.");
  }
  return args;
}

function printHelp() {
  process.stdout.write([
    "Usage:",
    "  node run-image.mjs --request <request.json> --out-dir <directory> [--provider auto|image2|dreamina]",
    "  node run-image.mjs --request <request.json> --dry-run [--provider auto|image2|dreamina]",
    "",
    "auto uses the CatsCo Image2 race first and falls back after a structured race exhaustion or another allowlisted failure.",
    "Unstructured timeouts, connection loss, HTTP 504/524, and ambiguous direct-provider submissions never fall back automatically.",
  ].join("\n") + "\n");
}

async function runScript(scriptPath, args) {
  return await new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    const child = spawn(process.execPath, [scriptPath, ...args], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (exitCode, signal) => {
      resolveRun({
        exitCode,
        signal,
        error: spawnError,
        stdout,
        stderr,
        parsed: extractLastJson(stdout) || extractLastJson(stderr),
      });
    });
  });
}

function childArgs(options, provider, taskId = null) {
  const args = ["--request", path.resolve(options.request)];
  if (options.dryRun) args.push("--dry-run");
  else args.push("--out-dir", path.resolve(options.outDir));
  if (provider === "image2" && taskId) args.push("--task-id", taskId);
  if (provider === "dreamina") {
    if (options.waitSeconds !== undefined) args.push("--wait-seconds", options.waitSeconds);
  }
  return args;
}

function image2OutcomeFromRun(run) {
  const parsed = run.parsed;
  const error = parsed?.error || {
    code: run.error?.code === "ENOENT" ? "IMAGE2_EXECUTOR_UNAVAILABLE" : "IMAGE2_EXECUTOR_FAILED",
    message: run.error?.message || run.stderr.trim() || run.stdout.trim() || `Image2 executor exited with code ${run.exitCode}.`,
  };
  const policy = parsed?.failure && parsed?.recovery
    ? { failure: parsed.failure, recovery: parsed.recovery }
    : image2FailurePolicy(error);
  return { error, ...policy };
}

function isSafeFallback(outcome) {
  return outcome?.failure?.fallback_safe === true
    && outcome?.recovery?.next_action === "fallback_to_dreamina";
}

function isUnknownSubmission(outcome) {
  return outcome?.failure?.submission_state === "unknown";
}

function fallbackReason(error) {
  const status = Number(error?.details?.status);
  if (isImage2ReferenceAttachmentRejected(error)) return "reference_attachment_rejected";
  if (error?.code === "REFERENCE_GATEWAY_UNAVAILABLE" || status === 404 || status === 501) {
    return "capability_unavailable";
  }
  if (status === 429) return "rate_limited";
  if (status === 503) return "service_unavailable";
  if (["IMAGE_RACE_EXHAUSTED", "IMAGE_RACE_UNAVAILABLE"].includes(error?.code)) return "image2_race_exhausted";
  if (["MISSING_CATSCO_IDENTITY", "MISSING_API_KEY", "INVALID_CONFIGURATION"].includes(error?.code)) {
    return "image2_unconfigured";
  }
  return "service_unavailable";
}

async function printExistingSuccess(resultPath) {
  const result = await readJson(resultPath, { optional: true });
  if (result?.ok !== true || result.status !== "generated") return false;
  const imagePath = result?.output?.image_path;
  const image = imagePath ? await readFile(imagePath).catch(() => null) : null;
  if (!image || sha256Text(image) !== result.output.sha256) return false;
  process.stdout.write(`${JSON.stringify({ ok: true, image_path: imagePath, result_path: resultPath }, null, 2)}\n`);
  return true;
}

async function saveRouteError(paths, state, outcome, status) {
  const record = {
    ok: false,
    error: outcome.error,
    failure: outcome.failure,
    recovery: outcome.recovery,
    routing: {
      requested_provider: state.policy,
      selected_provider: state.active_provider,
      fallback_used: state.active_provider === "dreamina" && state.policy === "auto",
    },
    recorded_at: now(),
  };
  state.status = status;
  state.updated_at = now();
  await writeJsonAtomic(paths.state, state);
  await writeJsonAtomic(paths.routeError, record);
  process.stderr.write(`${JSON.stringify(record, null, 2)}\n`);
  process.exitCode = 1;
}

async function runDreaminaRoute(options, paths, state, role, reason) {
  state.active_provider = "dreamina";
  state.status = "dreamina_running";
  state.dreamina = {
    ...(state.dreamina || {}),
    status: "running",
    started_at: state.dreamina?.started_at || now(),
  };
  state.updated_at = now();
  await writeJsonAtomic(paths.state, state);

  const args = childArgs(options, "dreamina");
  args.push("--provider-role", role);
  if (role === "fallback") args.push("--fallback-from", "image2", "--fallback-reason", reason);
  const run = await runScript(DREAMINA_SCRIPT, args);
  const result = await readJson(paths.result, { optional: true });
  state.dreamina.status = result?.status || (run.exitCode === 0 ? "completed" : "failed");
  state.dreamina.submit_id = result?.provider?.async_task?.task_id || null;
  state.dreamina.updated_at = now();
  state.status = result?.status || state.dreamina.status;
  state.updated_at = now();
  await writeJsonAtomic(paths.state, state);

  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.exitCode !== 0 || run.error) process.exitCode = 1;
  return run;
}

async function runMain(options) {
  if (options.dryRun) {
    const provider = options.provider === "dreamina" ? "dreamina" : "image2";
    const script = provider === "dreamina" ? DREAMINA_SCRIPT : IMAGE2_SCRIPT;
    const run = await runScript(script, childArgs(options, provider));
    if (run.stdout) process.stdout.write(run.stdout);
    if (run.stderr) process.stderr.write(run.stderr);
    if (run.exitCode !== 0 || run.error) process.exitCode = 1;
    return;
  }

  const requestPath = path.resolve(options.request);
  const requestText = await readFile(requestPath, "utf8");
  const requestSha256 = sha256Text(requestText);
  const outDir = path.resolve(options.outDir);
  const paths = {
    state: path.join(outDir, "provider-state.json"),
    routeError: path.join(outDir, "provider-error.json"),
    image2Error: path.join(outDir, "image2-error.json"),
    result: path.join(outDir, "result.json"),
    pending: path.join(outDir, "pending.json"),
  };
  const lock = await acquireRunLock(outDir);
  try {
    if (await printExistingSuccess(paths.result)) return;
    let state = await readJson(paths.state, { optional: true });
    if (state && (
      state.request_sha256 !== requestSha256
      || path.resolve(state.request_path) !== requestPath
    )) {
      throw new DreaminaImageError("REQUEST_MISMATCH", "This provider state belongs to a different request.");
    }
    if (state && state.policy !== options.provider) {
      throw new DreaminaImageError(
        "PROVIDER_POLICY_MISMATCH",
        `This run was started with provider=${state.policy}; use a fresh run directory for provider=${options.provider}.`,
      );
    }
    state ||= {
      schema_version: "1.0",
      source_skill: "image-asset-generator",
      request_path: requestPath,
      request_sha256: requestSha256,
      policy: options.provider,
      active_provider: options.provider === "dreamina" ? "dreamina" : "image2",
      status: "prepared",
      image2: null,
      dreamina: null,
      created_at: now(),
      updated_at: now(),
    };

    if (state.active_provider === "dreamina") {
      const role = state.policy === "auto" ? "fallback" : "primary";
      const reason = state.image2?.fallback_reason || "service_unavailable";
      await runDreaminaRoute(options, paths, state, role, reason);
      return;
    }
    if (["image2_submitting", "image2_submission_unknown"].includes(state.status)) {
      await saveRouteError(
        paths,
        state,
        {
          error: {
          code: "SUBMISSION_UNKNOWN",
          message: "The prior Image2 submission did not reach a trustworthy result. This run will not submit to either provider again.",
          },
          ...image2FailurePolicy({ code: "SUBMISSION_UNKNOWN" }),
        },
        "image2_submission_unknown",
      );
      return;
    }
    if (state.status === "image2_terminal_failure") {
      const previous = await readJson(paths.image2Error, { optional: true });
      const priorError = previous?.error || {
        code: "IMAGE2_TERMINAL_FAILURE",
        message: "The prior Image2 attempt failed and this run is closed.",
      };
      await saveRouteError(paths, state, {
        error: priorError,
        failure: previous?.failure || image2FailurePolicy(priorError).failure,
        recovery: previous?.recovery || image2FailurePolicy(priorError).recovery,
      }, "image2_terminal_failure");
      return;
    }
    if (state.status === "image2_safe_failure" && state.policy === "auto") {
      await runDreaminaRoute(
        options,
        paths,
        state,
        "fallback",
        state.image2?.fallback_reason || "service_unavailable",
      );
      return;
    }

    let resumeTaskId = options.taskId || null;
    if (!resumeTaskId && state.status === "image2_pending") {
      const pending = await readJson(paths.pending, { optional: true });
      resumeTaskId = pending?.task_id || null;
      if (!resumeTaskId) {
        const missingTaskError = {
          code: "SUBMISSION_UNKNOWN",
          message: "Image2 was marked pending but its persisted task ID is missing.",
        };
        await saveRouteError(paths, state, {
          error: missingTaskError,
          ...image2FailurePolicy(missingTaskError),
        }, "image2_submission_unknown");
        return;
      }
    }

    state.active_provider = "image2";
    state.status = resumeTaskId ? "image2_resuming" : "image2_submitting";
    state.image2 = {
      ...(state.image2 || {}),
      status: resumeTaskId ? "resuming" : "submitting",
      attempts: Number(state.image2?.attempts || 0) + (resumeTaskId ? 0 : 1),
      started_at: state.image2?.started_at || now(),
      updated_at: now(),
    };
    state.updated_at = now();
    await writeJsonAtomic(paths.state, state);

    const run = await runScript(IMAGE2_SCRIPT, childArgs(options, "image2", resumeTaskId));
    if (run.exitCode === 0 && run.parsed?.ok === true) {
      const result = await readJson(paths.result, { optional: true });
      if (result) {
        result.routing = {
          requested_provider: state.policy,
          selected_provider: "image2",
          fallback_used: false,
        };
        await writeJsonAtomic(paths.result, result);
      }
      state.status = "generated";
      state.image2.status = "generated";
      state.image2.completed_at = now();
      state.updated_at = now();
      await writeJsonAtomic(paths.state, state);
      if (run.stdout) process.stdout.write(run.stdout);
      return;
    }

    let outcome = image2OutcomeFromRun(run);
    const pending = await readJson(paths.pending, { optional: true });
    if (outcome.recovery.can_resume_same_task && !pending?.task_id) {
      outcome = {
        error: outcome.error,
        failure: {
          ...outcome.failure,
          submission_state: "unknown",
          retry_safe: false,
          fallback_safe: false,
        },
        recovery: {
          next_action: "confirm_new_dreamina_run",
          can_resume_same_task: false,
          requires_user_confirmation: true,
          duplicate_generation_risk: true,
        },
      };
    }
    const errorEnvelope = { ok: false, ...outcome, recorded_at: now() };
    await writeJsonAtomic(paths.image2Error, errorEnvelope);
    state.image2.error = outcome.error;
    state.image2.failure = outcome.failure;
    state.image2.recovery = outcome.recovery;
    state.image2.updated_at = now();

    if (outcome.recovery.can_resume_same_task && pending?.task_id) {
      state.status = "image2_pending";
      state.image2.status = "pending";
      state.image2.task_id = pending.task_id;
      state.updated_at = now();
      await writeJsonAtomic(paths.state, state);
      await writeJsonAtomic(paths.routeError, {
        ok: true,
        status: "pending",
        ...outcome,
        routing: {
          requested_provider: state.policy,
          selected_provider: "image2",
          fallback_used: false,
        },
        recorded_at: now(),
      });
      if (run.stderr) process.stderr.write(run.stderr);
      process.exitCode = 1;
      return;
    }

    if (state.policy === "auto" && isSafeFallback(outcome)) {
      state.status = "image2_safe_failure";
      state.image2.status = "safe_failure";
      state.image2.fallback_reason = fallbackReason(outcome.error);
      state.updated_at = now();
      await writeJsonAtomic(paths.state, state);
      await runDreaminaRoute(options, paths, state, "fallback", state.image2.fallback_reason);
      return;
    }
    if (isUnknownSubmission(outcome)) {
      await saveRouteError(paths, state, outcome, "image2_submission_unknown");
      return;
    }
    await saveRouteError(paths, state, outcome, "image2_terminal_failure");
  } finally {
    await lock.release();
  }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) printHelp();
  else await runMain(options);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: errorRecord(error) }, null, 2)}\n`);
  process.exitCode = 1;
}
