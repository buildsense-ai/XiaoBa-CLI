#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const preparerPath = path.join(scriptDir, "prepare-request.mjs");
const generatorPath = path.join(scriptDir, "generate-image.mjs");
const reviewerPath = path.join(scriptDir, "record-review.mjs");
const delivererPath = path.join(scriptDir, "deliver-asset.mjs");
const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "image-asset-generator-"));
  const requestPath = path.join(tempRoot, "request.json");
  const rawRequestPath = path.join(tempRoot, "raw-request.txt");
  const authoredPromptPath = path.join(tempRoot, "prompt.txt");
  const legacyBriefPath = path.join(tempRoot, "legacy-brief.txt");
  const preparedRequestPath = path.join(tempRoot, "prepared-request.json");
  const autoLayoutRequestPath = path.join(tempRoot, "auto-layout-request.json");
  const legacyPreparedRequestPath = path.join(tempRoot, "legacy-prepared-request.json");
  const minimalBriefRequestPath = path.join(tempRoot, "minimal-brief-request.json");
  const sizeOnlyRequestPath = path.join(tempRoot, "size-only-request.json");
  const mismatchedRatioRequestPath = path.join(tempRoot, "mismatched-ratio-request.json");
  const urlRequestPath = path.join(tempRoot, "url-request.json");
  const oversizedRequestPath = path.join(tempRoot, "oversized-request.json");
  const timeoutRequestPath = path.join(tempRoot, "timeout-request.json");
  const gatewayTimeoutRequestPath = path.join(tempRoot, "gateway-timeout-request.json");
  const malformedRequestPath = path.join(tempRoot, "malformed-request.json");
  const asyncRequestPath = path.join(tempRoot, "async-request.json");
  const asyncResumeRequestPath = path.join(tempRoot, "async-resume-request.json");
  const alternateAsyncResumeRequestPath = path.join(tempRoot, "alternate-async-resume-request.json");
  const envFileRequestPath = path.join(tempRoot, "env-file-request.json");
  const reviewPath = path.join(tempRoot, "review.json");
  const invalidReviewPath = path.join(tempRoot, "invalid-review.json");
  const outputDir = path.join(tempRoot, "output");
  const urlOutputDir = path.join(tempRoot, "url-output");
  const oversizedOutputDir = path.join(tempRoot, "oversized-output");
  const asyncOutputDir = path.join(tempRoot, "async-output");
  const asyncResumeOutputDir = path.join(tempRoot, "async-resume-output");
  const envFileOutputDir = path.join(tempRoot, "env-file-output");
  const catsCoGatewayOutputDir = path.join(tempRoot, "catsco-gateway-output");
  const catsCoBotGatewayOutputDir = path.join(tempRoot, "catsco-bot-gateway-output");
  const catsCoIdentityFallbackOutputDir = path.join(tempRoot, "catsco-identity-fallback-output");
  const envFileRuntimeRoot = path.join(tempRoot, "runtime root");
  let receivedPayload;
  let urlAttempts = 0;
  let urlDownloadAttempts = 0;
  let oversizedAttempts = 0;
  let timeoutAttempts = 0;
  let gatewayTimeoutAttempts = 0;
  let malformedAttempts = 0;
  let asyncPolls = 0;
  let asyncResumePolls = 0;
  let asyncResumeReady = false;
  let envFileAttempts = 0;
  let catsCoGatewayAttempts = 0;
  let catsCoBotGatewayAttempts = 0;
  let catsCoRejectedBotAttempts = 0;
  let catsCoFallbackUserAttempts = 0;
  let postCount = 0;

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/generated.png") {
      urlDownloadAttempts += 1;
      if (urlDownloadAttempts === 1) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "temporary download failure" } }));
        return;
      }
      const image = Buffer.from(tinyPngBase64, "base64");
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(image.length),
      });
      response.end(image);
      return;
    }
    if (request.method === "GET" && request.url === "/oversized-image.bin") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.alloc(700));
      response.end(Buffer.alloc(700));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/tasks/task-smoke") {
      assert.equal(request.headers.authorization, "Bearer smoke-secret");
      asyncPolls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      if (asyncPolls === 1) {
        response.end(JSON.stringify({ status: "processing", progress: 50 }));
      } else {
        response.end(JSON.stringify({ created: Date.now(), data: [{ url: `http://${request.headers.host}/generated.png` }] }));
      }
      return;
    }
    if (request.method === "GET" && request.url === "/v1/tasks/task-resume-smoke") {
      assert.equal(request.headers.authorization, "Bearer smoke-secret");
      asyncResumePolls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      if (!asyncResumeReady) {
        response.end(JSON.stringify({ status: "processing", progress: 50 }));
      } else {
        response.end(JSON.stringify({ created: Date.now(), data: [{ url: `http://${request.headers.host}/generated.png` }] }));
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/images/generations") {
      response.writeHead(404).end();
      return;
    }
    assert.ok([
      "Bearer smoke-secret",
      "Bearer env-file-secret",
      "Bearer catsco-user-login",
      "ApiKey catsco-bot-key",
      "ApiKey catsco-stale-bot-key",
      "Bearer catsco-fallback-user",
    ].includes(request.headers.authorization));
    postCount += 1;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    await once(request, "end");
    receivedPayload = JSON.parse(body);
    if (receivedPayload.prompt.includes("Environment file response test")) {
      assert.equal(request.headers.authorization, "Bearer env-file-secret");
      envFileAttempts += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "env-file-request", data: [{ b64_json: tinyPngBase64 }] }));
      return;
    }
    if (request.headers.authorization === "Bearer catsco-user-login") {
      catsCoGatewayAttempts += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "catsco-gateway-request", data: [{ b64_json: tinyPngBase64 }] }));
      return;
    }
    if (request.headers.authorization === "ApiKey catsco-bot-key") {
      catsCoBotGatewayAttempts += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "catsco-bot-gateway-request", data: [{ b64_json: tinyPngBase64 }] }));
      return;
    }
    if (request.headers.authorization === "ApiKey catsco-stale-bot-key") {
      catsCoRejectedBotAttempts += 1;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.headers.authorization === "Bearer catsco-fallback-user") {
      catsCoFallbackUserAttempts += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "catsco-identity-fallback-request", data: [{ b64_json: tinyPngBase64 }] }));
      return;
    }
    assert.equal(request.headers.authorization, "Bearer smoke-secret");
    if (receivedPayload.prompt.includes("Async response test")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ task_id: "task-smoke", status: "processing", progress: 0 }));
      return;
    }
    if (receivedPayload.prompt.includes("Async resume test")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ task_id: "task-resume-smoke", status: "processing", progress: 0 }));
      return;
    }
    if (receivedPayload.prompt.includes("Malformed response test")) {
      malformedAttempts += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "failed", error: { code: "mock_error", message: "mock provider failure" }, data: [] }));
      return;
    }
    if (receivedPayload.prompt.includes("Gateway timeout response test")) {
      gatewayTimeoutAttempts += 1;
      response.writeHead(524, { "content-type": "text/html" });
      response.end("<html><title>524: A timeout occurred</title></html>");
      return;
    }
    if (receivedPayload.prompt.includes("Timeout response test")) {
      timeoutAttempts += 1;
      setTimeout(() => {
        if (response.writableEnded || response.destroyed) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ b64_json: tinyPngBase64 }] }));
      }, 1_500);
      return;
    }
    if (receivedPayload.prompt.includes("Oversized URL response test")) {
      oversizedAttempts += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "oversized-url-request",
        data: [{ url: `http://${request.headers.host}/oversized-image.bin` }],
      }));
      return;
    }
    if (receivedPayload.prompt.includes("URL response test")) {
      urlAttempts += 1;
      if (urlAttempts === 1) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        response.end(JSON.stringify({ error: { message: "retry once" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "url-smoke-request",
        data: [{ url: `http://${request.headers.host}/generated.png` }],
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "smoke-request",
      data: [{ b64_json: tinyPngBase64, revised_prompt: "mock revised prompt" }],
    }));
  });

  try {
    await mkdir(outputDir, { recursive: true });
    const rawRequestText = "给一篇讲远程协作的文章生成一张 16:9 横版封面图，主体是四个工作台通过光线连接，不要人物、文字、Logo 或水印。";
    const authoredPromptText = "Create a restrained 16:9 editorial cover showing four distinct workstations connected by thin paths of light. No people, written text, logos, watermarks, or office stock-photo styling.";
    await writeFile(rawRequestPath, rawRequestText, "utf8");
    await writeFile(authoredPromptPath, authoredPromptText, "utf8");
    await writeFile(legacyBriefPath, rawRequestText, "utf8");
    await writeFile(minimalBriefRequestPath, `\uFEFF${JSON.stringify({
      operation: "generate",
      prompt: "请生成一张放在读书笔记页面顶部的雨夜窗边插图，不要文字。",
      aspect_ratio: "16:9",
      filename: "rainy-reading-notes",
    }, null, 2)}\n`);
    await writeFile(sizeOnlyRequestPath, `${JSON.stringify({
      operation: "generate",
      prompt: "Size-only aspect ratio derivation test",
      size: "1920x1080",
      filename: "size-only",
    }, null, 2)}\n`);
    await writeFile(mismatchedRatioRequestPath, `${JSON.stringify({
      operation: "generate",
      prompt: "Mismatched aspect ratio test",
      aspect_ratio: "1:1",
      size: "1920x1080",
      filename: "mismatched-ratio",
    }, null, 2)}\n`);
    await writeFile(requestPath, `${JSON.stringify({
      operation: "generate",
      prompt: "A cloud agent maintaining a team dashboard. Do not add people or an office scene.",
      purpose: "website hero",
      subject: "a cloud agent maintaining a team dashboard",
      style: "clean editorial illustration",
      creative_freedom: "strict",
      must_include: ["dashboard", "digital assistant"],
      must_avoid: ["watermark"],
      filename: "cloud-agent-dashboard",
    }, null, 2)}\n`);
    await writeFile(urlRequestPath, `${JSON.stringify({
      operation: "generate",
      prompt: "URL response test",
      filename: "url-result",
    }, null, 2)}\n`);
    await writeFile(oversizedRequestPath, `${JSON.stringify({
      operation: "generate",
      prompt: "Oversized URL response test",
      filename: "oversized-result",
    }, null, 2)}\n`);
    await writeFile(timeoutRequestPath, `${JSON.stringify({
      operation: "generate",
      prompt: "Timeout response test",
      filename: "timeout-result",
    }, null, 2)}\n`);
    await writeFile(gatewayTimeoutRequestPath, `${JSON.stringify({
      operation: "generate",
      prompt: "Gateway timeout response test",
      filename: "gateway-timeout-result",
    }, null, 2)}\n`);
    await writeFile(malformedRequestPath, `${JSON.stringify({
      operation: "generate",
      prompt: "Malformed response test",
      filename: "malformed-result",
    }, null, 2)}\n`);
    await writeFile(asyncRequestPath, `${JSON.stringify({
      operation: "generate",
      prompt: "Async response test",
      filename: "async-result",
    }, null, 2)}\n`);
    const asyncResumeRequestText = `${JSON.stringify({
      operation: "generate",
      prompt: "Async resume test",
      filename: "async-resume-result",
    }, null, 2)}\n`;
    await writeFile(asyncResumeRequestPath, asyncResumeRequestText);
    await writeFile(alternateAsyncResumeRequestPath, asyncResumeRequestText);
    await writeFile(envFileRequestPath, `${JSON.stringify({
      operation: "generate",
      prompt: "Environment file response test",
      filename: "env-file-result",
    }, null, 2)}\n`);
    await writeFile(reviewPath, `${JSON.stringify({
      status: "passed_with_notes",
      method: "multimodal_visual_inspection",
      summary: "The subject and composition match; tiny labels remain unverified.",
      checks: [
        { name: "subject", outcome: "pass", note: "The requested subject is visible." },
        { name: "small_text", outcome: "uncertain", note: "Tiny labels cannot be verified." },
      ],
      issues: [
        { severity: "warning", code: "SMALL_TEXT_UNVERIFIED", message: "Do not rely on tiny generated labels." },
      ],
    }, null, 2)}\n`);
    await writeFile(invalidReviewPath, `${JSON.stringify({
      status: "passed",
      method: "multimodal_visual_inspection",
      summary: "Invalid contradictory review.",
      checks: [{ name: "subject", outcome: "fail", note: "Subject is missing." }],
      issues: [],
    }, null, 2)}\n`);

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.equal(typeof address, "object");
    const apiBase = `http://127.0.0.1:${address.port}/v1`;

    await mkdir(envFileRuntimeRoot, { recursive: true });
    await writeFile(path.join(envFileRuntimeRoot, ".env"), [
      "IMAGE_GEN_API_KEY=env-file-secret",
      `IMAGE_GEN_API_BASE=${apiBase}`,
      "IMAGE_GEN_MODEL=env-file-model",
      "IMAGE_GEN_MAX_RETRIES=0",
      "IMAGE_GEN_ALLOW_INSECURE_HTTP=true",
      "IMAGE_GEN_DISABLE_CATSCO_GATEWAY=true",
    ].join("\n") + "\n");

    const envFileProcessEnv = {
      ...process.env,
      XIAOBA_USER_DATA_DIR: envFileRuntimeRoot,
    };
    for (const name of [
      "CATSCO_IMAGE_API_BASE",
      "CATSCO_HTTP_BASE_URL",
      "CATSCOMPANY_HTTP_BASE_URL",
      "CATSCO_API_KEY",
      "CATSCOMPANY_API_KEY",
      "CATSCO_USER_TOKEN",
      "CATSCOMPANY_USER_TOKEN",
      "IMAGE_GEN_API_KEY",
      "OPENAI_API_KEY",
      "IMAGE_GEN_API_BASE",
      "IMAGE_GEN_MODEL",
      "IMAGE_GEN_TIMEOUT_MS",
      "IMAGE_GEN_MAX_RETRIES",
      "IMAGE_GEN_RETRY_DELAY_MS",
      "IMAGE_GEN_MAX_IMAGE_BYTES",
      "IMAGE_GEN_ALLOW_INSECURE_HTTP",
      "IMAGE_GEN_DISABLE_CATSCO_GATEWAY",
      "IMAGE_GEN_ASYNC_SUBMIT",
      "IMAGE_GEN_ASYNC_POLL_BASE",
      "IMAGE_GEN_ASYNC_POLL_INTERVAL_MS",
      "IMAGE_GEN_ASYNC_TIMEOUT_MS",
      "IMAGE_GEN_ENV_FILE",
      "IMAGE_GEN_DISABLE_ENV_FILE",
    ]) delete envFileProcessEnv[name];
    const envFileRun = await runNode([
      generatorPath,
      "--request",
      envFileRequestPath,
      "--out-dir",
      envFileOutputDir,
    ], envFileProcessEnv);
    assert.equal(envFileRun.code, 0, envFileRun.stderr);
    assert.equal(envFileAttempts, 1);
    const envFileResult = JSON.parse(await readFile(path.join(envFileOutputDir, "result.json"), "utf8"));
    assert.equal(envFileResult.provider.model, "env-file-model");
    assert.equal(envFileResult.provider.endpoint_origin, `http://127.0.0.1:${address.port}`);
    assert.equal(JSON.stringify(envFileResult).includes("env-file-secret"), false);

    const successEnv = {
      ...process.env,
      IMAGE_GEN_API_BASE: apiBase,
      IMAGE_GEN_API_KEY: "smoke-secret",
      IMAGE_GEN_MODEL: "mock-image-model",
      IMAGE_GEN_MAX_RETRIES: "1",
      IMAGE_GEN_RETRY_DELAY_MS: "0",
      IMAGE_GEN_ALLOW_INSECURE_HTTP: "true",
      IMAGE_GEN_ASYNC_POLL_BASE: `http://127.0.0.1:${address.port}`,
      IMAGE_GEN_ASYNC_POLL_INTERVAL_MS: "10",
      IMAGE_GEN_ASYNC_TIMEOUT_MS: "2000",
      IMAGE_GEN_DISABLE_ENV_FILE: "true",
      IMAGE_GEN_DISABLE_CATSCO_GATEWAY: "true",
    };
    delete successEnv.OPENAI_API_KEY;
    for (const name of [
      "CATSCO_IMAGE_API_BASE",
      "CATSCO_HTTP_BASE_URL",
      "CATSCOMPANY_HTTP_BASE_URL",
      "CATSCO_API_KEY",
      "CATSCOMPANY_API_KEY",
      "CATSCO_USER_TOKEN",
      "CATSCOMPANY_USER_TOKEN",
    ]) delete successEnv[name];

    const catsCoGatewayEnv = {
      ...successEnv,
      CATSCO_HTTP_BASE_URL: `http://127.0.0.1:${address.port}`,
      CATSCO_USER_TOKEN: "catsco-user-login",
      IMAGE_GEN_ASYNC_SUBMIT: "true",
      IMAGE_GEN_ASYNC_POLL_BASE: "http://127.0.0.1:1",
    };
    delete catsCoGatewayEnv.IMAGE_GEN_DISABLE_CATSCO_GATEWAY;
    delete catsCoGatewayEnv.IMAGE_GEN_API_BASE;
    delete catsCoGatewayEnv.IMAGE_GEN_API_KEY;
    delete catsCoGatewayEnv.OPENAI_API_KEY;
    const catsCoGatewayRun = await runNode([
      generatorPath,
      "--request",
      requestPath,
      "--out-dir",
      catsCoGatewayOutputDir,
    ], catsCoGatewayEnv);
    assert.equal(catsCoGatewayRun.code, 0, catsCoGatewayRun.stderr);
    assert.equal(catsCoGatewayAttempts, 1);
    const catsCoGatewayResult = JSON.parse(await readFile(path.join(catsCoGatewayOutputDir, "result.json"), "utf8"));
    assert.equal(catsCoGatewayResult.provider.auth_mode, "catsco-user");
    assert.equal(catsCoGatewayResult.provider.endpoint_origin, `http://127.0.0.1:${address.port}`);
    assert.equal(catsCoGatewayResult.provider.async_poll_origin, `http://127.0.0.1:${address.port}`);
    assert.equal(catsCoGatewayResult.provider.gateway_race, true);
    assert.equal(catsCoGatewayResult.provider.async_submit, false);
    assert.equal(receivedPayload.async, undefined);
    assert.equal(JSON.stringify(catsCoGatewayResult).includes("catsco-user-login"), false);

    const catsCoDefaultGatewayEnv = {
      ...successEnv,
      CATSCO_USER_TOKEN: "catsco-user-login",
    };
    delete catsCoDefaultGatewayEnv.IMAGE_GEN_DISABLE_CATSCO_GATEWAY;
    delete catsCoDefaultGatewayEnv.CATSCO_HTTP_BASE_URL;
    delete catsCoDefaultGatewayEnv.CATSCOMPANY_HTTP_BASE_URL;
    delete catsCoDefaultGatewayEnv.IMAGE_GEN_API_BASE;
    delete catsCoDefaultGatewayEnv.IMAGE_GEN_API_KEY;
    delete catsCoDefaultGatewayEnv.IMAGE_GEN_TIMEOUT_MS;
    const catsCoDefaultGatewayRun = await runNode([
      generatorPath,
      "--request",
      requestPath,
      "--dry-run",
    ], catsCoDefaultGatewayEnv);
    assert.equal(catsCoDefaultGatewayRun.code, 0, catsCoDefaultGatewayRun.stderr);
    const catsCoDefaultGatewayResult = JSON.parse(catsCoDefaultGatewayRun.stdout);
    assert.equal(catsCoDefaultGatewayResult.config.auth_mode, "catsco-user");
    assert.equal(catsCoDefaultGatewayResult.config.endpoint_origin, "https://app.catsco.cc");
    assert.equal(catsCoDefaultGatewayResult.config.timeout_ms, 600_000);
    assert.equal(catsCoDefaultGatewayResult.config.gateway_race, true);
    assert.equal(catsCoDefaultGatewayResult.config.async_submit, false);

    const catsCoBotGatewayEnv = {
      ...catsCoGatewayEnv,
      CATSCO_API_KEY: "catsco-bot-key",
    };
    delete catsCoBotGatewayEnv.CATSCO_USER_TOKEN;
    const catsCoBotGatewayRun = await runNode([
      generatorPath,
      "--request",
      requestPath,
      "--out-dir",
      catsCoBotGatewayOutputDir,
    ], catsCoBotGatewayEnv);
    assert.equal(catsCoBotGatewayRun.code, 0, catsCoBotGatewayRun.stderr);
    assert.equal(catsCoBotGatewayAttempts, 1);
    const catsCoBotGatewayResult = JSON.parse(await readFile(path.join(catsCoBotGatewayOutputDir, "result.json"), "utf8"));
    assert.equal(catsCoBotGatewayResult.provider.auth_mode, "catsco-bot");
    assert.equal(JSON.stringify(catsCoBotGatewayResult).includes("catsco-bot-key"), false);

    const catsCoIdentityFallbackEnv = {
      ...catsCoGatewayEnv,
      CATSCO_API_KEY: "catsco-stale-bot-key",
      CATSCO_USER_TOKEN: "catsco-fallback-user",
    };
    const catsCoIdentityFallbackRun = await runNode([
      generatorPath,
      "--request",
      requestPath,
      "--out-dir",
      catsCoIdentityFallbackOutputDir,
    ], catsCoIdentityFallbackEnv);
    assert.equal(catsCoIdentityFallbackRun.code, 0, catsCoIdentityFallbackRun.stderr);
    assert.equal(catsCoRejectedBotAttempts, 1);
    assert.equal(catsCoFallbackUserAttempts, 1);
    const catsCoIdentityFallbackResult = JSON.parse(await readFile(path.join(catsCoIdentityFallbackOutputDir, "result.json"), "utf8"));
    assert.equal(catsCoIdentityFallbackResult.provider.auth_mode, "catsco-user");
    assert.equal(catsCoIdentityFallbackResult.provider.identity_fallback_used, true);
    assert.equal(catsCoIdentityFallbackResult.provider.attempts, 2);
    assert.equal(JSON.stringify(catsCoIdentityFallbackResult).includes("catsco-stale-bot-key"), false);
    assert.equal(JSON.stringify(catsCoIdentityFallbackResult).includes("catsco-fallback-user"), false);

    const prepared = await runNode([
      preparerPath,
      "--prompt",
      authoredPromptPath,
      "--raw-request",
      rawRequestPath,
      "--request",
      preparedRequestPath,
      "--aspect-ratio",
      "16:9",
      "--filename",
      "remote-collaboration-cover",
    ], successEnv);
    assert.equal(prepared.code, 0, prepared.stderr);
    const preparedRequest = JSON.parse(await readFile(preparedRequestPath, "utf8"));
    assert.equal(Object.hasOwn(preparedRequest, "prompt"), false);
    assert.equal(preparedRequest.source_prompt.path, "prompt.txt");
    assert.equal(preparedRequest.source_request.path, "raw-request.txt");
    assert.match(preparedRequest.source_prompt.sha256, /^[a-f0-9]{64}$/);
    assert.match(preparedRequest.source_request.sha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(preparedRequest, "creative_freedom"), false);
    assert.equal(preparedRequest.aspect_ratio, "16:9");
    assert.equal(Object.hasOwn(preparedRequest, "size"), false);
    for (const field of ["purpose", "subject", "scene", "style", "composition", "lighting", "palette", "must_include", "must_avoid"]) {
      assert.equal(Object.hasOwn(preparedRequest, field), false, `Preparer added semantic field: ${field}`);
    }

    const preparedDryRun = await runNode([
      generatorPath,
      "--request",
      preparedRequestPath,
      "--dry-run",
    ], successEnv);
    assert.equal(preparedDryRun.code, 0, preparedDryRun.stderr);
    const preparedDry = JSON.parse(preparedDryRun.stdout);
    assert.equal(preparedDry.request.prompt, authoredPromptText);
    assert.equal(preparedDry.request.raw_request, rawRequestText);
    assert.equal(preparedDry.request.source_prompt.sha256, preparedRequest.source_prompt.sha256);
    assert.equal(preparedDry.request.source_request.sha256, preparedRequest.source_request.sha256);
    assert.match(preparedDry.payload.prompt, new RegExp(authoredPromptText));
    assert.doesNotMatch(preparedDry.payload.prompt, new RegExp(rawRequestText));
    assert.doesNotMatch(preparedDry.payload.prompt, /Authoritative user brief|semantic source of truth/i);
    assert.match(preparedDry.payload.prompt, /Output requirements: create one finished raster image/);
    assert.doesNotMatch(preparedDry.payload.prompt, /corporate|vector illustration|teal|office scene/i);

    const autoLayout = await runNode([
      preparerPath,
      "--prompt",
      authoredPromptPath,
      "--raw-request",
      rawRequestPath,
      "--request",
      autoLayoutRequestPath,
    ], successEnv);
    assert.equal(autoLayout.code, 0, autoLayout.stderr);
    const autoLayoutDryRun = await runNode([
      generatorPath,
      "--request",
      autoLayoutRequestPath,
      "--dry-run",
    ], successEnv);
    assert.equal(autoLayoutDryRun.code, 0, autoLayoutDryRun.stderr);
    const autoLayoutResult = JSON.parse(autoLayoutDryRun.stdout);
    assert.equal(autoLayoutResult.request.size, "auto");
    assert.equal(Object.hasOwn(autoLayoutResult.request, "aspect_ratio"), false);
    assert.equal(autoLayoutResult.payload.size, "auto");
    assert.match(autoLayoutResult.payload.prompt, /automatically selected canvas size/);

    const preparedAgain = await runNode([
      preparerPath,
      "--prompt",
      authoredPromptPath,
      "--raw-request",
      rawRequestPath,
      "--request",
      preparedRequestPath,
      "--aspect-ratio",
      "16:9",
    ], successEnv);
    assert.equal(preparedAgain.code, 1);
    assert.match(preparedAgain.stderr, /REQUEST_EXISTS/);

    await writeFile(authoredPromptPath, `${authoredPromptText} changed`, "utf8");
    const changedPromptDryRun = await runNode([
      generatorPath,
      "--request",
      preparedRequestPath,
      "--dry-run",
    ], successEnv);
    assert.equal(changedPromptDryRun.code, 1);
    assert.match(changedPromptDryRun.stderr, /SOURCE_PROMPT_MISMATCH/);
    await writeFile(authoredPromptPath, authoredPromptText, "utf8");

    await writeFile(rawRequestPath, `${rawRequestText} 已更改`, "utf8");
    const changedRawRequestDryRun = await runNode([
      generatorPath,
      "--request",
      preparedRequestPath,
      "--dry-run",
    ], successEnv);
    assert.equal(changedRawRequestDryRun.code, 1);
    assert.match(changedRawRequestDryRun.stderr, /SOURCE_REQUEST_MISMATCH/);
    await writeFile(rawRequestPath, rawRequestText, "utf8");

    const legacyPrepared = await runNode([
      preparerPath,
      "--brief",
      legacyBriefPath,
      "--request",
      legacyPreparedRequestPath,
    ], successEnv);
    assert.equal(legacyPrepared.code, 0, legacyPrepared.stderr);
    const legacyDryRun = await runNode([
      generatorPath,
      "--request",
      legacyPreparedRequestPath,
      "--dry-run",
    ], successEnv);
    assert.equal(legacyDryRun.code, 0, legacyDryRun.stderr);
    assert.equal(JSON.parse(legacyDryRun.stdout).request.prompt, rawRequestText);

    const minimalBriefDryRun = await runNode([
      generatorPath,
      "--request",
      minimalBriefRequestPath,
      "--dry-run",
    ], successEnv);
    assert.equal(minimalBriefDryRun.code, 0, minimalBriefDryRun.stderr);
    const minimalBrief = JSON.parse(minimalBriefDryRun.stdout);
    assert.equal(Object.hasOwn(minimalBrief.request, "creative_freedom"), false);
    assert.equal(Object.hasOwn(minimalBrief.request, "style"), false);
    assert.equal(Object.hasOwn(minimalBrief.request, "palette"), true);
    assert.deepEqual(minimalBrief.request.palette, []);
    assert.match(minimalBrief.payload.prompt, /请生成一张放在读书笔记页面顶部的雨夜窗边插图，不要文字。/);
    assert.doesNotMatch(minimalBrief.payload.prompt, /corporate|vector illustration|teal|office scene/i);

    const sizeOnlyDryRun = await runNode([
      generatorPath,
      "--request",
      sizeOnlyRequestPath,
      "--dry-run",
    ], successEnv);
    assert.equal(sizeOnlyDryRun.code, 0, sizeOnlyDryRun.stderr);
    const sizeOnly = JSON.parse(sizeOnlyDryRun.stdout);
    assert.equal(sizeOnly.request.aspect_ratio, "16:9");
    assert.equal(sizeOnly.request.size, "1920x1080");
    assert.equal(sizeOnly.payload.size, "1920x1080");
    assert.match(sizeOnly.payload.prompt, /at 16:9 \(1920x1080\)/);

    const mismatchedRatioDryRun = await runNode([
      generatorPath,
      "--request",
      mismatchedRatioRequestPath,
      "--dry-run",
    ], successEnv);
    assert.equal(mismatchedRatioDryRun.code, 1);
    assert.match(mismatchedRatioDryRun.stderr, /aspect_ratio and size describe different proportions/);

    const success = await runNode([
      generatorPath,
      "--request",
      requestPath,
      "--out-dir",
      outputDir,
    ], successEnv);
    assert.equal(success.code, 0, success.stderr);
    assert.equal(receivedPayload.model, "mock-image-model");
    assert.equal(receivedPayload.n, 1);
    assert.equal(receivedPayload.size, "auto");
    assert.match(receivedPayload.prompt, /cloud agent maintaining a team dashboard/);
    assert.match(receivedPayload.prompt, /digital assistant/);
    assert.doesNotMatch(receivedPayload.prompt, /Authoritative user brief|semantic source of truth/);
    assert.match(receivedPayload.prompt, /Creative freedom: strict/);
    assert.match(receivedPayload.prompt, /Follow the supplied prompt closely/);
    assert.match(receivedPayload.prompt, /Output requirements: create one finished raster image/);

    const result = JSON.parse(await readFile(path.join(outputDir, "result.json"), "utf8"));
    assert.equal(result.ok, true);
    assert.equal(result.output.media_type, "image/png");
    assert.equal(result.output.dimensions.width, 1);
    assert.equal(result.output.dimensions.height, 1);
    assert.equal(result.output.dimensions.aspect_ratio_match, null);
    assert.equal(result.output.dimensions.exact_size_match, null);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.review.status, "not_run");
    assert.equal(result.request.creative_freedom, "strict");
    const image = await readFile(result.output.image_path);
    assert.equal(image.toString("base64"), tinyPngBase64);
    assert.equal(JSON.stringify(result).includes("smoke-secret"), false);

    const reviewRun = await runNode([
      reviewerPath,
      "--result",
      path.join(outputDir, "result.json"),
      "--review",
      reviewPath,
    ], process.env);
    assert.equal(reviewRun.code, 0, reviewRun.stderr);
    const reviewedResult = JSON.parse(await readFile(path.join(outputDir, "result.json"), "utf8"));
    assert.equal(reviewedResult.review.status, "passed_with_notes");
    assert.equal(reviewedResult.review.method, "multimodal_visual_inspection");
    assert.equal(reviewedResult.review.image_sha256, reviewedResult.output.sha256);
    assert.equal(reviewedResult.review.checks.length, 2);
    assert.equal(JSON.stringify(reviewedResult).includes("smoke-secret"), false);

    const invalidReviewRun = await runNode([
      reviewerPath,
      "--result",
      path.join(outputDir, "result.json"),
      "--review",
      invalidReviewPath,
    ], process.env);
    assert.equal(invalidReviewRun.code, 1);
    assert.match(invalidReviewRun.stderr, /INVALID_REVIEW/);

    const deliveryDir = path.join(tempRoot, "project assets");
    const deliveredImagePath = path.join(deliveryDir, "cloud-agent-dashboard.png");
    const deliveryRun = await runNode([
      delivererPath,
      "--result",
      path.join(outputDir, "result.json"),
      "--destination-dir",
      deliveryDir,
    ], process.env);
    assert.equal(deliveryRun.code, 0, deliveryRun.stderr);
    const deliveryOutput = JSON.parse(deliveryRun.stdout);
    assert.equal(deliveryOutput.status, "copied");
    assert.equal(deliveryOutput.destination_path, deliveredImagePath);
    assert.equal((await readFile(deliveredImagePath)).toString("base64"), tinyPngBase64);
    const deliveredResult = JSON.parse(await readFile(path.join(outputDir, "result.json"), "utf8"));
    assert.equal(deliveredResult.deliveries.length, 1);
    assert.equal(deliveredResult.deliveries[0].kind, "project_asset");
    assert.equal(deliveredResult.deliveries[0].path, deliveredImagePath);
    assert.equal(deliveredResult.deliveries[0].sha256, deliveredResult.output.sha256);

    const idempotentDeliveryRun = await runNode([
      delivererPath,
      "--result",
      path.join(outputDir, "result.json"),
      "--destination-dir",
      deliveryDir,
    ], process.env);
    assert.equal(idempotentDeliveryRun.code, 0, idempotentDeliveryRun.stderr);
    assert.equal(JSON.parse(idempotentDeliveryRun.stdout).status, "already_present");
    const idempotentResult = JSON.parse(await readFile(path.join(outputDir, "result.json"), "utf8"));
    assert.equal(idempotentResult.deliveries.length, 1);

    const conflictingDestination = path.join(tempRoot, "existing-different.png");
    await writeFile(conflictingDestination, "different image bytes");
    const conflictingDeliveryRun = await runNode([
      delivererPath,
      "--result",
      path.join(outputDir, "result.json"),
      "--destination-file",
      conflictingDestination,
    ], process.env);
    assert.equal(conflictingDeliveryRun.code, 1);
    assert.match(conflictingDeliveryRun.stderr, /DESTINATION_EXISTS/);
    assert.equal(await readFile(conflictingDestination, "utf8"), "different image bytes");

    const approvedOverwriteRun = await runNode([
      delivererPath,
      "--result",
      path.join(outputDir, "result.json"),
      "--destination-file",
      conflictingDestination,
      "--overwrite",
    ], process.env);
    assert.equal(approvedOverwriteRun.code, 0, approvedOverwriteRun.stderr);
    assert.equal(JSON.parse(approvedOverwriteRun.stdout).status, "overwritten");
    assert.equal((await readFile(conflictingDestination)).toString("base64"), tinyPngBase64);
    const overwrittenResult = JSON.parse(await readFile(path.join(outputDir, "result.json"), "utf8"));
    assert.equal(overwrittenResult.deliveries.length, 2);
    assert.equal(overwrittenResult.deliveries[1].status, "overwritten");

    const mismatchedExtensionRun = await runNode([
      delivererPath,
      "--result",
      path.join(outputDir, "result.json"),
      "--destination-file",
      path.join(tempRoot, "wrong-extension.jpg"),
    ], process.env);
    assert.equal(mismatchedExtensionRun.code, 1);
    assert.match(mismatchedExtensionRun.stderr, /DESTINATION_EXTENSION_MISMATCH/);

    const postCountAfterFirstRun = postCount;
    const duplicate = await runNode([
      generatorPath,
      "--request",
      requestPath,
      "--out-dir",
      outputDir,
    ], successEnv);
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.stderr, /OUTPUT_EXISTS/);
    assert.equal(postCount, postCountAfterFirstRun);

    const forbiddenGeneratorOverwrite = await runNode([
      generatorPath,
      "--request",
      requestPath,
      "--out-dir",
      outputDir,
      "--overwrite",
    ], successEnv);
    assert.equal(forbiddenGeneratorOverwrite.code, 1);
    assert.match(forbiddenGeneratorOverwrite.stderr, /INVALID_ARGUMENT/);
    assert.equal(postCount, postCountAfterFirstRun);

    const urlSuccess = await runNode([
      generatorPath,
      "--request",
      urlRequestPath,
      "--out-dir",
      urlOutputDir,
    ], successEnv);
    assert.equal(urlSuccess.code, 0, urlSuccess.stderr);
    assert.equal(urlAttempts, 2);
    assert.equal(urlDownloadAttempts, 2);
    const urlResult = JSON.parse(await readFile(path.join(urlOutputDir, "result.json"), "utf8"));
    assert.equal(urlResult.provider.attempts, 2);
    assert.equal(urlResult.output.media_type, "image/png");
    const urlImage = await readFile(urlResult.output.image_path);
    assert.equal(urlImage.toString("base64"), tinyPngBase64);

    const oversizedResult = await runNode([
      generatorPath,
      "--request",
      oversizedRequestPath,
      "--out-dir",
      oversizedOutputDir,
    ], {
      ...successEnv,
      IMAGE_GEN_MAX_IMAGE_BYTES: "1024",
    });
    assert.equal(oversizedResult.code, 1);
    assert.match(oversizedResult.stderr, /IMAGE_TOO_LARGE/);
    assert.equal(oversizedAttempts, 1);

    const timeoutEnv = {
      ...successEnv,
      IMAGE_GEN_TIMEOUT_MS: "1000",
      IMAGE_GEN_MAX_RETRIES: "1",
    };
    const timeoutResult = await runNode([
      generatorPath,
      "--request",
      timeoutRequestPath,
      "--out-dir",
      path.join(tempRoot, "timeout-output"),
    ], timeoutEnv);
    assert.equal(timeoutResult.code, 1);
    assert.match(timeoutResult.stderr, /API_TIMEOUT/);
    assert.equal(timeoutAttempts, 1);
    const timeoutFailure = JSON.parse(timeoutResult.stderr);
    assert.equal(timeoutFailure.failure.submission_state, "unknown");
    assert.equal(timeoutFailure.recovery.next_action, "confirm_new_dreamina_run");

    const gatewayTimeoutResult = await runNode([
      generatorPath,
      "--request",
      gatewayTimeoutRequestPath,
      "--out-dir",
      path.join(tempRoot, "gateway-timeout-output"),
    ], successEnv);
    assert.equal(gatewayTimeoutResult.code, 1);
    assert.match(gatewayTimeoutResult.stderr, /UPSTREAM_TIMEOUT/);
    assert.equal(gatewayTimeoutAttempts, 1);
    const gatewayTimeoutFailure = JSON.parse(gatewayTimeoutResult.stderr);
    assert.equal(gatewayTimeoutFailure.failure.submission_state, "unknown");
    assert.equal(gatewayTimeoutFailure.recovery.duplicate_generation_risk, true);

    const malformedResult = await runNode([
      generatorPath,
      "--request",
      malformedRequestPath,
      "--out-dir",
      path.join(tempRoot, "malformed-output"),
    ], successEnv);
    assert.equal(malformedResult.code, 1);
    assert.match(malformedResult.stderr, /INVALID_API_RESPONSE/);
    assert.match(malformedResult.stderr, /mock provider failure/);
    assert.match(malformedResult.stderr, /data_length/);
    assert.equal(malformedAttempts, 1);

    const asyncResultRun = await runNode([
      generatorPath,
      "--request",
      asyncRequestPath,
      "--out-dir",
      asyncOutputDir,
    ], successEnv);
    assert.equal(asyncResultRun.code, 0, asyncResultRun.stderr);
    assert.equal(asyncPolls, 2);
    const asyncResult = JSON.parse(await readFile(path.join(asyncOutputDir, "result.json"), "utf8"));
    assert.equal(asyncResult.provider.async_task.task_id, "task-smoke");
    assert.equal(asyncResult.provider.async_task.poll_count, 2);
    assert.equal(asyncResult.provider.async_task.resumed, false);
    await assert.rejects(access(path.join(asyncOutputDir, "pending.json")));

    const asyncResumeTimeoutEnv = {
      ...successEnv,
      IMAGE_GEN_ASYNC_TIMEOUT_MS: "1000",
    };
    const postCountBeforeResume = postCount;
    const asyncTimedOutRun = await runNode([
      generatorPath,
      "--request",
      asyncResumeRequestPath,
      "--out-dir",
      asyncResumeOutputDir,
    ], asyncResumeTimeoutEnv);
    assert.equal(asyncTimedOutRun.code, 1);
    assert.match(asyncTimedOutRun.stderr, /ASYNC_TASK_TIMEOUT/);
    const asyncTimeoutFailure = JSON.parse(asyncTimedOutRun.stderr);
    assert.equal(asyncTimeoutFailure.failure.submission_state, "submitted");
    assert.equal(asyncTimeoutFailure.recovery.can_resume_same_task, true);
    assert.equal(postCount, postCountBeforeResume + 1);
    assert.ok(asyncResumePolls > 0);

    const pendingPath = path.join(asyncResumeOutputDir, "pending.json");
    const pending = JSON.parse(await readFile(pendingPath, "utf8"));
    assert.equal(pending.task_id, "task-resume-smoke");
    assert.equal(pending.resume_args.script_path, generatorPath);
    assert.equal(pending.resume_args.request_path, asyncResumeRequestPath);
    assert.equal(pending.resume_args.output_dir, asyncResumeOutputDir);
    assert.equal(pending.resume_args.task_id, "task-resume-smoke");
    assert.match(pending.request_sha256, /^[a-f0-9]{64}$/);
    assert.equal(pending.model, "mock-image-model");

    const accidentalResubmit = await runNode([
      generatorPath,
      "--request",
      asyncResumeRequestPath,
      "--out-dir",
      asyncResumeOutputDir,
    ], successEnv);
    assert.equal(accidentalResubmit.code, 1);
    assert.match(accidentalResubmit.stderr, /PENDING_TASK_EXISTS/);
    assert.equal(postCount, postCountBeforeResume + 1);

    const forbiddenPendingOverwrite = await runNode([
      generatorPath,
      "--request",
      asyncResumeRequestPath,
      "--out-dir",
      asyncResumeOutputDir,
      "--overwrite",
    ], successEnv);
    assert.equal(forbiddenPendingOverwrite.code, 1);
    assert.match(forbiddenPendingOverwrite.stderr, /INVALID_ARGUMENT/);
    assert.equal(postCount, postCountBeforeResume + 1);

    const mismatchedTaskResume = await runNode([
      generatorPath,
      "--request",
      asyncResumeRequestPath,
      "--out-dir",
      asyncResumeOutputDir,
      "--task-id",
      "task-does-not-match",
    ], successEnv);
    assert.equal(mismatchedTaskResume.code, 1);
    assert.match(mismatchedTaskResume.stderr, /ASYNC_TASK_ID_MISMATCH/);
    assert.equal(postCount, postCountBeforeResume + 1);

    const mismatchedContextResume = await runNode([
      generatorPath,
      "--request",
      alternateAsyncResumeRequestPath,
      "--out-dir",
      asyncResumeOutputDir,
      "--task-id",
      "task-resume-smoke",
    ], successEnv);
    assert.equal(mismatchedContextResume.code, 1);
    assert.match(mismatchedContextResume.stderr, /PENDING_TASK_CONTEXT_MISMATCH/);
    assert.equal(postCount, postCountBeforeResume + 1);

    await writeFile(asyncResumeRequestPath, asyncResumeRequestText.replace("Async resume test", "Changed async resume test"));
    const changedRequestResume = await runNode([
      generatorPath,
      "--request",
      asyncResumeRequestPath,
      "--out-dir",
      asyncResumeOutputDir,
      "--task-id",
      "task-resume-smoke",
    ], successEnv);
    assert.equal(changedRequestResume.code, 1);
    assert.match(changedRequestResume.stderr, /PENDING_TASK_REQUEST_MISMATCH/);
    assert.equal(postCount, postCountBeforeResume + 1);
    await writeFile(asyncResumeRequestPath, asyncResumeRequestText);

    const changedProviderResume = await runNode([
      generatorPath,
      "--request",
      asyncResumeRequestPath,
      "--out-dir",
      asyncResumeOutputDir,
      "--task-id",
      "task-resume-smoke",
    ], {
      ...successEnv,
      IMAGE_GEN_MODEL: "different-image-model",
    });
    assert.equal(changedProviderResume.code, 1);
    assert.match(changedProviderResume.stderr, /PENDING_TASK_PROVIDER_MISMATCH/);
    assert.equal(postCount, postCountBeforeResume + 1);

    const missingPendingResume = await runNode([
      generatorPath,
      "--request",
      asyncResumeRequestPath,
      "--out-dir",
      path.join(tempRoot, "missing-pending-output"),
      "--task-id",
      "task-resume-smoke",
    ], successEnv);
    assert.equal(missingPendingResume.code, 1);
    assert.match(missingPendingResume.stderr, /PENDING_TASK_NOT_FOUND/);
    assert.equal(postCount, postCountBeforeResume + 1);

    asyncResumeReady = true;
    const resumedRun = await runNode([
      generatorPath,
      "--request",
      asyncResumeRequestPath,
      "--out-dir",
      asyncResumeOutputDir,
      "--task-id",
      "task-resume-smoke",
    ], successEnv);
    assert.equal(resumedRun.code, 0, resumedRun.stderr);
    assert.equal(postCount, postCountBeforeResume + 1);
    const resumedResult = JSON.parse(await readFile(path.join(asyncResumeOutputDir, "result.json"), "utf8"));
    assert.equal(resumedResult.provider.async_task.task_id, "task-resume-smoke");
    assert.equal(resumedResult.provider.async_task.resumed, true);
    await assert.rejects(access(pendingPath));

    const missingKeyEnv = {
      ...process.env,
      IMAGE_GEN_API_BASE: apiBase,
      IMAGE_GEN_MAX_RETRIES: "0",
      IMAGE_GEN_ALLOW_INSECURE_HTTP: "true",
      IMAGE_GEN_DISABLE_ENV_FILE: "true",
      IMAGE_GEN_DISABLE_CATSCO_GATEWAY: "true",
    };
    delete missingKeyEnv.IMAGE_GEN_API_KEY;
    delete missingKeyEnv.OPENAI_API_KEY;
    delete missingKeyEnv.CATSCO_IMAGE_API_BASE;
    const missingKey = await runNode([
      generatorPath,
      "--request",
      requestPath,
      "--out-dir",
      path.join(tempRoot, "missing-key-output"),
    ], missingKeyEnv);
    assert.equal(missingKey.code, 1);
    assert.match(missingKey.stderr, /MISSING_API_KEY/);

    const missingCatsCoLoginEnv = {
      ...missingKeyEnv,
      CATSCO_IMAGE_API_BASE: apiBase,
    };
    delete missingCatsCoLoginEnv.CATSCO_USER_TOKEN;
    delete missingCatsCoLoginEnv.CATSCOMPANY_USER_TOKEN;
    delete missingCatsCoLoginEnv.CATSCO_API_KEY;
    delete missingCatsCoLoginEnv.CATSCOMPANY_API_KEY;
    const missingCatsCoLogin = await runNode([
      generatorPath,
      "--request",
      requestPath,
      "--out-dir",
      path.join(tempRoot, "missing-catsco-login-output"),
    ], missingCatsCoLoginEnv);
    assert.equal(missingCatsCoLogin.code, 1);
    assert.match(missingCatsCoLogin.stderr, /MISSING_CATSCO_IDENTITY/);

    for (const runDir of [outputDir, urlOutputDir, asyncOutputDir, asyncResumeOutputDir, envFileOutputDir, catsCoGatewayOutputDir, catsCoBotGatewayOutputDir, catsCoIdentityFallbackOutputDir]) {
      const entries = await readdir(runDir);
      assert.equal(entries.some((name) => name.includes(".tmp-")), false, `Temporary file leaked in ${runDir}`);
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      checks: [
        "OpenAI-compatible request",
        "optional creative-freedom prompt control",
        "hash-bound authored prompt and raw user request",
        "source prompt and source request mutation rejection",
        "legacy source brief compatibility",
        "natural request overwrite disabled",
        "provider-auto layout for unspecified natural requests",
        "minimal direct prompt without style-template injection",
        "UTF-8 BOM request compatibility",
        "size-only aspect ratio derivation",
        "aspect ratio and size contradiction rejection",
        "per-run XiaoBa .env discovery without host restart",
        "automatic CatsCo login-authenticated gateway mode",
        "automatic CatsCo default service URL",
        "600-second default client timeout budget",
        "CatsCo bot API-key gateway mode",
        "stale CatsCo bot key falls back once to the existing user login",
        "base64 PNG output",
        "URL image output",
        "transient image URL download retry",
        "streaming image size limit",
        "HTTP 429 retry",
        "timeout does not retry",
        "HTTP 524 does not retry",
        "malformed response diagnostics",
        "asynchronous task polling",
        "asynchronous timeout resume without resubmission",
        "pending task ID, request, and provider binding",
        "generation overwrite disabled",
        "review writeback with image hash binding",
        "contradictory review rejection",
        "non-destructive project asset delivery",
        "idempotent project asset delivery",
        "explicitly approved project asset overwrite",
        "result manifest",
        "secret redaction",
        "preflight overwrite protection",
        "atomic run artifact writes",
        "missing-key failure",
      ],
    }, null, 2)}\n`);
  } finally {
    server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
