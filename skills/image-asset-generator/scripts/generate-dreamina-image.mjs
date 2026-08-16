#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectReferenceSourceImage,
  loadBoundReferenceImages,
} from "./reference-image-utils.mjs";
import {
  DreaminaImageError,
  classifyDreaminaFailure,
  errorRecord,
  extractFailureReason,
  extractGenStatus,
  extractLastJson,
  extractSubmitId,
  runDreamina,
  summarizeCliResponse,
} from "./lib/dreamina-cli.mjs";
import {
  pathExists,
  readJson,
  sha256Text,
  sleep,
  writeJsonAtomic,
} from "./lib/run-state.mjs";
import { dreaminaFailurePolicy, pendingRecovery } from "./lib/failure-policy.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const IMAGE2_SCRIPT = path.resolve(SCRIPT_DIR, "generate-image.mjs");
const SAFE_OPERATION_RETRIES = 1;
const SUCCESS_STATUSES = new Set(["success", "succeeded", "completed", "done"]);
const FAILURE_STATUSES = new Set(["fail", "failed", "error", "expired", "canceled", "cancelled"]);
const DEFAULT_TEXT_MODEL_VERSION = "4.7";
const DEFAULT_PROMPT_MAX_CHARS = 900;
const SUPPORTED_MODEL_VERSIONS = new Set(["3.0", "3.1", "4.0", "4.1", "4.5", "4.6", "4.7", "5.0", "5.0Pro"]);
const RETRYABLE_PRE_SUBMIT_STATUSES = new Set([
  "auth_required",
  "insufficient_credit",
  "compliance_confirmation_required",
  "provider_unavailable",
  "cli_unavailable",
]);
const SUPPORTED_RATIOS = new Set(["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"]);
const RATIO_ALIASES = new Map([
  ["landscape", "3:2"],
  ["portrait", "2:3"],
  ["square", "1:1"],
]);
const STATUS_BY_ERROR = new Map([
  ["AUTH_REQUIRED", "auth_required"],
  ["INSUFFICIENT_CREDIT", "insufficient_credit"],
  ["COMPLIANCE_CONFIRMATION_REQUIRED", "compliance_confirmation_required"],
  ["SUBMISSION_UNKNOWN", "submission_unknown"],
  ["PROVIDER_UNAVAILABLE", "provider_unavailable"],
  ["CLI_UNAVAILABLE", "cli_unavailable"],
  ["QUERY_FAILED", "query_failed"],
  ["DOWNLOAD_FAILED", "download_failed"],
  ["GENERATION_FAILED", "generation_failed"],
  ["UNSUPPORTED_DREAMINA_RATIO", "unsupported_request"],
  ["REQUEST_MISMATCH", "request_mismatch"],
]);

function now() {
  return new Date().toISOString();
}

function parseInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new DreaminaImageError("INVALID_ARGUMENT", `${label} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    providerRole: "primary",
    waitSeconds: parseInteger(process.env.DREAMINA_IMAGE_WAIT_SECONDS, 120, 0, 600, "DREAMINA_IMAGE_WAIT_SECONDS"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--request") args.request = argv[++index];
    else if (token === "--out-dir") args.outDir = argv[++index];
    else if (token === "--provider-role") args.providerRole = argv[++index];
    else if (token === "--fallback-from") args.fallbackFrom = argv[++index];
    else if (token === "--fallback-reason") args.fallbackReason = argv[++index];
    else if (token === "--wait-seconds") args.waitSeconds = parseInteger(argv[++index], 120, 0, 600, "--wait-seconds");
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new DreaminaImageError("INVALID_ARGUMENT", `Unknown argument: ${token}`);
  }
  if (args.help) return args;
  if (!args.request) throw new DreaminaImageError("INVALID_ARGUMENT", "--request is required.");
  if (!args.dryRun && !args.outDir) throw new DreaminaImageError("INVALID_ARGUMENT", "--out-dir is required.");
  if (!["primary", "fallback"].includes(args.providerRole)) {
    throw new DreaminaImageError("INVALID_ARGUMENT", "--provider-role must be primary or fallback.");
  }
  if (args.providerRole === "fallback" && !args.fallbackFrom) args.fallbackFrom = "image2";
  return args;
}

function printHelp() {
  process.stdout.write([
    "Usage:",
    "  node generate-dreamina-image.mjs --request <request.json> --out-dir <directory>",
    "  node generate-dreamina-image.mjs --request <request.json> --dry-run",
    "",
    "This is the internal Dreamina executor. Use run-image.mjs for normal generation.",
  ].join("\n") + "\n");
}

async function runNode(args, timeoutMs = 60_000) {
  return await new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(process.execPath, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, IMAGE_GEN_DISABLE_ENV_FILE: "true" },
    });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveRun({ exitCode, stdout, stderr, timedOut });
    });
  });
}

async function inspectPreparedRequest(requestPath) {
  const inspected = await runNode([IMAGE2_SCRIPT, "--request", requestPath, "--inspect-request"]);
  const parsed = extractLastJson(inspected.stdout) || extractLastJson(inspected.stderr);
  if (inspected.exitCode !== 0 || inspected.timedOut || !parsed?.ok) {
    const providerError = parsed?.error;
    throw new DreaminaImageError(
      providerError?.code || "INVALID_REQUEST",
      providerError?.message || "Could not inspect the prepared image request.",
      providerError?.details,
    );
  }
  return parsed;
}

function dreaminaRatio(request) {
  if (!request.aspect_ratio) return null;
  const ratio = RATIO_ALIASES.get(request.aspect_ratio) || request.aspect_ratio;
  if (!SUPPORTED_RATIOS.has(ratio)) {
    throw new DreaminaImageError(
      "UNSUPPORTED_DREAMINA_RATIO",
      `Dreamina does not support ${request.aspect_ratio}. Use one of ${[...SUPPORTED_RATIOS].join(", ")}.`,
      { requested_ratio: request.aspect_ratio, supported_ratios: [...SUPPORTED_RATIOS] },
    );
  }
  return ratio;
}

function splitPromptSentences(value) {
  const matches = value.match(/[^.!?\u3002\uff01\uff1f]+[.!?\u3002\uff01\uff1f]?/gu);
  return (matches || [value]).map((item) => item.trim()).filter(Boolean);
}

function selectDreaminaPrompt(prompt) {
  const normalized = String(prompt || "")
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const maxChars = parseInteger(
    process.env.DREAMINA_IMAGE_PROMPT_MAX_CHARS,
    DEFAULT_PROMPT_MAX_CHARS,
    300,
    12_000,
    "DREAMINA_IMAGE_PROMPT_MAX_CHARS",
  );
  if (normalized.length <= maxChars) {
    return {
      prompt: normalized,
      compacted: false,
      original_chars: normalized.length,
      provider_chars: normalized.length,
      max_chars: maxChars,
    };
  }

  const paragraphs = normalized.split(/\n{2,}/).map(splitPromptSentences).filter((items) => items.length);
  const selected = [];
  let used = 0;
  for (let round = 0; ; round += 1) {
    let sawCandidate = false;
    for (const sentences of paragraphs) {
      const sentence = sentences[round];
      if (!sentence) continue;
      sawCandidate = true;
      const separator = selected.length ? " " : "";
      if (used + separator.length + sentence.length > maxChars) continue;
      selected.push(sentence);
      used += separator.length + sentence.length;
    }
    if (!sawCandidate) break;
  }
  if (!selected.length) selected.push(normalized.slice(0, maxChars).trimEnd());
  const providerPrompt = selected.join(" ");
  return {
    prompt: providerPrompt,
    compacted: true,
    original_chars: normalized.length,
    provider_chars: providerPrompt.length,
    max_chars: maxChars,
  };
}

function dreaminaModelVersion(references) {
  const configured = process.env.DREAMINA_IMAGE_MODEL_VERSION?.trim();
  const modelVersion = configured || (references.length ? null : DEFAULT_TEXT_MODEL_VERSION);
  if (modelVersion && !SUPPORTED_MODEL_VERSIONS.has(modelVersion)) {
    throw new DreaminaImageError(
      "INVALID_ARGUMENT",
      `DREAMINA_IMAGE_MODEL_VERSION must be one of ${[...SUPPORTED_MODEL_VERSIONS].join(", ")}.`,
    );
  }
  return modelVersion;
}

function buildSubmitArgs(request, prompt, references) {
  const args = [references.length ? "image2image" : "text2image"];
  for (const reference of references) args.push(`--images=${reference.resolvedPath}`);
  args.push(`--prompt=${prompt}`);
  const modelVersion = dreaminaModelVersion(references);
  if (modelVersion) args.push(`--model_version=${modelVersion}`);
  const ratio = dreaminaRatio(request);
  if (ratio) args.push(`--ratio=${ratio}`);
  args.push("--resolution_type=2k", "--generate_num=1", "--poll=0");
  return { args, ratio, modelVersion };
}

function dreaminaModelLabel(task) {
  return task?.model_version ? `dreamina-${task.model_version}` : "dreamina-default";
}

function resultStatus(error) {
  return STATUS_BY_ERROR.get(error?.code) || "internal_error";
}

function baseRouting(options) {
  return {
    selected_provider: "dreamina",
    provider_role: options.providerRole,
    fallback_from: options.providerRole === "fallback" ? options.fallbackFrom || "image2" : null,
    fallback_reason: options.providerRole === "fallback" ? options.fallbackReason || "service_unavailable" : null,
  };
}

function failureResult(options, requestPath, request, prompt, task, error) {
  const policy = dreaminaFailurePolicy(error, { hasTask: Boolean(task?.submit_id) });
  return {
    schema_version: "1.0",
    ok: false,
    status: resultStatus(error),
    request_path: requestPath,
    request,
    prompt,
    provider: {
      auth_mode: "dreamina-oauth",
      api_operation: request?.reference_images?.length ? "image2image" : "text2image",
      model: dreaminaModelLabel(task),
      prompt_compaction: task?.prompt_compaction || null,
      attempts: Number(task?.submit_attempts || 0),
      request_id: task?.submit_id || null,
      ...(task?.submit_id ? {
        async_task: {
          task_id: task.submit_id,
          initial_status: task.gen_status || null,
          final_status: task.gen_status || null,
          poll_count: Number(task.query_attempts || 0),
        },
      } : {}),
    },
    routing: baseRouting(options),
    output: null,
    error: errorRecord(error),
    ...policy,
    review: {
      status: "not_run",
      note: "No generated image was available for review.",
    },
    timing: {
      started_at: task?.created_at || now(),
      completed_at: now(),
      duration_ms: task?.started_ms ? Date.now() - task.started_ms : null,
    },
  };
}

async function saveFailure(paths, options, requestPath, request, prompt, task, error) {
  const policy = dreaminaFailurePolicy(error, { hasTask: Boolean(task?.submit_id) });
  task.local_status = resultStatus(error);
  task.error = errorRecord(error);
  task.failure = policy.failure;
  task.recovery = policy.recovery;
  task.updated_at = now();
  await writeJsonAtomic(paths.task, task);
  const result = failureResult(options, requestPath, request, prompt, task, error);
  await writeJsonAtomic(paths.result, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 1;
  return result;
}

async function listImageFiles(root, depth = 0) {
  if (depth > 4) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listImageFiles(entryPath, depth + 1));
    else if (entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name)) files.push(entryPath);
  }
  return files;
}

function ratioValue(value) {
  const match = /^(\d+):(\d+)$/.exec(value || "");
  return match && Number(match[2]) ? Number(match[1]) / Number(match[2]) : null;
}

async function unlinkIfExists(filePath) {
  await unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function materializeOutput(paths, options, requestPath, request, prompt, task, selectedRatio) {
  const candidates = await listImageFiles(paths.providerOutput);
  if (!candidates.length) {
    throw new DreaminaImageError(
      "DOWNLOAD_FAILED",
      "Dreamina reported success but query_result did not download an image.",
    );
  }
  const records = await Promise.all(candidates.map(async (filePath) => ({
    filePath,
    fileStat: await stat(filePath),
  })));
  records.sort((left, right) => right.fileStat.mtimeMs - left.fileStat.mtimeMs);

  let selected = null;
  const rejected = [];
  for (const record of records) {
    try {
      const sourceBuffer = await readFile(record.filePath);
      const image = inspectReferenceSourceImage(sourceBuffer, "Dreamina output");
      selected = { sourcePath: record.filePath, sourceBuffer, image };
      break;
    } catch (error) {
      rejected.push({ path: record.filePath, message: error?.message || String(error) });
      await unlinkIfExists(record.filePath);
    }
  }
  if (!selected) {
    throw new DreaminaImageError(
      "DOWNLOAD_FAILED",
      "Dreamina downloaded image files, but none passed local image validation.",
      { rejected },
    );
  }

  const { sourcePath, sourceBuffer, image } = selected;
  const imagePath = path.join(paths.outDir, `${request.filename}.${image.extension}`);
  const partialPath = `${imagePath}.part`;
  await unlinkIfExists(partialPath);
  await copyFile(sourcePath, partialPath, fsConstants.COPYFILE_EXCL);
  const stagedBuffer = await readFile(partialPath);
  const stagedImage = inspectReferenceSourceImage(stagedBuffer, "staged Dreamina output");
  const stagedSha256 = sha256Text(stagedBuffer);
  if (
    stagedSha256 !== sha256Text(sourceBuffer)
    || stagedImage.width !== image.width
    || stagedImage.height !== image.height
    || stagedImage.mediaType !== image.mediaType
  ) {
    await unlinkIfExists(partialPath);
    throw new DreaminaImageError("DOWNLOAD_FAILED", "Dreamina output changed while it was being materialized.");
  }

  const existing = await readFile(imagePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing && sha256Text(existing) === stagedSha256) {
    await unlinkIfExists(partialPath);
  } else {
    await unlinkIfExists(imagePath);
    await rename(partialPath, imagePath);
  }

  const requestedRatioValue = ratioValue(selectedRatio);
  const actualRatio = image.width / image.height;
  const ratioMatch = requestedRatioValue == null
    ? null
    : Math.abs(actualRatio / requestedRatioValue - 1) <= 0.05;
  const warnings = [];
  if (ratioMatch === false) {
    warnings.push(`Dreamina returned ${image.width}x${image.height}, which differs from requested ratio ${selectedRatio}.`);
  }
  const actualFormat = image.mediaType === "image/jpeg" ? "jpeg" : image.extension;
  if (request.output_format && request.output_format !== actualFormat) {
    warnings.push(`Dreamina returned ${actualFormat}; requested output_format was ${request.output_format}.`);
  }

  task.local_status = "generated";
  task.gen_status = "success";
  task.output_path = imagePath;
  task.output_sha256 = stagedSha256;
  task.error = null;
  task.failure = null;
  task.recovery = null;
  task.completed_at = now();
  task.updated_at = task.completed_at;
  await writeJsonAtomic(paths.task, task);

  const result = {
    schema_version: "1.0",
    ok: true,
    status: "generated",
    request_path: requestPath,
    request,
    prompt,
    provider: {
      auth_mode: "dreamina-oauth",
      api_operation: request.reference_images.length ? "image2image" : "text2image",
      model: dreaminaModelLabel(task),
      prompt_compaction: task?.prompt_compaction || null,
      attempts: Number(task.submit_attempts || 1),
      request_id: task.submit_id,
      revised_prompt: null,
      async_task: {
        task_id: task.submit_id,
        resumed: Number(task.query_attempts || 0) > 1,
        initial_status: task.initial_gen_status || "querying",
        final_status: "success",
        poll_count: Number(task.query_attempts || 0),
      },
    },
    routing: baseRouting(options),
    output: {
      image_path: imagePath,
      filename: path.basename(imagePath),
      media_type: image.mediaType,
      bytes: stagedBuffer.length,
      sha256: stagedSha256,
      dimensions: {
        width: image.width,
        height: image.height,
        requested_size: request.size,
        requested_aspect_ratio: selectedRatio,
        exact_size_match: null,
        aspect_ratio_match: ratioMatch,
      },
    },
    warnings,
    review: {
      status: "not_run",
      note: "Use the agent's existing image-reading capability to compare this image with request.json.",
    },
    timing: {
      started_at: task.created_at,
      completed_at: task.completed_at,
      duration_ms: Date.now() - task.started_ms,
    },
  };
  await writeJsonAtomic(paths.result, result);
  process.stdout.write(`${JSON.stringify({ ok: true, image_path: imagePath, result_path: paths.result }, null, 2)}\n`);
  return result;
}

async function runMain(options) {
  const requestPath = path.resolve(options.request);
  const inspected = await inspectPreparedRequest(requestPath);
  const request = inspected.request;
  const promptSelection = selectDreaminaPrompt(inspected.prompt);
  const prompt = promptSelection.prompt;
  const references = request.reference_images.length
    ? await loadBoundReferenceImages(request.reference_images, path.dirname(requestPath))
    : [];
  const submit = buildSubmitArgs(request, prompt, references);

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      provider: "dreamina",
      provider_role: options.providerRole,
      command: submit.args,
      request,
      prompt,
      prompt_compaction: promptSelection,
      model_version: submit.modelVersion,
    }, null, 2)}\n`);
    return;
  }

  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const paths = {
    outDir,
    task: path.join(outDir, "dreamina-task.json"),
    result: path.join(outDir, "result.json"),
    command: path.join(outDir, "dreamina-command.json"),
    provider: path.join(outDir, "dreamina-provider"),
    providerOutput: path.join(outDir, "dreamina-provider-output"),
  };
  await mkdir(paths.provider, { recursive: true });
  await mkdir(paths.providerOutput, { recursive: true });

  const existingTask = await readJson(paths.task, { optional: true });
  const existingResult = await readJson(paths.result, { optional: true });
  if (existingTask && (
    existingTask.request_sha256 !== inspected.request_sha256
    || path.resolve(existingTask.request_path) !== requestPath
  )) {
    throw new DreaminaImageError("REQUEST_MISMATCH", "This Dreamina task belongs to a different request.");
  }
  if (existingTask && existingTask.provider_role !== options.providerRole) {
    throw new DreaminaImageError("REQUEST_MISMATCH", "This Dreamina task was created with a different provider role.");
  }
  if (existingResult?.ok === true && existingResult.status === "generated") {
    const outputPath = existingResult?.output?.image_path;
    const outputBuffer = outputPath ? await readFile(outputPath).catch(() => null) : null;
    if (outputBuffer && sha256Text(outputBuffer) === existingResult.output.sha256) {
      process.stdout.write(`${JSON.stringify({ ok: true, image_path: outputPath, result_path: paths.result }, null, 2)}\n`);
      return;
    }
  }

  const task = existingTask || {
    schema_version: "1.0",
    source_skill: "image-asset-generator",
    run_id: path.basename(outDir),
    provider: "dreamina",
    provider_role: options.providerRole,
    fallback_from: options.providerRole === "fallback" ? options.fallbackFrom || "image2" : null,
    fallback_reason: options.providerRole === "fallback" ? options.fallbackReason || "service_unavailable" : null,
    request_path: requestPath,
    request_sha256: inspected.request_sha256,
    local_status: "prepared",
    submit_id: null,
    gen_status: null,
    submit_attempts: 0,
    query_attempts: 0,
    model_version: submit.modelVersion,
    prompt_compaction: promptSelection,
    output_path: null,
    error: null,
    started_ms: Date.now(),
    created_at: now(),
    updated_at: now(),
  };
  task.run_id ||= path.basename(outDir);

  if (!task.submit_id && task.local_status === "submitting") {
    return await saveFailure(
      paths,
      options,
      requestPath,
      request,
      prompt,
      task,
      new DreaminaImageError(
        "SUBMISSION_UNKNOWN",
        "A previous Dreamina submit ended without a trustworthy submit_id. This run will not submit again.",
      ),
    );
  }
  if (!task.submit_id && task.local_status === "submission_unknown") {
    return await saveFailure(
      paths,
      options,
      requestPath,
      request,
      prompt,
      task,
      new DreaminaImageError(
        "SUBMISSION_UNKNOWN",
        "The Dreamina submission state is unknown. Use a new run only after explicitly accepting duplicate-generation risk.",
      ),
    );
  }
  if (!task.submit_id && existingResult && !RETRYABLE_PRE_SUBMIT_STATUSES.has(existingResult.status)) {
    process.stdout.write(`${JSON.stringify(existingResult, null, 2)}\n`);
    process.exitCode = 1;
    return existingResult;
  }

  if (!task.submit_id) {
    for (let attempt = 0; attempt <= SAFE_OPERATION_RETRIES; attempt += 1) {
      task.preflight_attempts = Number(task.preflight_attempts || 0) + 1;
      task.updated_at = now();
      await writeJsonAtomic(paths.task, task);
      const credit = await runDreamina(["user_credit"], { cwd: outDir });
      const creditRecord = summarizeCliResponse(credit);
      await writeJsonAtomic(
        path.join(paths.provider, `credit-${String(task.preflight_attempts).padStart(2, "0")}.json`),
        creditRecord,
      );
      await writeJsonAtomic(path.join(paths.provider, "credit.json"), creditRecord);
      if (credit.exitCode === 0 && !credit.timedOut && !credit.error) break;

      const creditError = classifyDreaminaFailure({
        phase: "credit",
        exitCode: credit.exitCode,
        signal: credit.signal,
        timedOut: credit.timedOut,
        error: credit.error,
        stdout: credit.stdout,
        stderr: credit.stderr,
      });
      if (creditError.code === "PROVIDER_UNAVAILABLE" && attempt < SAFE_OPERATION_RETRIES) {
        await sleep(500);
        continue;
      }
      return await saveFailure(paths, options, requestPath, request, prompt, task, creditError);
    }

    await writeJsonAtomic(paths.command, {
      schema_version: "1.0",
      executable: process.env.DREAMINA_CLI_BIN || "dreamina",
      args: submit.args,
      created_at: now(),
    });
    task.local_status = "submitting";
    task.submit_attempts = Number(task.submit_attempts || 0) + 1;
    task.submit_attempted_at = now();
    task.updated_at = now();
    task.error = null;
    task.failure = null;
    task.recovery = null;
    await writeJsonAtomic(paths.task, task);

    const submitted = await runDreamina(submit.args, { cwd: outDir });
    await writeJsonAtomic(
      path.join(paths.provider, `submit-${String(task.submit_attempts).padStart(2, "0")}.json`),
      summarizeCliResponse(submitted),
    );
    const submitId = extractSubmitId(submitted.parsed);
    const submitStatus = extractGenStatus(submitted.parsed);
    if (submitId) {
      task.submit_id = submitId;
      task.gen_status = submitStatus || "querying";
      task.initial_gen_status = task.gen_status;
      task.local_status = "submitted";
      task.submit_warning = FAILURE_STATUSES.has(submitStatus) ? {
        status: submitStatus,
        reason: extractFailureReason(submitted.parsed) || "Dreamina initially reported a failed task.",
        recorded_at: now(),
      } : null;
      task.submitted_at = now();
      task.updated_at = now();
      await writeJsonAtomic(paths.task, task);
    } else if (submitted.exitCode !== 0 || submitted.timedOut || submitted.error) {
      return await saveFailure(
        paths,
        options,
        requestPath,
        request,
        prompt,
        task,
        classifyDreaminaFailure({
          phase: "submit",
          exitCode: submitted.exitCode,
          signal: submitted.signal,
          timedOut: submitted.timedOut,
          error: submitted.error,
          stdout: submitted.stdout,
          stderr: submitted.stderr,
        }),
      );
    } else {
      return await saveFailure(
        paths,
        options,
        requestPath,
        request,
        prompt,
        task,
        new DreaminaImageError(
          "SUBMISSION_UNKNOWN",
          "Dreamina returned without a trustworthy submit_id. This run will not submit again.",
        ),
      );
    }
  }

  const pollIntervalMs = parseInteger(
    process.env.DREAMINA_IMAGE_POLL_INTERVAL_MS,
    3_000,
    10,
    60_000,
    "DREAMINA_IMAGE_POLL_INTERVAL_MS",
  );
  const deadline = Date.now() + options.waitSeconds * 1_000;
  let queryIndex = 0;
  let lastQueryError = null;
  let materializeFailures = 0;
  while (true) {
    task.query_attempts = Number(task.query_attempts || 0) + 1;
    task.last_queried_at = now();
    task.updated_at = now();
    await writeJsonAtomic(paths.task, task);
    const queried = await runDreamina([
      "query_result",
      `--submit_id=${task.submit_id}`,
      `--download_dir=${paths.providerOutput}`,
    ], { cwd: outDir });
    await writeJsonAtomic(
      path.join(paths.provider, `query-${String(task.query_attempts).padStart(4, "0")}.json`),
      summarizeCliResponse(queried),
    );
    const queryStatus = extractGenStatus(queried.parsed);
    if (queryStatus) task.gen_status = queryStatus;
    task.updated_at = now();

    if (FAILURE_STATUSES.has(queryStatus)) {
      return await saveFailure(
        paths,
        options,
        requestPath,
        request,
        prompt,
        task,
        new DreaminaImageError(
          "GENERATION_FAILED",
          extractFailureReason(queried.parsed) || "Dreamina reported that image generation failed.",
        ),
      );
    }
    if (queried.exitCode !== 0 || queried.timedOut || queried.error) {
      lastQueryError = classifyDreaminaFailure({
        phase: "query",
        exitCode: queried.exitCode,
        signal: queried.signal,
        timedOut: queried.timedOut,
        error: queried.error,
        stdout: queried.stdout,
        stderr: queried.stderr,
      });
      if (["AUTH_REQUIRED", "INSUFFICIENT_CREDIT", "COMPLIANCE_CONFIRMATION_REQUIRED"].includes(lastQueryError.code)) {
        return await saveFailure(paths, options, requestPath, request, prompt, task, lastQueryError);
      }
      task.local_status = "pending";
      task.error = errorRecord(lastQueryError);
      task.failure = dreaminaFailurePolicy(lastQueryError, { hasTask: true }).failure;
      task.recovery = pendingRecovery();
      await writeJsonAtomic(paths.task, task);
    } else if (SUCCESS_STATUSES.has(queryStatus)) {
      try {
        return await materializeOutput(paths, options, requestPath, request, prompt, task, submit.ratio);
      } catch (error) {
        const normalized = error instanceof DreaminaImageError
          ? error
          : new DreaminaImageError("DOWNLOAD_FAILED", error?.message || String(error));
        if (
          normalized.code === "DOWNLOAD_FAILED"
          && materializeFailures < SAFE_OPERATION_RETRIES
          && Date.now() < deadline
        ) {
          materializeFailures += 1;
          lastQueryError = normalized;
          task.local_status = "pending";
          task.error = errorRecord(normalized);
          task.failure = dreaminaFailurePolicy(normalized, { hasTask: true }).failure;
          task.recovery = pendingRecovery();
          await writeJsonAtomic(paths.task, task);
        } else {
          return await saveFailure(paths, options, requestPath, request, prompt, task, normalized);
        }
      }
    } else {
      task.local_status = "pending";
      task.error = null;
      task.failure = null;
      task.recovery = pendingRecovery();
      await writeJsonAtomic(paths.task, task);
    }

    const waitMs = Math.min(pollIntervalMs * (queryIndex + 1), 15_000);
    queryIndex += 1;
    if (Date.now() + waitMs > deadline) break;
    await sleep(waitMs);
  }

  const pending = {
    schema_version: "1.0",
    ok: true,
    status: "pending",
    request_path: requestPath,
    request,
    prompt,
    provider: {
      auth_mode: "dreamina-oauth",
      api_operation: request.reference_images.length ? "image2image" : "text2image",
      model: dreaminaModelLabel(task),
      prompt_compaction: task?.prompt_compaction || null,
      attempts: Number(task.submit_attempts || 1),
      request_id: task.submit_id,
      async_task: {
        task_id: task.submit_id,
        resumed: Boolean(existingTask),
        initial_status: task.initial_gen_status || "querying",
        final_status: task.gen_status || "querying",
        poll_count: Number(task.query_attempts || 0),
      },
    },
    routing: baseRouting(options),
    output: null,
    error: lastQueryError ? errorRecord(lastQueryError) : null,
    failure: lastQueryError
      ? dreaminaFailurePolicy(lastQueryError, { hasTask: true }).failure
      : null,
    recovery: pendingRecovery(),
    retry_after_ms: pollIntervalMs,
    review: {
      status: "not_run",
      note: "The Dreamina task is still running.",
    },
    timing: {
      started_at: task.created_at,
      completed_at: null,
      duration_ms: Date.now() - task.started_ms,
    },
  };
  await writeJsonAtomic(paths.result, pending);
  process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`);
  return pending;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) printHelp();
  else await runMain(options);
} catch (error) {
  const policy = dreaminaFailurePolicy(error, { hasTask: false });
  const payload = {
    ok: false,
    error: errorRecord(error),
    ...policy,
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
}
