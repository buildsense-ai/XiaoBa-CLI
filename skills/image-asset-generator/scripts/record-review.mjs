#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const STATUS_VALUES = new Set(["passed", "passed_with_notes", "failed", "not_run"]);
const METHOD_VALUES = new Set(["multimodal_visual_inspection", "reader_proxy", "human_review", "not_run"]);
const OUTCOME_VALUES = new Set(["pass", "fail", "uncertain", "not_applicable"]);
const SEVERITY_VALUES = new Set(["info", "warning", "error"]);

class ReviewError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
    this.details = details;
  }
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    try { await unlink(temporaryPath); } catch {}
    throw error;
  }
}

function usage() {
  return [
    "Usage:",
    "  node record-review.mjs --result <result.json> --review <review.json>",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--result") args.result = argv[++index];
    else if (token === "--review") args.review = argv[++index];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new ReviewError("INVALID_ARGUMENT", `Unknown argument: ${token}`);
  }
  if (args.help) return args;
  if (!args.result || !args.review) {
    throw new ReviewError("INVALID_ARGUMENT", "--result and --review are required.");
  }
  return args;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new ReviewError("INVALID_JSON_FILE", `Cannot read ${label}: ${error?.message || error}`, { path: filePath });
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewError("INVALID_REVIEW", `${label} must be an object.`);
  }
}

function requiredString(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ReviewError("INVALID_REVIEW", `${label} must be a non-empty string.`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new ReviewError("INVALID_REVIEW", `${label} exceeds ${maxLength} characters.`);
  }
  return text;
}

function optionalString(value, label, maxLength) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ReviewError("INVALID_REVIEW", `${label} must be a string.`);
  const text = value.trim();
  if (text.length > maxLength) throw new ReviewError("INVALID_REVIEW", `${label} exceeds ${maxLength} characters.`);
  return text || undefined;
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ReviewError("INVALID_REVIEW", `${label} contains unknown field(s): ${unknown.join(", ")}`);
}

function normalizeReview(raw) {
  requireObject(raw, "review");
  assertKnownKeys(raw, new Set(["status", "method", "summary", "reviewed_at", "checks", "issues"]), "review");
  const status = requiredString(raw.status, "status", 40);
  const method = requiredString(raw.method, "method", 80);
  if (!STATUS_VALUES.has(status)) throw new ReviewError("INVALID_REVIEW", `Unsupported status: ${status}`);
  if (!METHOD_VALUES.has(method)) throw new ReviewError("INVALID_REVIEW", `Unsupported method: ${method}`);
  const summary = requiredString(raw.summary, "summary", 2_000);
  if (!Array.isArray(raw.checks) || raw.checks.length > 30) {
    throw new ReviewError("INVALID_REVIEW", "checks must be an array with at most 30 items.");
  }
  if (!Array.isArray(raw.issues) || raw.issues.length > 30) {
    throw new ReviewError("INVALID_REVIEW", "issues must be an array with at most 30 items.");
  }

  const checks = raw.checks.map((check, index) => {
    requireObject(check, `checks[${index}]`);
    assertKnownKeys(check, new Set(["name", "outcome", "note"]), `checks[${index}]`);
    const name = requiredString(check.name, `checks[${index}].name`, 64);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
      throw new ReviewError("INVALID_REVIEW", `checks[${index}].name must be a lowercase identifier.`);
    }
    const outcome = requiredString(check.outcome, `checks[${index}].outcome`, 30);
    if (!OUTCOME_VALUES.has(outcome)) throw new ReviewError("INVALID_REVIEW", `Unsupported check outcome: ${outcome}`);
    if (!Object.hasOwn(check, "note") || typeof check.note !== "string") {
      throw new ReviewError("INVALID_REVIEW", `checks[${index}].note is required and must be a string.`);
    }
    return { name, outcome, note: optionalString(check.note, `checks[${index}].note`, 1_000) || "" };
  });

  const issues = raw.issues.map((issue, index) => {
    requireObject(issue, `issues[${index}]`);
    assertKnownKeys(issue, new Set(["severity", "code", "message", "evidence"]), `issues[${index}]`);
    const severity = requiredString(issue.severity, `issues[${index}].severity`, 30);
    if (!SEVERITY_VALUES.has(severity)) throw new ReviewError("INVALID_REVIEW", `Unsupported issue severity: ${severity}`);
    const code = requiredString(issue.code, `issues[${index}].code`, 64);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
      throw new ReviewError("INVALID_REVIEW", `issues[${index}].code must be an uppercase identifier.`);
    }
    const evidence = optionalString(issue.evidence, `issues[${index}].evidence`, 2_000);
    return {
      severity,
      code,
      message: requiredString(issue.message, `issues[${index}].message`, 2_000),
      ...(evidence ? { evidence } : {}),
    };
  });

  const failedChecks = checks.filter((check) => check.outcome === "fail");
  const uncertainChecks = checks.filter((check) => check.outcome === "uncertain");
  const errorIssues = issues.filter((issue) => issue.severity === "error");
  const warningIssues = issues.filter((issue) => issue.severity === "warning");
  if (status === "not_run") {
    if (method !== "not_run" || checks.length || issues.length) {
      throw new ReviewError("INVALID_REVIEW", "not_run requires method=not_run with empty checks and issues.");
    }
  } else {
    if (method === "not_run") throw new ReviewError("INVALID_REVIEW", `${status} cannot use method=not_run.`);
    if (!checks.length) throw new ReviewError("INVALID_REVIEW", `${status} requires at least one check.`);
  }
  if (["passed", "passed_with_notes"].includes(status) && (failedChecks.length || errorIssues.length)) {
    throw new ReviewError("INVALID_REVIEW", `${status} cannot contain failed checks or error issues.`);
  }
  if (status === "passed" && (uncertainChecks.length || warningIssues.length)) {
    throw new ReviewError("INVALID_REVIEW", "passed cannot contain uncertain checks or warning issues; use passed_with_notes.");
  }
  if (status === "failed" && !failedChecks.length && !errorIssues.length) {
    throw new ReviewError("INVALID_REVIEW", "failed requires a failed check or error issue.");
  }
  if (status === "passed_with_notes" && !uncertainChecks.length && !warningIssues.length && !issues.length) {
    throw new ReviewError("INVALID_REVIEW", "passed_with_notes requires an uncertain check or a non-error issue.");
  }

  let reviewedAt = new Date().toISOString();
  if (raw.reviewed_at !== undefined) {
    const candidate = requiredString(raw.reviewed_at, "reviewed_at", 100);
    const parsed = new Date(candidate);
    if (Number.isNaN(parsed.getTime())) throw new ReviewError("INVALID_REVIEW", "reviewed_at must be an ISO date-time.");
    reviewedAt = parsed.toISOString();
  }
  return { status, method, summary, reviewed_at: reviewedAt, checks, issues };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const resultPath = path.resolve(args.result);
  const reviewPath = path.resolve(args.review);
  const result = await readJson(resultPath, "result JSON");
  const review = normalizeReview(await readJson(reviewPath, "review JSON"));
  if (!result || result.ok !== true || result.status !== "generated") {
    throw new ReviewError("INVALID_RESULT", "Review can be recorded only for a successful generated result.");
  }
  const imagePathValue = result?.output?.image_path;
  const expectedHash = result?.output?.sha256;
  if (typeof imagePathValue !== "string" || typeof expectedHash !== "string") {
    throw new ReviewError("INVALID_RESULT", "result.output must contain image_path and sha256.");
  }
  const imagePath = path.isAbsolute(imagePathValue)
    ? path.resolve(imagePathValue)
    : path.resolve(path.dirname(resultPath), imagePathValue);
  let image;
  try {
    image = await readFile(imagePath);
  } catch (error) {
    throw new ReviewError("IMAGE_NOT_FOUND", `Cannot read generated image: ${error?.message || error}`, { image_path: imagePath });
  }
  const actualHash = createHash("sha256").update(image).digest("hex");
  if (actualHash !== expectedHash) {
    throw new ReviewError("OUTPUT_HASH_MISMATCH", "Generated image changed after result.json was created.", {
      image_path: imagePath,
      expected_sha256: expectedHash,
      actual_sha256: actualHash,
    });
  }

  result.review = {
    ...review,
    image_sha256: actualHash,
  };
  await writeJsonAtomically(resultPath, result);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    result_path: resultPath,
    image_path: imagePath,
    review_status: review.status,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: {
      code: error?.code || "UNEXPECTED_ERROR",
      message: error?.message || String(error),
      ...(error?.details ? { details: error.details } : {}),
    },
  }, null, 2)}\n`);
  process.exitCode = 1;
});
