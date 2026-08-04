#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { spawn } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(SCRIPT_DIR, "run-image.mjs");
const FAKE_DREAMINA = path.join(SCRIPT_DIR, "fixtures", "fake-dreamina-image.mjs");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function solidPng(width = 96, height = 64) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(width * 4, 255);
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), row])));
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function invoke(args, env, timeoutMs = 30_000) {
  return await new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [RUNNER, ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Condition was not met within ${timeoutMs} ms.`);
}

async function writeRequest(root, name, prompt, extra = {}) {
  const requestPath = path.join(root, `${name}.json`);
  await writeFile(requestPath, `${JSON.stringify({
    operation: "generate",
    prompt,
    aspect_ratio: "3:2",
    filename: name,
    count: 1,
    background: "opaque",
    ...extra,
  }, null, 2)}\n`, "utf8");
  return requestPath;
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-provider-fallback-"));
  const fakeState = path.join(root, "fake-dreamina-state.json");
  let image2Requests = 0;
  let image2AsyncPolls = 0;
  let image2AsyncReady = false;
  let referenceAttachmentRejects = 0;
  const image = solidPng();
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/tasks/image2-resume-task") {
      image2AsyncPolls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      if (image2AsyncReady) {
        response.end(JSON.stringify({ status: "completed", data: [{ b64_json: image.toString("base64") }] }));
      } else {
        response.end(JSON.stringify({ status: "processing", progress: 50 }));
      }
      return;
    }
    const isGenerationEndpoint = request.url?.endsWith("/images/generations");
    const isEditEndpoint = request.url?.endsWith("/images/edits");
    if (request.method !== "POST" || (!isGenerationEndpoint && !isEditEndpoint)) {
      response.writeHead(404).end();
      return;
    }
    image2Requests += 1;
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    const payload = JSON.parse(body);
    if (payload.prompt.includes("reference attachment rejection")) {
      if (isEditEndpoint && Array.isArray(payload.images) && payload.images.length === 1) {
        referenceAttachmentRejects += 1;
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Please upload the reference image so I can continue." } }));
    } else if (payload.prompt.includes("image2 pending resume")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ task_id: "image2-resume-task", status: "processing" }));
    } else if (payload.prompt.includes("safe-503")) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "provider unavailable" } }));
    } else if (payload.prompt.includes("gateway race exhausted")) {
      response.writeHead(504, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          code: "race_exhausted",
          message: "no provider completed before the race deadline",
          race_id: "race-smoke-1",
          rounds: "4",
          attempts: 7,
          provider_attempts: { "provider-a": 4, "provider-b": 3 },
        },
      }));
    } else if (payload.prompt.includes("unsafe-502")) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "upstream connection ended" } }));
    } else if (payload.prompt.includes("unsafe-504")) {
      response.writeHead(504, { "content-type": "text/html" });
      response.end("<html><title>504 Gateway Timeout</title></html>");
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "image2-success", data: [{ b64_json: image.toString("base64") }] }));
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  const baseEnv = {
    IMAGE_GEN_DISABLE_ENV_FILE: "true",
    IMAGE_GEN_DISABLE_CATSCO_GATEWAY: "true",
    IMAGE_GEN_API_BASE: `http://127.0.0.1:${port}/v1`,
    IMAGE_GEN_API_KEY: "smoke-key",
    IMAGE_GEN_ALLOW_INSECURE_HTTP: "true",
    IMAGE_GEN_MAX_RETRIES: "1",
    IMAGE_GEN_ASYNC_POLL_BASE: `http://127.0.0.1:${port}`,
    IMAGE_GEN_ASYNC_POLL_INTERVAL_MS: "10",
    IMAGE_GEN_ASYNC_TIMEOUT_MS: "1000",
    DREAMINA_CLI_BIN: process.execPath,
    DREAMINA_CLI_PREFIX_ARGS_JSON: JSON.stringify([FAKE_DREAMINA]),
    DREAMINA_CLI_TIMEOUT_MS: "5000",
    DREAMINA_IMAGE_WAIT_SECONDS: "1",
    DREAMINA_IMAGE_POLL_INTERVAL_MS: "10",
    DREAMINA_IMAGE_MODEL_VERSION: "4.7",
    DREAMINA_IMAGE_PROMPT_MAX_CHARS: "900",
    FAKE_DREAMINA_STATE: fakeState,
    FAKE_DREAMINA_SCENARIO: "success",
  };

  try {
    const directRequest = await writeRequest(root, "direct-dreamina", "direct dreamina test");
    const directRun = path.join(root, "direct-run");
    const direct = await invoke([
      "--provider", "dreamina",
      "--request", directRequest,
      "--out-dir", directRun,
    ], baseEnv);
    assert.equal(direct.code, 0, direct.stderr);
    const directResult = JSON.parse(await readFile(path.join(directRun, "result.json"), "utf8"));
    assert.equal(directResult.routing.selected_provider, "dreamina");
    assert.equal(directResult.routing.provider_role, "primary");
    assert.equal(directResult.status, "generated");
    const directTask = JSON.parse(await readFile(path.join(directRun, "dreamina-task.json"), "utf8"));
    assert.equal(directTask.run_id, path.basename(directRun));
    const directStateAfterGeneration = JSON.parse(await readFile(fakeState, "utf8"));
    assert.ok(directStateAfterGeneration.last_submit_args.includes("--resolution_type=2k"));
    assert.ok(directStateAfterGeneration.last_submit_args.includes("--model_version=4.7"));

    const inconsistentRequest = await writeRequest(
      root,
      "dreamina-inconsistent-submit",
      Array.from({ length: 12 }, (_, index) => (
        `Section ${index + 1}. Keep the subject, composition, lighting, palette, and output constraints from this section. `
        + "Add enough authored detail to exercise provider-specific prompt compaction without losing section coverage."
      )).join("\n\n"),
    );
    const inconsistentRun = path.join(root, "dreamina-inconsistent-submit-run");
    const inconsistentStatePath = path.join(root, "dreamina-inconsistent-submit-state.json");
    const inconsistent = await invoke([
      "--provider", "dreamina",
      "--request", inconsistentRequest,
      "--out-dir", inconsistentRun,
    ], {
      ...baseEnv,
      FAKE_DREAMINA_STATE: inconsistentStatePath,
      FAKE_DREAMINA_SCENARIO: "initial_fail_then_success",
    });
    assert.equal(inconsistent.code, 0, inconsistent.stderr);
    const inconsistentResult = JSON.parse(await readFile(path.join(inconsistentRun, "result.json"), "utf8"));
    const inconsistentTask = JSON.parse(await readFile(path.join(inconsistentRun, "dreamina-task.json"), "utf8"));
    const inconsistentState = JSON.parse(await readFile(inconsistentStatePath, "utf8"));
    const compactPromptArg = inconsistentState.last_submit_args.find((item) => item.startsWith("--prompt="));
    assert.equal(inconsistentResult.status, "generated");
    assert.equal(inconsistentResult.provider.async_task.initial_status, "fail");
    assert.equal(inconsistentResult.provider.async_task.final_status, "success");
    assert.equal(inconsistentState.submit_count, 1);
    assert.ok(inconsistentState.query_count >= 1);
    assert.equal(inconsistentTask.submit_warning.status, "fail");
    assert.equal(inconsistentTask.prompt_compaction.compacted, true);
    assert.ok(compactPromptArg.length - "--prompt=".length <= 900);

    const directStateBeforeRepair = JSON.parse(await readFile(fakeState, "utf8"));
    await writeFile(directResult.output.image_path, solidPng(48, 48));
    const repaired = await invoke([
      "--provider", "dreamina",
      "--request", directRequest,
      "--out-dir", directRun,
    ], baseEnv);
    assert.equal(repaired.code, 0, repaired.stderr);
    const repairedState = JSON.parse(await readFile(fakeState, "utf8"));
    const repairedResult = JSON.parse(await readFile(path.join(directRun, "result.json"), "utf8"));
    const repairedImage = await readFile(repairedResult.output.image_path);
    assert.equal(repairedState.submit_count, 1);
    assert.ok(repairedState.query_count > directStateBeforeRepair.query_count);
    assert.equal(createHash("sha256").update(repairedImage).digest("hex"), repairedResult.output.sha256);

    const reference = solidPng(64, 64);
    const referencePath = path.join(root, "reference.png");
    await writeFile(referencePath, reference);
    const referenceRequest = await writeRequest(root, "reference-dreamina", "preserve the reference identity", {
      aspect_ratio: "1:1",
      reference_images: [{
        path: "reference.png",
        sha256: createHash("sha256").update(reference).digest("hex"),
        media_type: "image/png",
        bytes: reference.length,
        width: 64,
        height: 64,
        use_for: "subject identity",
      }],
    });
    const referenceRun = path.join(root, "reference-run");
    const referenceResult = await invoke([
      "--provider", "dreamina",
      "--request", referenceRequest,
      "--out-dir", referenceRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: path.join(root, "reference-state.json") });
    assert.equal(referenceResult.code, 0, referenceResult.stderr);
    const referenceState = JSON.parse(await readFile(path.join(root, "reference-state.json"), "utf8"));
    assert.equal(referenceState.last_submit_command, "image2image");
    assert.ok(referenceState.last_submit_args.some((item) => item.startsWith("--images=")));
    assert.ok(referenceState.last_submit_args.includes("--resolution_type=2k"));

    const authRequest = await writeRequest(root, "auth", "auth test");
    const authRun = path.join(root, "auth-run");
    const authStatePath = path.join(root, "auth-state.json");
    const auth = await invoke([
      "--provider", "dreamina",
      "--request", authRequest,
      "--out-dir", authRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: authStatePath, FAKE_DREAMINA_SCENARIO: "empty_auth" });
    assert.equal(auth.code, 1);
    const authResult = JSON.parse(await readFile(path.join(authRun, "result.json"), "utf8"));
    assert.equal(authResult.status, "auth_required");
    let authState = JSON.parse(await readFile(authStatePath, "utf8"));
    assert.equal(authState.submit_count, 0);
    const afterLogin = await invoke([
      "--provider", "dreamina",
      "--request", authRequest,
      "--out-dir", authRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: authStatePath, FAKE_DREAMINA_SCENARIO: "success" });
    assert.equal(afterLogin.code, 0, afterLogin.stderr);
    authState = JSON.parse(await readFile(authStatePath, "utf8"));
    assert.equal(authState.submit_count, 1);

    const unknownRequest = await writeRequest(root, "dreamina-unknown", "unknown submit test");
    const unknownRun = path.join(root, "dreamina-unknown-run");
    const unknownStatePath = path.join(root, "unknown-state.json");
    const unknown = await invoke([
      "--provider", "dreamina",
      "--request", unknownRequest,
      "--out-dir", unknownRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: unknownStatePath, FAKE_DREAMINA_SCENARIO: "submission_unknown" });
    assert.equal(unknown.code, 1);
    const unknownAgain = await invoke([
      "--provider", "dreamina",
      "--request", unknownRequest,
      "--out-dir", unknownRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: unknownStatePath, FAKE_DREAMINA_SCENARIO: "success" });
    assert.equal(unknownAgain.code, 1);
    const unknownState = JSON.parse(await readFile(unknownStatePath, "utf8"));
    assert.equal(unknownState.submit_count, 1);
    const unknownResult = JSON.parse(await readFile(path.join(unknownRun, "result.json"), "utf8"));
    assert.equal(unknownResult.failure.submission_state, "unknown");
    assert.equal(unknownResult.recovery.requires_user_confirmation, true);

    const pendingRequest = await writeRequest(root, "dreamina-pending", "pending resume test");
    const pendingRun = path.join(root, "dreamina-pending-run");
    const pendingStatePath = path.join(root, "pending-state.json");
    const pending = await invoke([
      "--provider", "dreamina",
      "--request", pendingRequest,
      "--out-dir", pendingRun,
      "--wait-seconds", "0",
    ], { ...baseEnv, FAKE_DREAMINA_STATE: pendingStatePath, FAKE_DREAMINA_SCENARIO: "always_pending" });
    assert.equal(pending.code, 0, pending.stderr);
    const pendingResult = JSON.parse(await readFile(path.join(pendingRun, "result.json"), "utf8"));
    assert.equal(pendingResult.status, "pending");
    const resumedPending = await invoke([
      "--provider", "dreamina",
      "--request", pendingRequest,
      "--out-dir", pendingRun,
      "--wait-seconds", "1",
    ], { ...baseEnv, FAKE_DREAMINA_STATE: pendingStatePath, FAKE_DREAMINA_SCENARIO: "success" });
    assert.equal(resumedPending.code, 0, resumedPending.stderr);
    const pendingState = JSON.parse(await readFile(pendingStatePath, "utf8"));
    assert.equal(pendingState.submit_count, 1);
    assert.ok(pendingState.query_count >= 2);

    const creditRetryRequest = await writeRequest(root, "credit-retry", "credit preflight retry test");
    const creditRetryRun = path.join(root, "credit-retry-run");
    const creditRetryStatePath = path.join(root, "credit-retry-state.json");
    const creditRetry = await invoke([
      "--provider", "dreamina",
      "--request", creditRetryRequest,
      "--out-dir", creditRetryRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: creditRetryStatePath, FAKE_DREAMINA_SCENARIO: "credit_transient_once" });
    assert.equal(creditRetry.code, 0, creditRetry.stderr);
    const creditRetryState = JSON.parse(await readFile(creditRetryStatePath, "utf8"));
    assert.equal(creditRetryState.credit_count, 2);
    assert.equal(creditRetryState.submit_count, 1);

    const queryRetryRequest = await writeRequest(root, "query-retry", "query retry test");
    const queryRetryRun = path.join(root, "query-retry-run");
    const queryRetryStatePath = path.join(root, "query-retry-state.json");
    const queryRetry = await invoke([
      "--provider", "dreamina",
      "--request", queryRetryRequest,
      "--out-dir", queryRetryRun,
      "--wait-seconds", "5",
    ], { ...baseEnv, FAKE_DREAMINA_STATE: queryRetryStatePath, FAKE_DREAMINA_SCENARIO: "query_transient_once" });
    assert.equal(queryRetry.code, 0, queryRetry.stderr);
    const queryRetryState = JSON.parse(await readFile(queryRetryStatePath, "utf8"));
    assert.equal(queryRetryState.submit_count, 1);
    assert.ok(queryRetryState.query_count >= 2);

    const downloadRetryRequest = await writeRequest(root, "download-retry", "download retry test");
    const downloadRetryRun = path.join(root, "download-retry-run");
    const downloadRetryStatePath = path.join(root, "download-retry-state.json");
    const downloadRetry = await invoke([
      "--provider", "dreamina",
      "--request", downloadRetryRequest,
      "--out-dir", downloadRetryRun,
      "--wait-seconds", "5",
    ], { ...baseEnv, FAKE_DREAMINA_STATE: downloadRetryStatePath, FAKE_DREAMINA_SCENARIO: "download_missing_once" });
    assert.equal(downloadRetry.code, 0, downloadRetry.stderr);
    const downloadRetryState = JSON.parse(await readFile(downloadRetryStatePath, "utf8"));
    assert.equal(downloadRetryState.submit_count, 1);
    assert.ok(downloadRetryState.query_count >= 2);

    const queryAuthRequest = await writeRequest(root, "query-auth", "query authentication recovery test");
    const queryAuthRun = path.join(root, "query-auth-run");
    const queryAuthStatePath = path.join(root, "query-auth-state.json");
    const queryAuth = await invoke([
      "--provider", "dreamina",
      "--request", queryAuthRequest,
      "--out-dir", queryAuthRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: queryAuthStatePath, FAKE_DREAMINA_SCENARIO: "query_auth_required" });
    assert.equal(queryAuth.code, 1);
    const queryAuthResult = JSON.parse(await readFile(path.join(queryAuthRun, "result.json"), "utf8"));
    assert.equal(queryAuthResult.status, "auth_required");
    const queryAuthRecovered = await invoke([
      "--provider", "dreamina",
      "--request", queryAuthRequest,
      "--out-dir", queryAuthRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: queryAuthStatePath, FAKE_DREAMINA_SCENARIO: "success" });
    assert.equal(queryAuthRecovered.code, 0, queryAuthRecovered.stderr);
    const queryAuthState = JSON.parse(await readFile(queryAuthStatePath, "utf8"));
    assert.equal(queryAuthState.submit_count, 1);
    assert.ok(queryAuthState.query_count >= 2);

    const missingRequest = await writeRequest(root, "missing-download", "missing download recovery test");
    const missingRun = path.join(root, "missing-download-run");
    const missingStatePath = path.join(root, "missing-download-state.json");
    const missing = await invoke([
      "--provider", "dreamina",
      "--request", missingRequest,
      "--out-dir", missingRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: missingStatePath, FAKE_DREAMINA_SCENARIO: "download_missing" });
    assert.equal(missing.code, 1);
    const missingResult = JSON.parse(await readFile(path.join(missingRun, "result.json"), "utf8"));
    assert.equal(missingResult.status, "download_failed");
    const missingRecovered = await invoke([
      "--provider", "dreamina",
      "--request", missingRequest,
      "--out-dir", missingRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: missingStatePath, FAKE_DREAMINA_SCENARIO: "success" });
    assert.equal(missingRecovered.code, 0, missingRecovered.stderr);
    const missingState = JSON.parse(await readFile(missingStatePath, "utf8"));
    assert.equal(missingState.submit_count, 1);

    const corruptRequest = await writeRequest(root, "corrupt-download", "corrupt download recovery test");
    const corruptRun = path.join(root, "corrupt-download-run");
    const corruptStatePath = path.join(root, "corrupt-download-state.json");
    const corrupt = await invoke([
      "--provider", "dreamina",
      "--request", corruptRequest,
      "--out-dir", corruptRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: corruptStatePath, FAKE_DREAMINA_SCENARIO: "corrupt_download" });
    assert.equal(corrupt.code, 1);
    const corruptResult = JSON.parse(await readFile(path.join(corruptRun, "result.json"), "utf8"));
    assert.equal(corruptResult.status, "download_failed");
    const corruptProviderFiles = await readdir(path.join(corruptRun, "dreamina-provider-output"));
    assert.equal(corruptProviderFiles.some((name) => /\.(png|jpe?g|webp)$/i.test(name)), false);
    const corruptRecovered = await invoke([
      "--provider", "dreamina",
      "--request", corruptRequest,
      "--out-dir", corruptRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: corruptStatePath, FAKE_DREAMINA_SCENARIO: "success" });
    assert.equal(corruptRecovered.code, 0, corruptRecovered.stderr);
    const corruptState = JSON.parse(await readFile(corruptStatePath, "utf8"));
    assert.equal(corruptState.submit_count, 1);

    const image2PendingRequest = await writeRequest(root, "image2-pending", "image2 pending resume test");
    const image2PendingRun = path.join(root, "image2-pending-run");
    const beforeImage2Pending = image2Requests;
    const image2Pending = await invoke([
      "--provider", "auto",
      "--request", image2PendingRequest,
      "--out-dir", image2PendingRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: path.join(root, "image2-pending-unused.json") }, 10_000);
    assert.equal(image2Pending.code, 1);
    assert.equal(image2Requests - beforeImage2Pending, 1);
    const image2PendingProviderState = JSON.parse(await readFile(path.join(image2PendingRun, "provider-state.json"), "utf8"));
    assert.equal(image2PendingProviderState.status, "image2_pending");
    const image2PendingRecovery = JSON.parse(await readFile(path.join(image2PendingRun, "provider-error.json"), "utf8"));
    assert.equal(image2PendingRecovery.recovery.can_resume_same_task, true);
    assert.equal(image2PendingRecovery.recovery.requires_user_confirmation, false);
    image2AsyncReady = true;
    const image2PendingRecovered = await invoke([
      "--provider", "auto",
      "--request", image2PendingRequest,
      "--out-dir", image2PendingRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: path.join(root, "image2-pending-unused.json") });
    assert.equal(image2PendingRecovered.code, 0, image2PendingRecovered.stderr);
    assert.equal(image2Requests - beforeImage2Pending, 1);
    assert.ok(image2AsyncPolls >= 2);

    const interruptedRequest = await writeRequest(root, "interrupted-query", "interrupted query recovery test");
    const interruptedRun = path.join(root, "interrupted-query-run");
    const interruptedStatePath = path.join(root, "interrupted-query-state.json");
    const interruptedArgs = [
      RUNNER,
      "--provider", "dreamina",
      "--request", interruptedRequest,
      "--out-dir", interruptedRun,
      "--wait-seconds", "30",
    ];
    const interruptedChild = spawn(process.execPath, interruptedArgs, {
      env: {
        ...process.env,
        ...baseEnv,
        FAKE_DREAMINA_STATE: interruptedStatePath,
        FAKE_DREAMINA_SCENARIO: "query_hang",
      },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let interruptedStdout = "";
    let interruptedStderr = "";
    interruptedChild.stdout.on("data", (chunk) => { interruptedStdout += chunk.toString("utf8"); });
    interruptedChild.stderr.on("data", (chunk) => { interruptedStderr += chunk.toString("utf8"); });
    try {
      await waitFor(async () => {
        const task = await readFile(path.join(interruptedRun, "dreamina-task.json"), "utf8")
          .then(JSON.parse)
          .catch(() => null);
        const state = await readFile(interruptedStatePath, "utf8").then(JSON.parse).catch(() => null);
        if (task?.submit_id && state?.query_count >= 1) return true;
        if (interruptedChild.exitCode != null || interruptedChild.signalCode != null) {
          throw new Error(`Interrupted-query child exited before its resumable checkpoint (exit=${interruptedChild.exitCode}, signal=${interruptedChild.signalCode}, stdout=${interruptedStdout.trim()}, stderr=${interruptedStderr.trim()}).`);
        }
        return false;
      }, 30_000);
    } catch (error) {
      throw new Error(`${error.message} Child stdout: ${interruptedStdout.trim() || "<empty>"}; child stderr: ${interruptedStderr.trim() || "<empty>"}.`);
    }
    interruptedChild.kill();
    await new Promise((resolveClose) => interruptedChild.once("close", resolveClose));
    const interruptedRecovered = await invoke([
      "--provider", "dreamina",
      "--request", interruptedRequest,
      "--out-dir", interruptedRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: interruptedStatePath, FAKE_DREAMINA_SCENARIO: "success" });
    assert.equal(interruptedRecovered.code, 0, interruptedRecovered.stderr);
    const interruptedState = JSON.parse(await readFile(interruptedStatePath, "utf8"));
    assert.equal(interruptedState.submit_count, 1);

    const beforeSafe = image2Requests;
    const safeRequest = await writeRequest(root, "safe-fallback", "safe-503 fallback test");
    const safeRun = path.join(root, "safe-run");
    const safe = await invoke([
      "--provider", "auto",
      "--request", safeRequest,
      "--out-dir", safeRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: path.join(root, "safe-state.json") });
    assert.equal(safe.code, 0, safe.stderr);
    assert.equal(image2Requests - beforeSafe, 1);
    const safeResult = JSON.parse(await readFile(path.join(safeRun, "result.json"), "utf8"));
    assert.equal(safeResult.routing.provider_role, "fallback");
    assert.equal(safeResult.routing.fallback_from, "image2");
    assert.equal(safeResult.routing.fallback_reason, "service_unavailable");

    const beforeRaceExhausted = image2Requests;
    const raceExhaustedRequest = await writeRequest(root, "race-exhausted", "gateway race exhausted fallback test");
    const raceExhaustedRun = path.join(root, "race-exhausted-run");
    const raceGatewayEnv = {
      ...baseEnv,
      CATSCO_IMAGE_API_BASE: `http://127.0.0.1:${port}/v1`,
      CATSCO_USER_TOKEN: "catsco-user-token",
      IMAGE_GEN_ASYNC_SUBMIT: "true",
    };
    delete raceGatewayEnv.IMAGE_GEN_DISABLE_CATSCO_GATEWAY;
    const raceExhausted = await invoke([
      "--provider", "auto",
      "--request", raceExhaustedRequest,
      "--out-dir", raceExhaustedRun,
    ], { ...raceGatewayEnv, FAKE_DREAMINA_STATE: path.join(root, "race-exhausted-state.json") });
    assert.equal(raceExhausted.code, 0, raceExhausted.stderr);
    assert.equal(image2Requests - beforeRaceExhausted, 1);
    const raceExhaustedImage2Error = JSON.parse(await readFile(path.join(raceExhaustedRun, "image2-error.json"), "utf8"));
    assert.equal(raceExhaustedImage2Error.error.code, "IMAGE_RACE_EXHAUSTED");
    assert.equal(raceExhaustedImage2Error.error.details.race_id, "race-smoke-1");
    assert.equal(raceExhaustedImage2Error.error.details.attempts, 7);
    assert.deepEqual(raceExhaustedImage2Error.error.details.provider_attempts, { "provider-a": 4, "provider-b": 3 });
    assert.equal(raceExhaustedImage2Error.failure.submission_state, "exhausted");
    assert.equal(raceExhaustedImage2Error.failure.fallback_safe, true);
    assert.equal(raceExhaustedImage2Error.recovery.duplicate_generation_risk, true);
    const raceExhaustedResult = JSON.parse(await readFile(path.join(raceExhaustedRun, "result.json"), "utf8"));
    assert.equal(raceExhaustedResult.routing.selected_provider, "dreamina");
    assert.equal(raceExhaustedResult.routing.fallback_reason, "image2_race_exhausted");

    const beforeReferenceReject = image2Requests;
    const referenceRejectStatePath = path.join(root, "reference-reject-state.json");
    const referenceRejectRequest = await writeRequest(
      root,
      "reference-reject",
      "reference attachment rejection fallback test",
      {
        aspect_ratio: "1:1",
        reference_images: [{
          path: "reference.png",
          sha256: createHash("sha256").update(reference).digest("hex"),
          media_type: "image/png",
          bytes: reference.length,
          width: 64,
          height: 64,
          use_for: "subject identity",
        }],
      },
    );
    const referenceRejectRun = path.join(root, "reference-reject-run");
    const referenceReject = await invoke([
      "--provider", "auto",
      "--request", referenceRejectRequest,
      "--out-dir", referenceRejectRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: referenceRejectStatePath });
    assert.equal(referenceReject.code, 0, referenceReject.stderr);
    assert.equal(image2Requests - beforeReferenceReject, 1);
    assert.equal(referenceAttachmentRejects, 1);
    const referenceRejectState = JSON.parse(await readFile(referenceRejectStatePath, "utf8"));
    assert.equal(referenceRejectState.submit_count, 1);
    const referenceRejectResult = JSON.parse(await readFile(path.join(referenceRejectRun, "result.json"), "utf8"));
    assert.equal(referenceRejectResult.routing.fallback_reason, "reference_attachment_rejected");

    const beforeTextReject = image2Requests;
    const textRejectStatePath = path.join(root, "text-reject-state.json");
    const textRejectRequest = await writeRequest(root, "text-reject", "reference attachment rejection text-only control");
    const textRejectRun = path.join(root, "text-reject-run");
    const textReject = await invoke([
      "--provider", "auto",
      "--request", textRejectRequest,
      "--out-dir", textRejectRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: textRejectStatePath });
    assert.equal(textReject.code, 1);
    assert.equal(image2Requests - beforeTextReject, 1);
    assert.equal(await readFile(textRejectStatePath, "utf8").then(() => true).catch(() => false), false);
    const textRejectError = JSON.parse(await readFile(path.join(textRejectRun, "provider-error.json"), "utf8"));
    assert.equal(textRejectError.failure.submission_state, "not_submitted");
    assert.equal(textRejectError.failure.fallback_safe, false);
    assert.equal(textRejectError.recovery.next_action, "fix_request");

    const beforeUnsafe = image2Requests;
    const unsafeStatePath = path.join(root, "unsafe-state.json");
    const unsafeRequest = await writeRequest(root, "unsafe", "unsafe-504 no fallback test");
    const unsafeRun = path.join(root, "unsafe-run");
    const unsafe = await invoke([
      "--provider", "auto",
      "--request", unsafeRequest,
      "--out-dir", unsafeRun,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: unsafeStatePath });
    assert.equal(unsafe.code, 1);
    assert.equal(image2Requests - beforeUnsafe, 1);
    assert.equal(await readFile(unsafeStatePath, "utf8").then(() => true).catch(() => false), false);
    const providerState = JSON.parse(await readFile(path.join(unsafeRun, "provider-state.json"), "utf8"));
    assert.equal(providerState.status, "image2_submission_unknown");
    const unsafeRecovery = JSON.parse(await readFile(path.join(unsafeRun, "provider-error.json"), "utf8"));
    assert.equal(unsafeRecovery.failure.submission_state, "unknown");
    assert.equal(unsafeRecovery.recovery.next_action, "confirm_new_dreamina_run");
    assert.equal(unsafeRecovery.recovery.duplicate_generation_risk, true);

    const beforeUnsafe502 = image2Requests;
    const unsafe502StatePath = path.join(root, "unsafe-502-state.json");
    const unsafe502Request = await writeRequest(root, "unsafe-502", "unsafe-502 no retry or fallback test");
    const unsafe502Run = path.join(root, "unsafe-502-run");
    const unsafe502 = await invoke([
      "--provider", "auto",
      "--request", unsafe502Request,
      "--out-dir", unsafe502Run,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: unsafe502StatePath });
    assert.equal(unsafe502.code, 1);
    assert.equal(image2Requests - beforeUnsafe502, 1);
    assert.equal(await readFile(unsafe502StatePath, "utf8").then(() => true).catch(() => false), false);
    const unsafe502ProviderState = JSON.parse(await readFile(path.join(unsafe502Run, "provider-state.json"), "utf8"));
    assert.equal(unsafe502ProviderState.status, "image2_submission_unknown");

    const beforeSuccess = image2Requests;
    const image2Request = await writeRequest(root, "image2", "normal image2 success test");
    const image2Run = path.join(root, "image2-run");
    const image2 = await invoke([
      "--provider", "auto",
      "--request", image2Request,
      "--out-dir", image2Run,
    ], { ...baseEnv, FAKE_DREAMINA_STATE: path.join(root, "image2-unused-state.json") });
    assert.equal(image2.code, 0, image2.stderr);
    assert.equal(image2Requests - beforeSuccess, 1);
    const image2Result = JSON.parse(await readFile(path.join(image2Run, "result.json"), "utf8"));
    assert.equal(image2Result.routing.selected_provider, "image2");
    assert.equal(image2Result.routing.fallback_used, false);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      checks: [
        "explicit Dreamina text-to-image",
        "Dreamina reference image-to-image",
        "auth-required resume after administrator login",
        "Dreamina unknown submission blocks resubmit",
        "Dreamina pending task resumes by submit_id",
        "Dreamina initial failure with submit_id is verified by query before terminal failure",
        "Dreamina long prompts are compacted for the validated text-to-image route",
        "Dreamina transient credit preflight retries safely",
        "Dreamina transient query retries the same task",
        "Dreamina missing download retries the same task",
        "Dreamina query authentication recovery reuses submit_id",
        "Dreamina missing download recovery reuses submit_id",
        "Dreamina corrupt download cache is removed and recovered",
        "Dreamina tampered output is repaired from the original task",
        "Dreamina query interruption resumes after process restart",
        "Image2 pending task resumes without fallback or resubmission",
        "HTTP 503 safe automatic fallback",
        "CatsCo Image2 race exhaustion automatically falls back once",
        "reference edits explicit attachment rejection safely falls back once",
        "text-only HTTP 400 never inherits reference fallback",
        "HTTP 502 never retries or falls back",
        "HTTP 504 never falls back",
        "normal Image2 success remains primary",
      ],
    }, null, 2)}\n`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error?.stack || String(error) }, null, 2)}\n`);
  process.exitCode = 1;
});
