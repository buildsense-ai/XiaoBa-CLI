"use strict";

const http = require("http");
const path = require("path");
const { URL } = require("url");

const { loadGauzMemEnv } = require("./env");
const { retrieve, recordFeedback, recordTurnMetadata } = require("./retrieve");
const { ensureStore, registerAttachment, resolveStoreRoot, withStoreWriteLock } = require("./store");

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

function readJson(req, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const maxBodyBytes = options.maxBodyBytes || 1024 * 1024;
    let totalBytes = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        rejected = true;
        reject(new Error(`request body too large: max ${maxBodyBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function statusForError(error) {
  const message = String(error?.message || "");
  if (message.includes("unauthorized")) return 401;
  if (
    message.includes("Invalid JSON")
    || message.includes("required")
    || message.includes("unknown ")
    || message.includes("not found")
    || message.includes("not allowed")
    || message.includes("too large")
    || message.includes("must be")
  ) {
    return 400;
  }
  return 500;
}

function createGauzMemZeroServer(options = {}) {
  loadGauzMemEnv();
  const storeRoot = resolveStoreRoot(options.storeRoot);
  const allowedRootPaths = resolveAllowedRootPaths(options.allowedRootPaths);
  const authToken = options.authToken ?? process.env.GAUZMEM_HTTP_TOKEN ?? process.env.GAUZMEM_AUTH_TOKEN ?? process.env.GAUZMEM_TOKEN;
  const maxBodyBytes = options.maxBodyBytes || Number(process.env.GAUZMEM_MAX_BODY_BYTES || 1024 * 1024);
  ensureStore(storeRoot);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/health") {
        sendJson(res, 200, {
          ok: true,
          version: "0.1.0",
          mode: "zero-index",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/retrieve") {
        assertAuthorized(req, authToken);
        const body = await readJson(req, { maxBodyBytes });
        const sanitized = sanitizeRetrieveBody(body, allowedRootPaths);
        sendJson(res, 200, await withStoreWriteLock(storeRoot, () => retrieve({ ...sanitized, storeRoot })));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/tool/search") {
        assertAuthorized(req, authToken);
        const body = await readJson(req, { maxBodyBytes });
        const sanitized = sanitizeRetrieveBody(body, allowedRootPaths);
        sendJson(res, 200, await withStoreWriteLock(storeRoot, () => retrieve({ ...sanitized, storeRoot, callType: "tool_search" })));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/feedback") {
        assertAuthorized(req, authToken);
        const body = await readJson(req, { maxBodyBytes });
        sendJson(res, 200, await withStoreWriteLock(storeRoot, () => recordFeedback({ ...body, storeRoot })));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/events/source") {
        assertAuthorized(req, authToken);
        const body = await readJson(req, { maxBodyBytes });
        sendJson(res, 200, await withStoreWriteLock(
          storeRoot,
          () => registerAttachment(storeRoot, sanitizeSourceBody(body, allowedRootPaths)),
        ));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/events/turn") {
        assertAuthorized(req, authToken);
        const body = await readJson(req, { maxBodyBytes });
        sendJson(res, 200, await withStoreWriteLock(storeRoot, () => recordTurnMetadata({ ...body, storeRoot })));
        return;
      }

      sendJson(res, 404, { error: `Not found: ${req.method} ${url.pathname}` });
    } catch (error) {
      const status = statusForError(error);
      sendJson(res, status, { error: status >= 500 ? "Internal error" : error.message });
    }
  });
}

function resolveAllowedRootPaths(input) {
  const raw = input || process.env.GAUZMEM_ALLOWED_ROOTS || "";
  const items = Array.isArray(raw) ? raw : String(raw).split(path.delimiter);
  return items
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => realPathIfExists(item));
}

function sanitizeRetrieveBody(body, allowedRootPaths) {
  for (const key of forbiddenHttpFields()) {
    if (Object.hasOwn(body, key)) {
      throw new Error(`${key} is not allowed in HTTP requests; configure the sidecar environment instead`);
    }
  }
  for (const key of ["rootPaths", "sourceRoots"]) {
    if (!Object.hasOwn(body, key)) continue;
    if (!Array.isArray(body[key])) throw new Error(`${key} must be an array of paths`);
    body[key] = body[key].map((item) => assertAllowedRoot(item, allowedRootPaths));
  }
  if (body.budget) body.budget = sanitizeBudget(body.budget);
  return body;
}

function sanitizeSourceBody(body, allowedRootPaths) {
  const next = { ...body };
  for (const key of ["path", "originalPath", "extractedTextPath", "textPath"]) {
    if (next[key]) next[key] = assertAllowedRoot(next[key], allowedRootPaths);
  }
  return next;
}

function forbiddenHttpFields() {
  return [
    "llmApiKey",
    "llmBaseUrl",
    "llmModel",
    "llmTimeoutMs",
    "apiKey",
    "baseUrl",
    "model",
    "timeoutMs",
    "reasoner",
    "storeRoot",
    "callType",
    "thresholds",
  ];
}

function assertAllowedRoot(rootPath, allowedRootPaths) {
  if (typeof rootPath !== "string" || !rootPath.trim()) {
    throw new Error("rootPath must be a non-empty string");
  }
  const resolved = realPathIfExists(rootPath);
  if (allowedRootPaths.length === 0) {
    throw new Error("GAUZMEM_ALLOWED_ROOTS is required for HTTP source paths");
  }
  const ok = allowedRootPaths.some((allowed) => resolved === allowed || resolved.startsWith(`${allowed}${path.sep}`));
  if (!ok) throw new Error(`rootPath is not allowed: ${resolved}`);
  return resolved;
}

function sanitizeBudget(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("budget must be an object");
  }
  if (Object.hasOwn(raw, "thresholds")) {
    throw new Error("budget.thresholds is not allowed in HTTP requests");
  }
  const out = {};
  setInteger(out, raw, "maxTerms", 1, 32);
  setInteger(out, raw, "maxEvidence", 1, 32);
  setInteger(out, raw, "maxWindows", 1, 32);
  setInteger(out, raw, "maxEvidenceChars", 80, 2000);
  setInteger(out, raw, "maxGraphHops", 0, 3);
  setInteger(out, raw, "maxGraphEdges", 1, 128);
  setInteger(out, raw, "maxGraphHitsPerTerm", 1, 200);
  setInteger(out, raw, "maxHitsPerTerm", 1, 200);
  setInteger(out, raw, "maxRunEdges", 0, 64);
  setInteger(out, raw, "maxPromptChars", 1000, 50000);
  setInteger(out, raw, "energy", 1, 200);
  setNumber(out, raw, "minGraphTermCoverage", 0, 1);
  if (raw.forceConstruct === true) out.forceConstruct = true;
  return out;
}

function setInteger(out, raw, key, min, max) {
  if (!Object.hasOwn(raw, key)) return;
  const value = Number(raw[key]);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  out[key] = Math.min(max, Math.max(min, Math.trunc(value)));
}

function setNumber(out, raw, key, min, max) {
  if (!Object.hasOwn(raw, key)) return;
  const value = Number(raw[key]);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  out[key] = Math.min(max, Math.max(min, value));
}

function realPathIfExists(rootPath) {
  const resolved = path.resolve(rootPath);
  try {
    return fsRealpath(resolved);
  } catch {
    return resolved;
  }
}

function fsRealpath(filePath) {
  const fs = require("fs");
  return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
}

function assertAuthorized(req, authToken) {
  if (!authToken) return;
  if (req.headers.authorization === `Bearer ${authToken}`) return;
  throw new Error("unauthorized GauzMem request");
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(String(host || "").toLowerCase());
}

function listen(options = {}) {
  loadGauzMemEnv();
  const authToken = options.authToken ?? process.env.GAUZMEM_HTTP_TOKEN ?? process.env.GAUZMEM_AUTH_TOKEN ?? process.env.GAUZMEM_TOKEN;
  const server = createGauzMemZeroServer(options);
  const host = options.host || "127.0.0.1";
  if (!isLoopbackHost(host) && !authToken) {
    throw new Error("GAUZMEM_HTTP_TOKEN is required when binding GauzMem outside loopback");
  }
  const port = options.port ?? 8788;
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        url: `http://${host}:${actualPort}`,
        port: actualPort,
      });
    });
  });
}

module.exports = {
  createGauzMemZeroServer,
  listen,
};
