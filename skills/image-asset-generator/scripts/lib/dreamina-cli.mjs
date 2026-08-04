import { spawn } from "node:child_process";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export class DreaminaImageError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "DreaminaImageError";
    this.code = code;
    this.details = details;
  }
}

function parsePrefixArgs() {
  const raw = process.env.DREAMINA_CLI_PREFIX_ARGS_JSON;
  if (!raw) return [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DreaminaImageError(
      "INVALID_CONFIGURATION",
      "DREAMINA_CLI_PREFIX_ARGS_JSON must be a JSON array of strings.",
    );
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DreaminaImageError(
      "INVALID_CONFIGURATION",
      "DREAMINA_CLI_PREFIX_ARGS_JSON must be a JSON array of strings.",
    );
  }
  return value;
}

function appendLimited(current, chunk) {
  if (Buffer.byteLength(current, "utf8") >= MAX_CAPTURE_BYTES) return current;
  const next = current + chunk.toString("utf8");
  return Buffer.byteLength(next, "utf8") > MAX_CAPTURE_BYTES
    ? next.slice(0, MAX_CAPTURE_BYTES)
    : next;
}

export function extractLastJson(text) {
  const clean = String(text || "").replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!clean) return null;
  try {
    return JSON.parse(clean);
  } catch {
    // Continue through mixed log and JSON output.
  }

  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Continue looking for a multiline JSON suffix.
    }
  }

  let lastParsed = null;
  let start = -1;
  let inString = false;
  let escaped = false;
  const stack = [];
  for (let index = 0; index < clean.length; index += 1) {
    const character = clean[index];
    if (start < 0) {
      if (character === "{" || character === "[") {
        start = index;
        stack.push(character);
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }
    if (character !== "}" && character !== "]") continue;
    const expected = character === "}" ? "{" : "[";
    if (stack.pop() !== expected) {
      start = -1;
      stack.length = 0;
      continue;
    }
    if (stack.length !== 0) continue;
    try {
      lastParsed = JSON.parse(clean.slice(start, index + 1));
    } catch {
      // Ignore balanced non-JSON log fragments.
    }
    start = -1;
  }
  return lastParsed;
}

export async function runDreamina(args, options = {}) {
  const executable = process.env.DREAMINA_CLI_BIN || "dreamina";
  const prefixArgs = parsePrefixArgs();
  const configuredTimeout = Number(options.timeoutMs || process.env.DREAMINA_CLI_TIMEOUT_MS || 120_000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 120_000;
  const startedAt = Date.now();

  return await new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    const child = spawn(executable, [...prefixArgs, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => { stdout = appendLimited(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk); });
    child.on("error", (error) => { spawnError = error; });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        executable,
        args: [...prefixArgs, ...args],
        exitCode: code,
        signal,
        timedOut,
        error: spawnError,
        stdout,
        stderr,
        parsed: extractLastJson(stdout) || extractLastJson(stderr),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function findField(value, keys, depth = 0) {
  if (depth > 8 || value == null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findField(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key) && value[key] != null) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findField(child, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function extractSubmitId(value) {
  const found = findField(value, ["submit_id", "submitId"]);
  return found == null ? null : String(found).trim() || null;
}

export function extractGenStatus(value) {
  const exact = findField(value, ["gen_status", "genStatus"]);
  const found = exact === undefined ? findField(value, ["status"]) : exact;
  return found == null ? null : String(found).trim().toLowerCase() || null;
}

export function extractFailureReason(value) {
  const found = findField(value, [
    "fail_reason",
    "failReason",
    "error_message",
    "errorMessage",
    "message",
    "error",
  ]);
  if (found == null) return null;
  if (typeof found === "string") return found.trim() || null;
  try {
    return JSON.stringify(found);
  } catch {
    return String(found);
  }
}

function normalizedText(...values) {
  return values
    .filter(Boolean)
    .map((value) => String(value))
    .join("\n")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim();
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

export function classifyDreaminaFailure(options) {
  const phase = options.phase || "query";
  const raw = normalizedText(options.stderr, options.stdout, options.error?.message);
  const text = raw.toLowerCase();
  const message = raw || `Dreamina CLI exited with code ${options.exitCode ?? "unknown"}.`;

  if (options.error?.code === "ENOENT") {
    return new DreaminaImageError(
      "CLI_UNAVAILABLE",
      "The official dreamina CLI is not installed or is not available on PATH.",
    );
  }
  if (includesAny(text, [
    "未检测到有效登录态",
    "请先执行 dreamina login",
    "auth_required",
    "authentication required",
    "not logged in",
    "login required",
    "token expired",
    "invalid token",
    "unauthorized",
  ])) {
    return new DreaminaImageError("AUTH_REQUIRED", message);
  }
  if (includesAny(text, [
    "aigccomplianceconfirmationrequired",
    "compliance_confirmation_required",
    "合规确认",
    "授权确认",
  ])) {
    return new DreaminaImageError("COMPLIANCE_CONFIRMATION_REQUIRED", message);
  }
  if (includesAny(text, [
    "insufficient_credit",
    "insufficient credit",
    "credit insufficient",
    "积分不足",
    "额度不足",
    "会员不可用",
    "membership required",
    "quota exhausted",
  ])) {
    return new DreaminaImageError("INSUFFICIENT_CREDIT", message);
  }

  const ambiguousTransport = options.timedOut || options.signal || includesAny(text, [
    "timed out",
    "timeout",
    "deadline exceeded",
    "connection reset",
    "connection closed",
    "unexpected eof",
    "socket hang up",
    "network error",
    "econnreset",
    "etimedout",
  ]);
  if (phase === "submit" && ambiguousTransport) {
    return new DreaminaImageError(
      "SUBMISSION_UNKNOWN",
      "Dreamina ended before returning a trustworthy submit_id. The paid task may still exist, so this run will not submit again.",
    );
  }
  if (phase === "credit" && options.exitCode !== 0 && !raw) {
    return new DreaminaImageError(
      "AUTH_REQUIRED",
      "Dreamina has no usable login state. An administrator must complete the shared account login.",
    );
  }
  if (phase === "credit") {
    return new DreaminaImageError("PROVIDER_UNAVAILABLE", message);
  }
  if (phase === "query") {
    return new DreaminaImageError("QUERY_FAILED", message);
  }
  return new DreaminaImageError("GENERATION_FAILED", message);
}

export function summarizeCliResponse(response) {
  const limit = (value) => {
    const text = String(value || "").trim();
    return text.length > 20_000 ? `${text.slice(0, 20_000)}...` : text;
  };
  return {
    executable: response.executable,
    args: response.args,
    exit_code: response.exitCode,
    signal: response.signal,
    timed_out: response.timedOut,
    duration_ms: response.durationMs,
    stdout: limit(response.stdout),
    stderr: limit(response.stderr),
    parsed: response.parsed,
  };
}

export function errorRecord(error) {
  return {
    code: error?.code || "INTERNAL_ERROR",
    message: error?.message || String(error),
    ...(error?.details ? { details: error.details } : {}),
  };
}
