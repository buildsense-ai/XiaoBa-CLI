#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadBoundReferenceImages,
  publicReferenceDescriptor,
  referenceImageDataUrl,
} from "./reference-image-utils.mjs";
import { image2FailurePolicy } from "./lib/failure-policy.mjs";

const DEFAULT_API_BASE = "https://api.openai.com/v1";
const DEFAULT_CATSCO_HTTP_BASE_URL = "https://app.catsco.cc";
const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_ASYNC_POLL_INTERVAL_MS = 3_000;
const DEFAULT_ASYNC_TIMEOUT_MS = 30 * 60 * 1_000;

const CONFIG_ENV_KEYS = new Set([
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
]);

const ALLOWED_FIELDS = new Set([
  "operation",
  "prompt",
  "source_prompt",
  "source_request",
  "source_brief",
  "reference_images",
  "purpose",
  "subject",
  "scene",
  "style",
  "composition",
  "lighting",
  "palette",
  "must_include",
  "must_avoid",
  "exact_text",
  "creative_freedom",
  "aspect_ratio",
  "size",
  "quality",
  "output_format",
  "filename",
  "count",
  "background",
  "model",
]);

const SIZE_BY_RATIO = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "16:9": "1536x864",
  "9:16": "864x1536",
  "4:3": "1280x960",
  "3:4": "960x1280",
  landscape: "1536x1024",
  portrait: "1024x1536",
  square: "1024x1024",
};

class ImageGenerationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ImageGenerationError";
    this.code = code;
    this.details = details;
  }
}

function usage() {
  return [
    "Usage:",
    "  node generate-image.mjs --request <request.json> --out-dir <directory> [--task-id <id>]",
    "  node generate-image.mjs --request <request.json> --dry-run",
    "  node generate-image.mjs --request <request.json> --inspect-request",
    "",
    "Environment:",
    "  CATSCO_HTTP_BASE_URL   Existing CatsCo service URL; automatically enables its /v1 image gateway",
    "  CATSCO_IMAGE_API_BASE  Optional explicit CatsCo image-gateway override",
    "  CATSCO_API_KEY         Current bot identity used first in CatsCo gateway mode",
    "  CATSCO_USER_TOKEN      Existing user login; retried once only after an explicit bot-key HTTP 401",
    "  IMAGE_GEN_API_KEY       Preferred API key",
    "  OPENAI_API_KEY          Fallback API key",
    `  IMAGE_GEN_API_BASE      Default: ${DEFAULT_API_BASE}`,
    `  IMAGE_GEN_MODEL         Default: ${DEFAULT_MODEL}`,
    "  IMAGE_GEN_TIMEOUT_MS    Request timeout; default 600000",
    "  IMAGE_GEN_MAX_RETRIES   Safe-operation retry count for HTTP 429 and image URL downloads; default 1",
    "  IMAGE_GEN_ASYNC_POLL_BASE defaults to the generation endpoint origin",
    "  IMAGE_GEN_ASYNC_SUBMIT=true requests an immediate task_id when supported",
    "  IMAGE_GEN_ASYNC_POLL_INTERVAL_MS defaults to 3000",
    "  IMAGE_GEN_ASYNC_TIMEOUT_MS defaults to 1800000 (30 minutes)",
    "  IMAGE_GEN_ALLOW_INSECURE_HTTP=true permits an http:// API base for local testing",
    "  IMAGE_GEN_DISABLE_CATSCO_GATEWAY=true bypasses automatic CatsCo gateway discovery",
    "  IMAGE_GEN_ENV_FILE     Optional explicit .env path; XiaoBa runtime .env is auto-discovered",
  ].join("\n");
}

function parseDotEnvValue(rawValue) {
  let value = rawValue.trim();
  if (!value) return "";
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
    if (quote === "\"") {
      value = value
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\\"/g, "\"")
        .replace(/\\\\/g, "\\");
    }
    return value;
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function parseDotEnv(content) {
  const parsed = new Map();
  for (const rawLine of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(rawLine);
    if (!match || !CONFIG_ENV_KEYS.has(match[1])) continue;
    parsed.set(match[1], parseDotEnvValue(match[2]));
  }
  return parsed;
}

async function loadRuntimeEnvFiles() {
  if (process.env.IMAGE_GEN_DISABLE_ENV_FILE === "true") return [];
  const candidates = [
    process.env.IMAGE_GEN_ENV_FILE,
    process.env.XIAOBA_USER_DATA_DIR && path.join(process.env.XIAOBA_USER_DATA_DIR, ".env"),
    process.env.CATSCO_USER_DATA_DIR && path.join(process.env.CATSCO_USER_DATA_DIR, ".env"),
    process.env.XIAOBA_ELECTRON_USER_DATA_DIR && path.join(process.env.XIAOBA_ELECTRON_USER_DATA_DIR, ".env"),
    process.env.XIAOBA_RUNTIME_ROOT && path.join(process.env.XIAOBA_RUNTIME_ROOT, ".env"),
    path.join(process.cwd(), ".env"),
  ].filter(Boolean).map((candidate) => path.resolve(candidate));
  const loaded = [];
  for (const candidate of [...new Set(candidates)]) {
    let content;
    try {
      content = await readFile(candidate, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new ImageGenerationError("INVALID_CONFIGURATION", `Cannot read image configuration file: ${error?.message || error}`, {
        env_file: candidate,
      });
    }
    let applied = false;
    for (const [name, value] of parseDotEnv(content)) {
      if (String(process.env[name] || "").trim()) continue;
      process.env[name] = value;
      applied = true;
    }
    if (applied) loaded.push(candidate);
  }
  return loaded;
}

function parseArgs(argv) {
  const args = { dryRun: false, inspectRequest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--request") args.request = argv[++index];
    else if (token === "--out-dir") args.outDir = argv[++index];
    else if (token === "--task-id") args.taskId = argv[++index];
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--inspect-request") args.inspectRequest = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new ImageGenerationError("INVALID_ARGUMENT", `Unknown argument: ${token}`);
  }
  if (args.help) return args;
  if (!args.request) throw new ImageGenerationError("INVALID_ARGUMENT", "--request is required.");
  if (args.dryRun && args.inspectRequest) {
    throw new ImageGenerationError("INVALID_ARGUMENT", "--dry-run and --inspect-request cannot be combined.");
  }
  if (args.taskId !== undefined && !optionalString(args.taskId, "--task-id", 500)) {
    throw new ImageGenerationError("INVALID_ARGUMENT", "--task-id cannot be empty.");
  }
  if (!args.dryRun && !args.inspectRequest && !args.outDir) {
    throw new ImageGenerationError(
      "INVALID_ARGUMENT",
      "--out-dir is required unless --dry-run or --inspect-request is used.",
    );
  }
  return args;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImageGenerationError("INVALID_REQUEST", `${label} must be a JSON object.`);
  }
}

function optionalString(value, label, maxLength = 4_000) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ImageGenerationError("INVALID_REQUEST", `${label} must be a string.`);
  }
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maxLength) {
    throw new ImageGenerationError("INVALID_REQUEST", `${label} exceeds ${maxLength} characters.`);
  }
  return text;
}

function optionalVerbatimString(value, label, maxLength = 4_000) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ImageGenerationError("INVALID_REQUEST", `${label} must be a string.`);
  }
  if (!value.trim()) return undefined;
  if (value.length > maxLength) {
    throw new ImageGenerationError("INVALID_REQUEST", `${label} exceeds ${maxLength} characters.`);
  }
  return value;
}

function stringList(value, label, maxItems = 20) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ImageGenerationError("INVALID_REQUEST", `${label} must be an array with at most ${maxItems} items.`);
  }
  return value.map((item, index) => {
    const text = optionalString(item, `${label}[${index}]`, 500);
    if (!text) throw new ImageGenerationError("INVALID_REQUEST", `${label}[${index}] cannot be empty.`);
    return text;
  });
}

function normalizeFilename(value) {
  const source = optionalString(value, "filename", 120) || "generated-image";
  const withoutExtension = source.replace(/\.(png|jpe?g|webp)$/i, "");
  const slug = withoutExtension
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "generated-image";
}

function parsePositiveInteger(raw, fallback, min, max, label) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ImageGenerationError("INVALID_CONFIGURATION", `${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function normalizeSize(value, aspectRatio) {
  const inferred = aspectRatio ? SIZE_BY_RATIO[aspectRatio] : "auto";
  const size = optionalString(value, "size", 32) || inferred;
  if (size === "auto") return size;
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(size);
  if (!match) {
    throw new ImageGenerationError("INVALID_REQUEST", "size must be auto or look like 1024x1024.");
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 512 || height < 512 || width > 3840 || height > 3840) {
    throw new ImageGenerationError("INVALID_REQUEST", "size edges must be between 512 and 3840 pixels.");
  }
  if (width / height > 3 || height / width > 3) {
    throw new ImageGenerationError("INVALID_REQUEST", "size aspect ratio cannot exceed 3:1.");
  }
  return size;
}

function sizeDimensions(size) {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) throw new ImageGenerationError("INVALID_REQUEST", "size could not be parsed.");
  return { width: Number(match[1]), height: Number(match[2]) };
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function aspectRatioFromSize(size) {
  const { width, height } = sizeDimensions(size);
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function numericAspectRatio(value) {
  if (SIZE_BY_RATIO[value]) {
    const { width, height } = sizeDimensions(SIZE_BY_RATIO[value]);
    return width / height;
  }
  const match = /^(\d{1,4}):(\d{1,4})$/.exec(value);
  if (!match || Number(match[2]) === 0) return null;
  return Number(match[1]) / Number(match[2]);
}

function normalizeRequest(raw, sources = {}) {
  requireObject(raw, "request");
  const unknown = Object.keys(raw).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length) {
    throw new ImageGenerationError("INVALID_REQUEST", `Unknown request field(s): ${unknown.join(", ")}`);
  }

  const operation = optionalString(raw.operation, "operation", 30) || "generate";
  if (operation !== "generate") {
    throw new ImageGenerationError("UNSUPPORTED_OPERATION", "V1 supports only operation=generate.");
  }
  const count = raw.count ?? 1;
  if (count !== 1) throw new ImageGenerationError("UNSUPPORTED_OPERATION", "V1 generates exactly one image per run.");
  const background = optionalString(raw.background, "background", 30) || "opaque";
  if (background !== "opaque") {
    throw new ImageGenerationError("UNSUPPORTED_OPERATION", "V1 supports only an opaque background.");
  }

  const sourcePrompt = sources.sourcePrompt || null;
  const sourceRequest = sources.sourceRequest || null;
  const sourceBrief = sources.sourceBrief || null;
  const referenceImages = sources.referenceImages || [];
  const promptSourceCount = [raw.prompt !== undefined, Boolean(sourcePrompt), Boolean(sourceBrief)]
    .filter(Boolean).length;
  if (promptSourceCount > 1) {
    throw new ImageGenerationError(
      "INVALID_REQUEST",
      "Use exactly one model-facing prompt source: prompt, source_prompt, or legacy source_brief.",
    );
  }
  const prompt = sourcePrompt?.text || sourceBrief?.text || optionalVerbatimString(raw.prompt, "prompt", 12_000);
  const subject = optionalString(raw.subject, "subject", 2_000);
  if (!prompt && !subject) {
    throw new ImageGenerationError("INVALID_REQUEST", "Provide at least one of prompt or subject.");
  }

  const explicitAspectRatio = optionalString(raw.aspect_ratio, "aspect_ratio", 30);
  if (explicitAspectRatio && numericAspectRatio(explicitAspectRatio) === null) {
    throw new ImageGenerationError("INVALID_REQUEST", "aspect_ratio must be a W:H ratio or landscape, portrait, or square.");
  }
  const quality = optionalString(raw.quality, "quality", 30) || "medium";
  if (!["low", "medium", "high", "auto"].includes(quality)) {
    throw new ImageGenerationError("INVALID_REQUEST", "quality must be low, medium, high, or auto.");
  }
  const creativeFreedom = optionalString(raw.creative_freedom, "creative_freedom", 30);
  if (creativeFreedom && !["strict", "balanced", "open"].includes(creativeFreedom)) {
    throw new ImageGenerationError(
      "INVALID_REQUEST",
      "creative_freedom must be strict, balanced, or open.",
    );
  }
  const outputFormat = (optionalString(raw.output_format, "output_format", 20) || "png").toLowerCase();
  if (!["png", "jpeg", "jpg", "webp"].includes(outputFormat)) {
    throw new ImageGenerationError("INVALID_REQUEST", "output_format must be png, jpeg, jpg, or webp.");
  }

  const size = normalizeSize(raw.size, explicitAspectRatio);
  if (explicitAspectRatio && size === "auto") {
    throw new ImageGenerationError("INVALID_REQUEST", "size=auto cannot be combined with an explicit aspect_ratio.");
  }
  const aspectRatio = explicitAspectRatio || (size === "auto" ? undefined : aspectRatioFromSize(size));
  if (explicitAspectRatio && raw.size !== undefined) {
    const { width, height } = sizeDimensions(size);
    const ratioDelta = Math.abs((width / height) / numericAspectRatio(explicitAspectRatio) - 1);
    if (ratioDelta > 0.03) {
      throw new ImageGenerationError("INVALID_REQUEST", "aspect_ratio and size describe different proportions.", {
        aspect_ratio: explicitAspectRatio,
        size,
      });
    }
  }
  if (explicitAspectRatio && raw.size === undefined && !SIZE_BY_RATIO[explicitAspectRatio]) {
    throw new ImageGenerationError("INVALID_REQUEST", "Provide size when using a nonstandard numeric aspect_ratio.");
  }

  return {
    operation,
    prompt,
    raw_request: sourceRequest?.text,
    source_prompt: sourcePrompt ? {
      path: sourcePrompt.path,
      sha256: sourcePrompt.sha256,
    } : undefined,
    source_request: sourceRequest ? {
      path: sourceRequest.path,
      sha256: sourceRequest.sha256,
    } : undefined,
    source_brief: sourceBrief ? {
      path: sourceBrief.path,
      sha256: sourceBrief.sha256,
    } : undefined,
    reference_images: referenceImages.map((reference) => publicReferenceDescriptor(reference)),
    purpose: optionalString(raw.purpose, "purpose", 500),
    subject,
    scene: optionalString(raw.scene, "scene", 2_000),
    style: optionalString(raw.style, "style", 1_000),
    composition: optionalString(raw.composition, "composition", 1_000),
    lighting: optionalString(raw.lighting, "lighting", 500),
    palette: stringList(raw.palette, "palette", 12),
    must_include: stringList(raw.must_include, "must_include"),
    must_avoid: stringList(raw.must_avoid, "must_avoid"),
    exact_text: stringList(raw.exact_text, "exact_text", 10),
    creative_freedom: creativeFreedom,
    aspect_ratio: aspectRatio,
    size,
    quality,
    output_format: outputFormat === "jpg" ? "jpeg" : outputFormat,
    filename: normalizeFilename(raw.filename),
    count,
    background,
    model: optionalString(raw.model, "model", 200),
  };
}

async function loadBoundText(rawSource, requestPath, fieldName, codePrefix, maxLength = 12_000) {
  if (rawSource === undefined || rawSource === null) return null;
  requireObject(rawSource, fieldName);
  const unknown = Object.keys(rawSource).filter((key) => !["path", "sha256"].includes(key));
  if (unknown.length) {
    throw new ImageGenerationError("INVALID_REQUEST", `Unknown ${fieldName} field(s): ${unknown.join(", ")}`);
  }
  const sourcePathValue = optionalString(rawSource.path, `${fieldName}.path`, 1_000);
  const expectedSha256 = optionalString(rawSource.sha256, `${fieldName}.sha256`, 64)?.toLowerCase();
  if (!sourcePathValue || !expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new ImageGenerationError(
      "INVALID_REQUEST",
      `${fieldName} requires path and a lowercase or uppercase SHA-256 digest.`,
    );
  }
  const sourcePath = path.isAbsolute(sourcePathValue)
    ? path.resolve(sourcePathValue)
    : path.resolve(path.dirname(requestPath), sourcePathValue);
  let sourceText;
  try {
    sourceText = (await readFile(sourcePath, "utf8")).replace(/^\uFEFF/, "");
  } catch (error) {
    throw new ImageGenerationError(`${codePrefix}_UNREADABLE`, `Cannot read ${fieldName}: ${error?.message || error}`, {
      [`${fieldName}_path`]: sourcePath,
    });
  }
  const text = optionalVerbatimString(sourceText, fieldName, maxLength);
  if (!text) {
    throw new ImageGenerationError("INVALID_REQUEST", `The ${fieldName} file is empty.`);
  }
  const actualSha256 = createHash("sha256").update(text, "utf8").digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new ImageGenerationError(`${codePrefix}_MISMATCH`, `The ${fieldName} file changed after request preparation.`, {
      [`${fieldName}_path`]: sourcePath,
      expected_sha256: expectedSha256,
      actual_sha256: actualSha256,
    });
  }
  return {
    path: sourcePathValue,
    resolvedPath: sourcePath,
    sha256: actualSha256,
    text,
  };
}

function bulletSection(title, items) {
  if (!items.length) return undefined;
  return `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function creativeFreedomInstruction(value) {
  if (!value) return undefined;
  if (value === "open") {
    return "Creative freedom: open. Develop supporting details and visual motifs when they strengthen the requested result, while preserving explicit requirements.";
  }
  if (value === "balanced") {
    return "Creative freedom: balanced. Add minor supporting details when needed for coherence, without changing the main subject or requested visual category.";
  }
  return "Creative freedom: strict. Follow the supplied prompt closely and do not introduce new major subjects, characters, objects, locations, or narrative actions.";
}

function referenceImageSection(referenceImages) {
  if (!referenceImages.length) return undefined;
  const items = referenceImages.map((reference, index) => (
    `- Reference image ${index + 1}: ${reference.use_for}`
  ));
  return [
    "Reference image guidance (images are attached in this exact order):",
    ...items,
    "Use each image only for the stated purpose. Follow the authored prompt for all other visual decisions.",
  ].join("\n");
}

function buildPrompt(request) {
  const outputLayout = request.size === "auto"
    ? "with an automatically selected canvas size"
    : `at ${request.aspect_ratio} (${request.size})`;
  const sections = [
    request.prompt,
    referenceImageSection(request.reference_images),
    creativeFreedomInstruction(request.creative_freedom),
    request.purpose && `Intended use: ${request.purpose}`,
    request.subject && `Main subject: ${request.subject}`,
    request.scene && `Scene and context: ${request.scene}`,
    request.style && `Visual style: ${request.style}`,
    request.composition && `Composition: ${request.composition}`,
    request.lighting && `Lighting: ${request.lighting}`,
    bulletSection("Color palette", request.palette),
    bulletSection("Must include", request.must_include),
    bulletSection("Must avoid", request.must_avoid),
    bulletSection("Render this text exactly", request.exact_text),
    `Output requirements: create one finished raster image with an opaque background ${outputLayout}. Do not add written text, watermarks, or signatures unless explicitly requested above.`,
  ].filter(Boolean);
  return sections.join("\n\n");
}

function resolveEndpoint(apiBase, apiOperation) {
  const value = apiBase.replace(/\/+$/, "");
  const endpointName = apiOperation === "edits" ? "edits" : "generations";
  if (/\/images\/(?:generations|edits)$/.test(value)) {
    return value.replace(/\/images\/(?:generations|edits)$/, `/images/${endpointName}`);
  }
  return `${value}/images/${endpointName}`;
}

function resolveCatsCoImageApiBase(httpBase) {
  const value = httpBase.replace(/\/+$/, "");
  return value.endsWith("/v1") ? value : `${value}/v1`;
}

function assertSafeUrl(value, allowInsecureHttp, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ImageGenerationError("INVALID_CONFIGURATION", `${label} is not a valid URL.`);
  }
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    throw new ImageGenerationError(
      "INVALID_CONFIGURATION",
      `${label} must use https://. Set IMAGE_GEN_ALLOW_INSECURE_HTTP=true only for a trusted local endpoint.`,
    );
  }
  return url.toString();
}

function resolveConfig(request) {
  const allowInsecureHttp = process.env.IMAGE_GEN_ALLOW_INSECURE_HTTP === "true";
  const catsCoBotApiKey = process.env.CATSCO_API_KEY?.trim() || process.env.CATSCOMPANY_API_KEY?.trim();
  const catsCoUserToken = process.env.CATSCO_USER_TOKEN?.trim() || process.env.CATSCOMPANY_USER_TOKEN?.trim();
  const catsCoCredential = catsCoBotApiKey
    ? { mode: "catsco-bot", scheme: "ApiKey", token: catsCoBotApiKey }
    : { mode: "catsco-user", scheme: "Bearer", token: catsCoUserToken };
  const explicitCatsCoApiBase = process.env.CATSCO_IMAGE_API_BASE?.trim();
  const catsCoHttpBase = process.env.CATSCO_HTTP_BASE_URL?.trim()
    || process.env.CATSCOMPANY_HTTP_BASE_URL?.trim();
  const autoCatsCoGateway = process.env.IMAGE_GEN_DISABLE_CATSCO_GATEWAY !== "true"
    && Boolean(catsCoHttpBase || catsCoCredential.token);
  const derivedCatsCoApiBase = autoCatsCoGateway
    ? resolveCatsCoImageApiBase(catsCoHttpBase || DEFAULT_CATSCO_HTTP_BASE_URL)
    : undefined;
  const catsCoApiBase = explicitCatsCoApiBase || derivedCatsCoApiBase;
  const authMode = catsCoApiBase ? catsCoCredential.mode : "provider-key";
  const apiBase = catsCoApiBase || process.env.IMAGE_GEN_API_BASE?.trim() || DEFAULT_API_BASE;
  const apiBaseLabel = explicitCatsCoApiBase
    ? "CATSCO_IMAGE_API_BASE"
    : derivedCatsCoApiBase
      ? "CATSCO_HTTP_BASE_URL"
      : "IMAGE_GEN_API_BASE";
  const apiOperation = request.reference_images.length ? "edits" : "generations";
  const endpoint = assertSafeUrl(resolveEndpoint(apiBase, apiOperation), allowInsecureHttp, apiBaseLabel);
  const endpointOrigin = new URL(endpoint).origin;
  const asyncPollBaseValue = catsCoApiBase
    ? endpointOrigin
    : process.env.IMAGE_GEN_ASYNC_POLL_BASE?.trim() || endpointOrigin;
  const asyncPollBase = assertSafeUrl(
    asyncPollBaseValue,
    allowInsecureHttp,
    "IMAGE_GEN_ASYNC_POLL_BASE",
  ).replace(/\/+$/, "");
  return {
    gatewayRace: Boolean(catsCoApiBase),
    authMode,
    apiOperation,
    authScheme: catsCoApiBase ? catsCoCredential.scheme : "Bearer",
    authToken: catsCoApiBase
      ? catsCoCredential.token
      : process.env.IMAGE_GEN_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim(),
    authFallback: catsCoApiBase && catsCoBotApiKey && catsCoUserToken
      ? { mode: "catsco-user", scheme: "Bearer", token: catsCoUserToken }
      : null,
    endpoint,
    allowInsecureHttp,
    model: request.model || process.env.IMAGE_GEN_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: parsePositiveInteger(process.env.IMAGE_GEN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 600_000, "IMAGE_GEN_TIMEOUT_MS"),
    maxRetries: parsePositiveInteger(process.env.IMAGE_GEN_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0, 5, "IMAGE_GEN_MAX_RETRIES"),
    retryDelayMs: parsePositiveInteger(process.env.IMAGE_GEN_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS, 0, 60_000, "IMAGE_GEN_RETRY_DELAY_MS"),
    maxImageBytes: parsePositiveInteger(process.env.IMAGE_GEN_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES, 1_024, 100 * 1024 * 1024, "IMAGE_GEN_MAX_IMAGE_BYTES"),
    asyncPollBase,
    asyncPollIntervalMs: parsePositiveInteger(process.env.IMAGE_GEN_ASYNC_POLL_INTERVAL_MS, DEFAULT_ASYNC_POLL_INTERVAL_MS, 10, 60_000, "IMAGE_GEN_ASYNC_POLL_INTERVAL_MS"),
    asyncTimeoutMs: parsePositiveInteger(process.env.IMAGE_GEN_ASYNC_TIMEOUT_MS, DEFAULT_ASYNC_TIMEOUT_MS, 1_000, 3_600_000, "IMAGE_GEN_ASYNC_TIMEOUT_MS"),
    asyncSubmit: !catsCoApiBase && process.env.IMAGE_GEN_ASYNC_SUBMIT === "true" && apiOperation === "generations",
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return { body: {}, text, isJson: true };
  try {
    return { body: JSON.parse(text), text, isJson: true };
  } catch {
    return { body: null, text, isJson: false };
  }
}

function apiErrorMessage(body, status) {
  return body?.error?.message
    || (typeof body?.error === "string" ? body.error : undefined)
    || body?.message
    || `Image API request failed with HTTP ${status}.`;
}

function catsCoRaceError(body, status, operation) {
  const code = String(body?.error?.code || "").trim();
  if (code === "race_exhausted") {
    return new ImageGenerationError(
      "IMAGE_RACE_EXHAUSTED",
      apiErrorMessage(body, status),
      {
        status,
        operation,
        race_id: body?.error?.race_id || null,
        rounds: body?.error?.rounds || null,
        attempts: body?.error?.attempts || null,
        provider_attempts: body?.error?.provider_attempts || null,
      },
    );
  }
  if (code === "providers_unavailable") {
    return new ImageGenerationError(
      "IMAGE_RACE_UNAVAILABLE",
      apiErrorMessage(body, status),
      {
        status,
        operation,
        race_id: body?.error?.race_id || null,
        rounds: body?.error?.rounds || null,
        attempts: body?.error?.attempts || null,
        provider_attempts: body?.error?.provider_attempts || null,
      },
    );
  }
  return null;
}

async function generateViaApi(payload, config) {
  let credential = {
    mode: config.authMode,
    scheme: config.authScheme,
    token: config.authToken,
  };
  let identityFallbackUsed = false;
  let rateLimitRetries = 0;
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      const response = await fetchWithTimeout(config.endpoint, {
        method: "POST",
        headers: {
          Authorization: `${credential.scheme} ${credential.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }, config.timeoutMs);
      const parsed = await readResponseBody(response);
      if (response.ok) {
        if (!parsed.isJson) {
          throw new ImageGenerationError("INVALID_API_RESPONSE", "Image API returned non-JSON content.", {
            status: response.status,
            preview: parsed.text.slice(0, 500),
          });
        }
        return { body: parsed.body, attempts, credential, identityFallbackUsed };
      }

      if (response.status === 401 && config.authFallback && !identityFallbackUsed) {
        credential = config.authFallback;
        identityFallbackUsed = true;
        continue;
      }

      if (config.gatewayRace && parsed.isJson) {
        const raceError = catsCoRaceError(parsed.body, response.status, config.apiOperation);
        if (raceError) throw raceError;
      }

      if (response.status === 504 || response.status === 524) {
        throw new ImageGenerationError(
          "UPSTREAM_TIMEOUT",
          `Image gateway returned HTTP ${response.status} before generation completed.`,
          { status: response.status, retryable: false, operation: config.apiOperation },
        );
      }
      if (response.status === 404 && config.apiOperation === "edits" && config.authMode.startsWith("catsco-")) {
        throw new ImageGenerationError(
          "REFERENCE_GATEWAY_UNAVAILABLE",
          "The configured CatsCo gateway does not expose /v1/images/edits yet. Keep this prepared run and deploy the reference-image gateway route before retrying.",
          { status: response.status, retryable: false, operation: config.apiOperation },
        );
      }
      const retryable = response.status === 429;
      if (retryable && rateLimitRetries < config.maxRetries) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfterSeconds)
          ? Math.min(retryAfterSeconds * 1_000, 60_000)
          : config.retryDelayMs * (rateLimitRetries + 1);
        rateLimitRetries += 1;
        await delay(waitMs);
        continue;
      }
      throw new ImageGenerationError("API_REQUEST_FAILED", apiErrorMessage(parsed.body, response.status), {
        status: response.status,
        retryable,
        operation: config.apiOperation,
        ...(!parsed.isJson ? { response_preview: parsed.text.slice(0, 500) } : {}),
      });
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error;
      const timedOut = error?.name === "AbortError";
      throw new ImageGenerationError(
        timedOut ? "API_TIMEOUT" : "API_NETWORK_ERROR",
        timedOut ? `Image API timed out after ${config.timeoutMs} ms.` : `Image API request failed: ${error?.message || error}`,
      );
    }
  }
}

function summarizeApiBody(body) {
  if (body === null) return { response_type: "null" };
  if (Array.isArray(body)) return { response_type: "array", length: body.length };
  if (typeof body !== "object") {
    return { response_type: typeof body, value_preview: String(body).slice(0, 300) };
  }
  const summary = {
    response_type: "object",
    top_level_keys: Object.keys(body).slice(0, 30),
  };
  for (const key of ["id", "request_id", "status", "code", "message"]) {
    const value = body[key];
    if (["string", "number", "boolean"].includes(typeof value)) summary[key] = String(value).slice(0, 500);
  }
  if (Array.isArray(body.data)) summary.data_length = body.data.length;
  else if (body.data !== undefined) summary.data_type = typeof body.data;
  if (Array.isArray(body.images)) summary.images_length = body.images.length;
  if (Array.isArray(body.output)) summary.output_length = body.output.length;
  if (typeof body.error === "string") summary.error = body.error.slice(0, 500);
  else if (body.error && typeof body.error === "object") {
    summary.error = {
      ...(typeof body.error.type === "string" ? { type: body.error.type.slice(0, 200) } : {}),
      ...(typeof body.error.code === "string" ? { code: body.error.code.slice(0, 200) } : {}),
      ...(typeof body.error.message === "string" ? { message: body.error.message.slice(0, 500) } : {}),
    };
  }
  return summary;
}

function asyncTaskFromBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (Array.isArray(body.data) && body.data.some((item) => item?.url || item?.b64_json)) return null;
  const status = String(body.status || "").trim().toLowerCase();
  const taskId = typeof body.task_id === "string"
    ? body.task_id.trim()
    : (["queued", "pending", "processing", "in_progress", "submitted"].includes(status) && typeof body.id === "string"
      ? body.id.trim()
      : "");
  if (!taskId) return null;
  if (["failed", "expired", "canceled", "cancelled"].includes(status)) {
    throw new ImageGenerationError("ASYNC_TASK_FAILED", "Image provider returned a failed asynchronous task.", {
      task_id: taskId,
      status,
      response_summary: summarizeApiBody(body),
    });
  }
  return {
    taskId,
    status: status || "queued",
    progress: body.progress ?? null,
    message: typeof body.message === "string" ? body.message.slice(0, 500) : null,
  };
}

function resolveAsyncTaskEndpoint(config, taskId) {
  const base = config.asyncPollBase.replace(/\/+$/, "");
  const encodedTaskId = encodeURIComponent(taskId);
  const value = base.endsWith("/v1/tasks") ? `${base}/${encodedTaskId}` : `${base}/v1/tasks/${encodedTaskId}`;
  return assertSafeUrl(value, config.allowInsecureHttp, "asynchronous task endpoint");
}

function asyncFailureMessage(body, fallback) {
  if (typeof body?.error === "string" && body.error.trim()) return body.error.trim();
  if (typeof body?.error?.message === "string" && body.error.message.trim()) return body.error.message.trim();
  if (typeof body?.message === "string" && body.message.trim()) return body.message.trim();
  return fallback;
}

async function pollAsyncTask(taskId, config) {
  const endpoint = resolveAsyncTaskEndpoint(config, taskId);
  const startedMs = Date.now();
  const failedStatuses = new Set(["failed", "expired", "canceled", "cancelled"]);
  const transientStatuses = new Set([429, 500, 502, 503, 504, 524]);
  let polls = 0;
  let lastStatus = "queued";
  let lastProgress = null;
  let lastError = null;

  await delay(config.asyncPollIntervalMs);
  while (Date.now() - startedMs <= config.asyncTimeoutMs) {
    let response;
    try {
      response = await fetchWithTimeout(endpoint, {
        method: "GET",
        headers: { Authorization: `${config.authScheme} ${config.authToken}` },
      }, Math.min(config.timeoutMs, 60_000));
    } catch (error) {
      lastError = error?.name === "AbortError" ? "poll request timed out" : String(error?.message || error);
      await delay(config.asyncPollIntervalMs);
      continue;
    }
    polls += 1;
    const parsed = await readResponseBody(response);
    if (response.status === 404) {
      throw new ImageGenerationError("ASYNC_TASK_NOT_FOUND", "Asynchronous image task expired or does not exist.", {
        task_id: taskId,
        polls,
      });
    }
    if (!response.ok) {
      lastError = `HTTP ${response.status}`;
      if (transientStatuses.has(response.status)) {
        await delay(config.asyncPollIntervalMs);
        continue;
      }
      throw new ImageGenerationError("ASYNC_POLL_FAILED", asyncFailureMessage(parsed.body, `Task polling failed with HTTP ${response.status}.`), {
        task_id: taskId,
        status: response.status,
        response_summary: summarizeApiBody(parsed.body),
      });
    }
    if (!parsed.isJson) {
      throw new ImageGenerationError("ASYNC_POLL_FAILED", "Task endpoint returned non-JSON content.", {
        task_id: taskId,
        status: response.status,
        response_preview: parsed.text.slice(0, 500),
      });
    }
    const body = parsed.body;
    if (Array.isArray(body?.data) && body.data.some((item) => item?.url || item?.b64_json)) {
      return { body, polls, endpoint, finalStatus: String(body.status || "completed").toLowerCase() };
    }
    lastStatus = String(body?.status || lastStatus).toLowerCase();
    lastProgress = body?.progress ?? lastProgress;
    if (failedStatuses.has(lastStatus)) {
      throw new ImageGenerationError("ASYNC_TASK_FAILED", asyncFailureMessage(body, "Asynchronous image generation failed."), {
        task_id: taskId,
        status: lastStatus,
        progress: lastProgress,
        polls,
      });
    }
    await delay(config.asyncPollIntervalMs);
  }

  throw new ImageGenerationError("ASYNC_TASK_TIMEOUT", "Asynchronous image task did not finish before the polling timeout.", {
    task_id: taskId,
    status: lastStatus,
    progress: lastProgress,
    polls,
    last_error: lastError,
  });
}

async function downloadGeneratedImage(imageUrl, config) {
  const transientStatuses = new Set([408, 429, 500, 502, 503, 504, 524]);
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(imageUrl, { method: "GET" }, config.timeoutMs);
    } catch (error) {
      if (attempt < config.maxRetries) {
        await delay(config.retryDelayMs * (attempt + 1));
        continue;
      }
      const timedOut = error?.name === "AbortError";
      throw new ImageGenerationError(
        "IMAGE_DOWNLOAD_FAILED",
        timedOut
          ? `Generated image download timed out after ${config.timeoutMs} ms.`
          : `Generated image download failed: ${error?.message || error}`,
        { attempts: attempt + 1 },
      );
    }

    if (!response.ok) {
      if (transientStatuses.has(response.status) && attempt < config.maxRetries) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfterSeconds)
          ? Math.min(retryAfterSeconds * 1_000, 60_000)
          : config.retryDelayMs * (attempt + 1);
        await delay(waitMs);
        continue;
      }
      throw new ImageGenerationError(
        "IMAGE_DOWNLOAD_FAILED",
        `Generated image download failed with HTTP ${response.status}.`,
        { status: response.status, attempts: attempt + 1 },
      );
    }

    try {
      return await readImageResponse(response, config.maxImageBytes);
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error;
      if (attempt < config.maxRetries) {
        await delay(config.retryDelayMs * (attempt + 1));
        continue;
      }
      throw new ImageGenerationError(
        "IMAGE_DOWNLOAD_FAILED",
        `Generated image download stream failed: ${error?.message || error}`,
        { attempts: attempt + 1 },
      );
    }
  }
  throw new ImageGenerationError("IMAGE_DOWNLOAD_FAILED", "Generated image download failed without a response.");
}

async function imageFromApiResult(body, config) {
  const item = Array.isArray(body?.data) ? body.data[0] : undefined;
  if (!item || typeof item !== "object") {
    throw new ImageGenerationError("INVALID_API_RESPONSE", "Image API response did not contain data[0].", {
      response_summary: summarizeApiBody(body),
    });
  }

  if (typeof item.b64_json === "string" && item.b64_json.trim()) {
    const encoded = item.b64_json.trim();
    const padding = encoded.endsWith("==") ? 2 : (encoded.endsWith("=") ? 1 : 0);
    const estimatedBytes = Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
    if (estimatedBytes > config.maxImageBytes) {
      throw new ImageGenerationError("IMAGE_TOO_LARGE", `Generated image exceeds ${config.maxImageBytes} bytes.`);
    }
    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length) throw new ImageGenerationError("INVALID_API_RESPONSE", "Image API returned empty base64 image data.");
    if (buffer.length > config.maxImageBytes) {
      throw new ImageGenerationError("IMAGE_TOO_LARGE", `Generated image exceeds ${config.maxImageBytes} bytes.`);
    }
    return { buffer, revisedPrompt: item.revised_prompt };
  }

  if (typeof item.url === "string" && item.url.trim()) {
    const imageUrl = assertSafeUrl(item.url.trim(), config.allowInsecureHttp, "generated image URL");
    return {
      buffer: await downloadGeneratedImage(imageUrl, config),
      revisedPrompt: item.revised_prompt,
    };
  }

  throw new ImageGenerationError("INVALID_API_RESPONSE", "Image API data[0] contained neither b64_json nor url.", {
    data_item_keys: Object.keys(item).slice(0, 30),
    response_summary: summarizeApiBody(body),
  });
}

async function readImageResponse(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ImageGenerationError("IMAGE_TOO_LARGE", `Generated image exceeds ${maxBytes} bytes.`);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new ImageGenerationError("IMAGE_TOO_LARGE", `Generated image exceeds ${maxBytes} bytes.`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new ImageGenerationError("IMAGE_TOO_LARGE", `Generated image exceeds ${maxBytes} bytes.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
}

function jpegDimensions(buffer) {
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda || offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (sofMarkers.has(marker) && segmentLength >= 7) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += segmentLength;
  }
  return null;
}

function webpDimensions(buffer) {
  if (buffer.length < 30) return null;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    const width = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
    const height = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
    return { width, height };
  }
  if (chunk === "VP8L" && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === "VP8 " && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function detectImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buffer.length < 24) throw new ImageGenerationError("INVALID_IMAGE", "PNG payload is truncated.");
    return { extension: "png", mediaType: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    const dimensions = jpegDimensions(buffer);
    if (!dimensions) throw new ImageGenerationError("INVALID_IMAGE", "JPEG dimensions could not be read.");
    return { extension: "jpg", mediaType: "image/jpeg", ...dimensions };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const dimensions = webpDimensions(buffer);
    if (!dimensions) throw new ImageGenerationError("INVALID_IMAGE", "WebP dimensions could not be read.");
    return { extension: "webp", mediaType: "image/webp", ...dimensions };
  }
  throw new ImageGenerationError("INVALID_IMAGE", "Generated payload is not a recognized PNG, JPEG, or WebP image.");
}

function checkDimensions(imageType, requestedSize) {
  if (requestedSize === "auto") {
    return {
      width: imageType.width,
      height: imageType.height,
      requested_width: null,
      requested_height: null,
      exact_size_match: null,
      aspect_ratio_match: null,
      ratio_delta: null,
    };
  }
  const match = /^(\d+)x(\d+)$/.exec(requestedSize);
  if (!match) throw new ImageGenerationError("INVALID_REQUEST", "Requested size could not be parsed for QA.");
  const requestedWidth = Number(match[1]);
  const requestedHeight = Number(match[2]);
  const expectedRatio = requestedWidth / requestedHeight;
  const actualRatio = imageType.width / imageType.height;
  const ratioDelta = Math.abs(actualRatio / expectedRatio - 1);
  const aspectRatioMatch = ratioDelta <= 0.03;
  if (!aspectRatioMatch) {
    throw new ImageGenerationError("IMAGE_DIMENSION_MISMATCH", "Generated image aspect ratio differs materially from the request.", {
      requested_size: requestedSize,
      actual_size: `${imageType.width}x${imageType.height}`,
      ratio_delta: Number(ratioDelta.toFixed(6)),
    });
  }
  return {
    width: imageType.width,
    height: imageType.height,
    requested_width: requestedWidth,
    requested_height: requestedHeight,
    exact_size_match: imageType.width === requestedWidth && imageType.height === requestedHeight,
    aspect_ratio_match: true,
    ratio_delta: Number(ratioDelta.toFixed(6)),
  };
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomically(filePath, data, options = undefined) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, data, options);
    await rename(temporaryPath, filePath);
  } catch (error) {
    try { await unlink(temporaryPath); } catch {}
    throw error;
  }
}

async function readPendingTask(pendingPath) {
  let pending;
  try {
    pending = JSON.parse(await readFile(pendingPath, "utf8"));
  } catch (error) {
    throw new ImageGenerationError("INVALID_PENDING_TASK", `Cannot read pending task record: ${error?.message || error}`, {
      pending_path: pendingPath,
    });
  }
  if (!pending || typeof pending !== "object" || Array.isArray(pending) || typeof pending.task_id !== "string" || !pending.task_id.trim()) {
    throw new ImageGenerationError("INVALID_PENDING_TASK", "pending.json does not contain a valid task_id.", {
      pending_path: pendingPath,
    });
  }
  return pending;
}

function sameResolvedPath(left, right) {
  if (typeof left !== "string" || !left.trim()) return false;
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function toPublicConfig(config) {
  const endpoint = new URL(config.endpoint);
  const asyncPollBase = new URL(config.asyncPollBase);
  return {
    provider_contract: "openai-compatible-images",
    gateway_race: Boolean(config.gatewayRace),
    auth_mode: config.authMode,
    api_operation: config.apiOperation,
    endpoint_origin: endpoint.origin,
    endpoint_path: endpoint.pathname,
    model: config.model,
    timeout_ms: config.timeoutMs,
    max_retries: config.maxRetries,
    safe_operation_retries: config.maxRetries,
    async_poll_origin: asyncPollBase.origin,
    async_poll_interval_ms: config.asyncPollIntervalMs,
    async_timeout_ms: config.asyncTimeoutMs,
    async_submit: config.asyncSubmit,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  await loadRuntimeEnvFiles();

  const requestPath = path.resolve(args.request);
  let rawRequest;
  let requestText;
  try {
    requestText = await readFile(requestPath, "utf8");
    rawRequest = JSON.parse(requestText.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new ImageGenerationError("INVALID_REQUEST_FILE", `Cannot read request JSON: ${error?.message || error}`);
  }
  const requestSha256 = createHash("sha256").update(requestText).digest("hex");
  const [sourcePrompt, sourceRequest, sourceBrief, referenceImages] = await Promise.all([
    loadBoundText(rawRequest.source_prompt, requestPath, "source_prompt", "SOURCE_PROMPT"),
    loadBoundText(rawRequest.source_request, requestPath, "source_request", "SOURCE_REQUEST", 24_000),
    loadBoundText(rawRequest.source_brief, requestPath, "source_brief", "SOURCE_BRIEF"),
    loadBoundReferenceImages(rawRequest.reference_images, path.dirname(requestPath)),
  ]);
  const request = normalizeRequest(rawRequest, { sourcePrompt, sourceRequest, sourceBrief, referenceImages });
  const prompt = buildPrompt(request);
  if (args.inspectRequest) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      request_path: requestPath,
      request_sha256: requestSha256,
      request,
      prompt,
    }, null, 2)}\n`);
    return;
  }
  let config = resolveConfig(request);
  const payload = {
    model: config.model,
    prompt,
    n: 1,
    ...(config.apiOperation === "edits" && request.size === "auto" ? {} : { size: request.size }),
    quality: request.quality,
    output_format: request.output_format,
  };
  if (referenceImages.length) {
    payload.images = referenceImages.map((reference) => ({
      image_url: referenceImageDataUrl(reference),
    }));
  }
  if (config.asyncSubmit) payload.async = true;

  if (args.dryRun) {
    const inspectablePayload = referenceImages.length
      ? {
        ...payload,
        images: referenceImages.map((reference) => ({
          image_url: `data:${reference.media_type};base64,<omitted:${reference.bytes}-bytes:${reference.sha256}>`,
        })),
      }
      : payload;
    process.stdout.write(`${JSON.stringify({ ok: true, request, payload: inspectablePayload, config: toPublicConfig(config) }, null, 2)}\n`);
    return;
  }
  if (!config.authToken && config.authMode.startsWith("catsco-")) {
    throw new ImageGenerationError(
      "MISSING_CATSCO_IDENTITY",
      "Connect a CatsCo bot or log in as a CatsCo user before using the configured CatsCo image service.",
    );
  }
  if (!config.authToken) {
    throw new ImageGenerationError(
      "MISSING_API_KEY",
      "Set IMAGE_GEN_API_KEY or OPENAI_API_KEY in the runtime environment or XiaoBa runtime .env file.",
    );
  }

  const startedAt = new Date();
  const startedMs = Date.now();
  const outputDir = path.resolve(args.outDir);
  await mkdir(outputDir, { recursive: true });
  const resultPath = path.join(outputDir, "result.json");
  const pendingPath = path.join(outputDir, "pending.json");
  const possibleImagePaths = ["png", "jpg", "webp"].map((extension) => (
    path.join(outputDir, `${request.filename}.${extension}`)
  ));
  if (await fileExists(resultPath) || (await Promise.all(possibleImagePaths.map(fileExists))).some(Boolean)) {
    throw new ImageGenerationError("OUTPUT_EXISTS", "Output already exists. Use a fresh run directory.");
  }
  const requestedTaskId = optionalString(args.taskId, "--task-id", 500) || null;
  const pendingExists = await fileExists(pendingPath);
  const existingPending = pendingExists ? await readPendingTask(pendingPath) : null;
  if (existingPending && !requestedTaskId) {
    throw new ImageGenerationError("PENDING_TASK_EXISTS", "A pending task already exists in this run directory. Resume that task with --task-id instead of submitting again.", {
      task_id: existingPending.task_id,
      pending_path: pendingPath,
    });
  }
  if (!existingPending && requestedTaskId) {
    throw new ImageGenerationError("PENDING_TASK_NOT_FOUND", "Cannot resume a task without the matching pending.json record.", {
      task_id: requestedTaskId,
      pending_path: pendingPath,
    });
  }
  if (existingPending && requestedTaskId !== existingPending.task_id) {
    throw new ImageGenerationError("ASYNC_TASK_ID_MISMATCH", "The requested task ID does not match pending.json.", {
      requested_task_id: requestedTaskId,
      pending_task_id: existingPending.task_id,
      pending_path: pendingPath,
    });
  }
  if (existingPending && (
    !sameResolvedPath(existingPending.request_path, requestPath)
    || !sameResolvedPath(existingPending.output_dir, outputDir)
  )) {
    throw new ImageGenerationError("PENDING_TASK_CONTEXT_MISMATCH", "pending.json belongs to a different request or output directory.", {
      pending_path: pendingPath,
    });
  }
  if (existingPending && existingPending.request_sha256 !== requestSha256) {
    throw new ImageGenerationError("PENDING_TASK_REQUEST_MISMATCH", "request.json changed after the asynchronous task was submitted.", {
      pending_path: pendingPath,
      expected_request_sha256: existingPending.request_sha256 || null,
      actual_request_sha256: requestSha256,
    });
  }
  if (existingPending && existingPending.model !== config.model) {
    throw new ImageGenerationError("PENDING_TASK_PROVIDER_MISMATCH", "The configured image model changed after the asynchronous task was submitted.", {
      pending_model: existingPending.model || null,
      configured_model: config.model,
    });
  }
  if (existingPending?.auth_mode && existingPending.auth_mode !== config.authMode) {
    if (config.authFallback?.mode !== existingPending.auth_mode) {
      throw new ImageGenerationError("PENDING_TASK_PROVIDER_MISMATCH", "The CatsCo identity mode changed after the asynchronous task was submitted.", {
        pending_auth_mode: existingPending.auth_mode,
        configured_auth_mode: config.authMode,
      });
    }
    config = {
      ...config,
      authMode: config.authFallback.mode,
      authScheme: config.authFallback.scheme,
      authToken: config.authFallback.token,
    };
  }

  let body;
  let initialBody = null;
  let attempts = 0;
  let taskId = requestedTaskId;
  let initialTaskStatus = taskId ? "resumed" : null;
  let pollResult = null;
  let identityFallbackUsed = Boolean(existingPending?.identity_fallback_used);
  if (!taskId) {
    const generatedResponse = await generateViaApi(payload, config);
    config = {
      ...config,
      authMode: generatedResponse.credential.mode,
      authScheme: generatedResponse.credential.scheme,
      authToken: generatedResponse.credential.token,
    };
    identityFallbackUsed = generatedResponse.identityFallbackUsed;
    body = generatedResponse.body;
    initialBody = generatedResponse.body;
    attempts = generatedResponse.attempts;
    const asyncTask = asyncTaskFromBody(body);
    if (asyncTask) {
      taskId = asyncTask.taskId;
      initialTaskStatus = asyncTask.status;
    }
  }
  if (taskId) {
    const taskEndpoint = resolveAsyncTaskEndpoint(config, taskId);
    if (existingPending && existingPending.task_endpoint !== taskEndpoint) {
      throw new ImageGenerationError("PENDING_TASK_PROVIDER_MISMATCH", "The asynchronous task endpoint changed after the task was submitted.", {
        pending_task_endpoint: existingPending.task_endpoint || null,
        configured_task_endpoint: taskEndpoint,
      });
    }
    const pending = {
      schema_version: "1.0",
      status: "pending",
      task_id: taskId,
      task_endpoint: taskEndpoint,
      request_path: requestPath,
      request_sha256: requestSha256,
      output_dir: outputDir,
      model: config.model,
      auth_mode: config.authMode,
      identity_fallback_used: identityFallbackUsed,
      initial_status: initialTaskStatus,
      created_at: existingPending?.created_at || new Date().toISOString(),
      ...(existingPending ? { resumed_at: new Date().toISOString() } : {}),
      resume_args: {
        script_path: path.resolve(process.argv[1]),
        request_path: requestPath,
        output_dir: outputDir,
        task_id: taskId,
      },
    };
    await writeFileAtomically(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
    pollResult = await pollAsyncTask(taskId, config);
    body = pollResult.body;
  }

  const generated = await imageFromApiResult(body, config);
  if (generated.buffer.length > config.maxImageBytes) {
    throw new ImageGenerationError("IMAGE_TOO_LARGE", `Generated image exceeds ${config.maxImageBytes} bytes.`);
  }
  const imageType = detectImage(generated.buffer);
  const dimensions = checkDimensions(imageType, request.size);
  const imagePath = path.join(outputDir, `${request.filename}.${imageType.extension}`);

  await writeFileAtomically(imagePath, generated.buffer);
  const completedAt = new Date();
  const result = {
    schema_version: "1.0",
    ok: true,
    status: "generated",
    request_path: requestPath,
    request,
    prompt,
    provider: {
      ...toPublicConfig(config),
      attempts,
      identity_fallback_used: identityFallbackUsed,
      request_id: initialBody?.id || initialBody?.request_id || body?.id || body?.request_id || null,
      revised_prompt: typeof generated.revisedPrompt === "string" ? generated.revisedPrompt : null,
      ...(taskId ? {
        async_task: {
          task_id: taskId,
          resumed: Boolean(args.taskId),
          initial_status: initialTaskStatus,
          final_status: pollResult?.finalStatus || "completed",
          poll_count: pollResult?.polls || 0,
        },
      } : {}),
    },
    output: {
      image_path: imagePath,
      filename: path.basename(imagePath),
      media_type: imageType.mediaType,
      bytes: generated.buffer.length,
      sha256: createHash("sha256").update(generated.buffer).digest("hex"),
      dimensions,
    },
    warnings: dimensions.exact_size_match === false
      ? [`Provider returned ${dimensions.width}x${dimensions.height} instead of requested ${request.size}; aspect ratio is preserved.`]
      : [],
    review: {
      status: "not_run",
      note: "Use the agent's existing image-reading capability to compare this image with request.json.",
    },
    timing: {
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: Date.now() - startedMs,
    },
  };
  await writeFileAtomically(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (await fileExists(pendingPath)) {
    try { await unlink(pendingPath); } catch {}
  }
  process.stdout.write(`${JSON.stringify({ ok: true, image_path: imagePath, result_path: resultPath }, null, 2)}\n`);
}

main().catch((error) => {
  const policy = image2FailurePolicy(error);
  const payload = {
    ok: false,
    error: {
      code: error?.code || "UNEXPECTED_ERROR",
      message: error?.message || String(error),
      ...(error?.details ? { details: error.details } : {}),
    },
    ...policy,
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
