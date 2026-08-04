#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const referencePreparerPath = path.join(scriptsDir, "prepare-reference.mjs");
const requestPreparerPath = path.join(scriptsDir, "prepare-request.mjs");
const generatorPath = path.join(scriptsDir, "generate-image.mjs");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function solidPng(width, height, [red, green, blue]) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let offset = 1; offset < row.length; offset += 3) {
    row[offset] = red;
    row[offset + 1] = green;
    row[offset + 2] = blue;
  }
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function noisyPng(width, height) {
  const rowBytes = 1 + width * 3;
  const pixels = randomBytes(rowBytes * height);
  for (let row = 0; row < height; row += 1) pixels[row * rowBytes] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function runNode(args, env = process.env) {
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
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "image-reference-smoke-"));
  const localSource = path.join(tempRoot, "named-character.png");
  const oversizedSource = path.join(tempRoot, "oversized-reference.png");
  const heavySource = path.join(tempRoot, "heavy-reference.png");
  const runDir = path.join(tempRoot, "run");
  const oversizedRunDir = path.join(tempRoot, "oversized-run");
  const heavyRunDir = path.join(tempRoot, "heavy-run");
  const promptPath = path.join(runDir, "prompt.txt");
  const rawRequestPath = path.join(runDir, "raw-request.txt");
  const requestPath = path.join(runDir, "request.json");
  const explicitSizeRequestPath = path.join(runDir, "explicit-size-request.json");
  const outputDir = path.join(runDir, "output");
  const referencePng = solidPng(64, 64, [40, 100, 220]);
  const oversizedPng = solidPng(2304, 1536, [80, 160, 220]);
  const outputPng = solidPng(128, 128, [220, 100, 40]);
  let receivedEditPayload;

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/reference.png") {
      response.writeHead(200, { "content-type": "image/png", "content-length": String(referencePng.length) });
      response.end(referencePng);
      return;
    }
    if (request.method === "GET" && request.url === "/not-an-image") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>not image pixels</html>");
      return;
    }
    if (request.method === "POST" && request.url === "/v1/images/edits") {
      assert.equal(request.headers.authorization, "Bearer reference-smoke-secret");
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      await once(request, "end");
      receivedEditPayload = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "reference-edit-smoke", data: [{ b64_json: outputPng.toString("base64") }] }));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    const apiBase = `http://127.0.0.1:${port}/v1`;
    const isolatedEnv = {
      ...process.env,
      IMAGE_GEN_DISABLE_ENV_FILE: "true",
      IMAGE_GEN_DISABLE_CATSCO_GATEWAY: "true",
      IMAGE_GEN_ALLOW_INSECURE_HTTP: "true",
      IMAGE_GEN_API_BASE: apiBase,
      IMAGE_GEN_API_KEY: "reference-smoke-secret",
      IMAGE_GEN_MODEL: "reference-smoke-model",
      IMAGE_GEN_ASYNC_SUBMIT: "true",
    };
    delete isolatedEnv.CATSCO_IMAGE_API_BASE;
    delete isolatedEnv.CATSCO_HTTP_BASE_URL;
    delete isolatedEnv.CATSCOMPANY_HTTP_BASE_URL;
    delete isolatedEnv.CATSCO_API_KEY;
    delete isolatedEnv.CATSCO_USER_TOKEN;

    await writeFile(localSource, referencePng);
    const preparedReference = await runNode([
      referencePreparerPath,
      "--input", localSource,
      "--out-dir", runDir,
      "--use-for", "the named character's identity and facial features only",
      "--source-url", "https://example.com/characters/named-character?temporary=secret",
    ], isolatedEnv);
    assert.equal(preparedReference.code, 0, preparedReference.stderr);
    const preparedReferenceResult = JSON.parse(preparedReference.stdout);
    assert.equal(preparedReferenceResult.descriptor.width, 64);
    assert.equal(preparedReferenceResult.descriptor.height, 64);
    assert.equal(preparedReferenceResult.descriptor.source_url, "https://example.com/characters/named-character");
    assert.equal(preparedReferenceResult.descriptor.source_name, "named-character.png");
    assert.equal(preparedReferenceResult.compression.applied, false);

    await writeFile(oversizedSource, oversizedPng);
    const preparedOversized = await runNode([
      referencePreparerPath,
      "--input", oversizedSource,
      "--out-dir", oversizedRunDir,
      "--use-for", "composition and identity reference",
    ], isolatedEnv);
    assert.equal(preparedOversized.code, 0, preparedOversized.stderr);
    const preparedOversizedResult = JSON.parse(preparedOversized.stdout);
    assert.equal(preparedOversizedResult.compression.applied, true);
    assert.deepEqual(preparedOversizedResult.compression.reasons, ["dimensions"]);
    assert.equal(preparedOversizedResult.descriptor.media_type, "image/webp");
    assert.equal(preparedOversizedResult.descriptor.width, 1536);
    assert.equal(preparedOversizedResult.descriptor.height, 1024);
    assert.equal(preparedOversizedResult.compression.max_edge, 1536);
    assert.equal(preparedOversizedResult.compression.quality, 85);
    assert.match(preparedOversizedResult.reference_path, /reference-01\.webp$/);
    assert.deepEqual(await readFile(oversizedSource), oversizedPng);

    const heavyPng = noisyPng(1400, 1024);
    assert.ok(heavyPng.length > 3 * 1024 * 1024);
    await writeFile(heavySource, heavyPng);
    const preparedHeavy = await runNode([
      referencePreparerPath,
      "--input", heavySource,
      "--out-dir", heavyRunDir,
      "--use-for", "texture reference",
    ], isolatedEnv);
    assert.equal(preparedHeavy.code, 0, preparedHeavy.stderr);
    const preparedHeavyResult = JSON.parse(preparedHeavy.stdout);
    assert.equal(preparedHeavyResult.compression.applied, true);
    assert.deepEqual(preparedHeavyResult.compression.reasons, ["bytes"]);
    assert.equal(preparedHeavyResult.descriptor.media_type, "image/webp");
    assert.ok(preparedHeavyResult.descriptor.bytes < heavyPng.length);
    assert.deepEqual(await readFile(heavySource), heavyPng);

    await writeFile(promptPath, "Create a clean character portrait in a new nighttime city scene.", "utf8");
    await writeFile(rawRequestPath, "用这张参考图保持角色身份，换成夜晚城市背景。", "utf8");
    const preparedRequest = await runNode([
      requestPreparerPath,
      "--prompt", promptPath,
      "--raw-request", rawRequestPath,
      "--references", path.join(runDir, "references.json"),
      "--request", requestPath,
      "--filename", "reference-result",
    ], isolatedEnv);
    assert.equal(preparedRequest.code, 0, preparedRequest.stderr);
    const requestJson = JSON.parse(await readFile(requestPath, "utf8"));
    assert.equal(requestJson.reference_images.length, 1);
    assert.equal(requestJson.reference_images[0].path, "references/reference-01.png");

    const dryRun = await runNode([generatorPath, "--request", requestPath, "--dry-run"], isolatedEnv);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dry = JSON.parse(dryRun.stdout);
    assert.equal(dry.config.api_operation, "edits");
    assert.equal(dry.config.endpoint_path, "/v1/images/edits");
    assert.equal(dry.config.async_submit, false);
    assert.equal(Object.hasOwn(dry.payload, "async"), false);
    assert.equal(Object.hasOwn(dry.payload, "size"), false);
    assert.match(dry.prompt ?? dry.payload.prompt, /Reference image 1: the named character's identity/);
    assert.match(dry.payload.images[0].image_url, /^data:image\/png;base64,<omitted:/);
    assert.doesNotMatch(dryRun.stdout, new RegExp(referencePng.toString("base64").slice(0, 30)));

    await writeFile(explicitSizeRequestPath, `${JSON.stringify({ ...requestJson, size: "1024x1024" }, null, 2)}\n`, "utf8");
    const explicitSizeDryRun = await runNode([generatorPath, "--request", explicitSizeRequestPath, "--dry-run"], isolatedEnv);
    assert.equal(explicitSizeDryRun.code, 0, explicitSizeDryRun.stderr);
    assert.equal(JSON.parse(explicitSizeDryRun.stdout).payload.size, "1024x1024");

    const generated = await runNode([
      generatorPath,
      "--request", requestPath,
      "--out-dir", outputDir,
    ], isolatedEnv);
    assert.equal(generated.code, 0, generated.stderr);
    assert.equal(receivedEditPayload.model, "reference-smoke-model");
    assert.equal(receivedEditPayload.images.length, 1);
    assert.equal(Object.hasOwn(receivedEditPayload, "async"), false);
    assert.equal(Object.hasOwn(receivedEditPayload, "size"), false);
    const [, encodedReference] = receivedEditPayload.images[0].image_url.split(",", 2);
    assert.deepEqual(Buffer.from(encodedReference, "base64"), referencePng);
    const result = JSON.parse(await readFile(path.join(outputDir, "result.json"), "utf8"));
    assert.equal(result.provider.api_operation, "edits");
    assert.equal(result.request.reference_images[0].sha256, requestJson.reference_images[0].sha256);
    assert.equal(JSON.stringify(result).includes("base64,"), false);

    await writeFile(path.join(runDir, requestJson.reference_images[0].path), solidPng(64, 64, [1, 2, 3]));
    const mutated = await runNode([
      generatorPath,
      "--request", requestPath,
      "--out-dir", path.join(runDir, "mutated-output"),
    ], isolatedEnv);
    assert.notEqual(mutated.code, 0);
    assert.match(mutated.stderr, /REFERENCE_IMAGE_HASH_MISMATCH/);

    const remoteRunDir = path.join(tempRoot, "remote-run");
    const remotePrepared = await runNode([
      referencePreparerPath,
      "--input", `http://127.0.0.1:${port}/reference.png`,
      "--out-dir", remoteRunDir,
      "--use-for", "color and costume reference",
    ], { ...isolatedEnv, IMAGE_GEN_ALLOW_INSECURE_REFERENCE_HTTP: "true" });
    assert.equal(remotePrepared.code, 0, remotePrepared.stderr);
    const remoteManifest = JSON.parse(await readFile(path.join(remoteRunDir, "references.json"), "utf8"));
    assert.equal(remoteManifest.reference_images[0].media_type, "image/png");

    const htmlRunDir = path.join(tempRoot, "html-run");
    const htmlRejected = await runNode([
      referencePreparerPath,
      "--input", `http://127.0.0.1:${port}/not-an-image`,
      "--out-dir", htmlRunDir,
      "--use-for", "identity",
    ], { ...isolatedEnv, IMAGE_GEN_ALLOW_INSECURE_REFERENCE_HTTP: "true" });
    assert.notEqual(htmlRejected.code, 0);
    assert.match(htmlRejected.stderr, /UNSUPPORTED_REFERENCE_IMAGE/);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      checks: [
        "local reference acquisition and immutable copy",
        "oversized reference one-time WebP transport compression",
        "byte-heavy reference transport compression",
        "oversized source preservation",
        "source provenance without URL query leakage",
        "hash-bound request preparation",
        "reference prompt order mapping",
        "dry-run base64 redaction",
        "reference auto-size omission with explicit-size preservation",
        "reference edits ignore generation-only async submission",
        "JSON images[].image_url edit request",
        "reference mutation rejection",
        "remote image-byte acquisition",
        "HTML response rejection",
      ],
    }, null, 2)}\n`);
  } finally {
    server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error?.stack || error?.message || String(error) }, null, 2)}\n`);
  process.exitCode = 1;
});
