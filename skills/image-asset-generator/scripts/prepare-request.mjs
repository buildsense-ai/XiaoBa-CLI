#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadBoundReferenceImages, publicReferenceDescriptor } from "./reference-image-utils.mjs";

class RequestPreparationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "RequestPreparationError";
    this.code = code;
    this.details = details;
  }
}

function usage() {
  return [
    "Usage:",
    "  node prepare-request.mjs --prompt <prompt.txt> --raw-request <raw-request.txt> --request <request.json> [options]",
    "  node prepare-request.mjs --brief <brief.txt> --request <request.json> [options]  # legacy",
    "",
    "Options copied into the request only when supplied:",
    "  --aspect-ratio <W:H|landscape|portrait|square>",
    "  --size <WIDTHxHEIGHT|auto>",
    "  --creative-freedom <strict|balanced|open>  Optional",
    "  --filename <file-stem>",
    "  --quality <low|medium|high|auto>",
    "  --output-format <png|jpeg|jpg|webp>",
    "  --model <model-name>",
    "  --references <references.json>  Optional manifest created by prepare-reference.mjs",
    "",
    "The request file must not already exist. This script hash-binds files without rewriting them.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  const valueOptions = new Map([
    ["--prompt", "prompt"],
    ["--raw-request", "rawRequest"],
    ["--brief", "brief"],
    ["--request", "request"],
    ["--aspect-ratio", "aspectRatio"],
    ["--size", "size"],
    ["--creative-freedom", "creativeFreedom"],
    ["--filename", "filename"],
    ["--quality", "quality"],
    ["--output-format", "outputFormat"],
    ["--model", "model"],
    ["--references", "references"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    const property = valueOptions.get(token);
    if (!property) throw new RequestPreparationError("INVALID_ARGUMENT", `Unknown argument: ${token}`);
    const value = argv[++index];
    if (value === undefined || value === "") {
      throw new RequestPreparationError("INVALID_ARGUMENT", `${token} requires a value.`);
    }
    if (args[property] !== undefined) {
      throw new RequestPreparationError("INVALID_ARGUMENT", `${token} may be provided only once.`);
    }
    args[property] = value;
  }
  if (args.help) return args;
  if (!args.prompt && !args.brief) {
    throw new RequestPreparationError("INVALID_ARGUMENT", "--prompt is required. Use --brief only for legacy requests.");
  }
  if (args.prompt && args.brief) {
    throw new RequestPreparationError("INVALID_ARGUMENT", "Use --prompt or legacy --brief, not both.");
  }
  if (args.prompt && !args.rawRequest) {
    throw new RequestPreparationError("INVALID_ARGUMENT", "--raw-request is required with --prompt so user intent remains traceable.");
  }
  if (!args.request) throw new RequestPreparationError("INVALID_ARGUMENT", "--request is required.");
  return args;
}

function validateOptions(args) {
  if (args.aspectRatio && !/^(?:landscape|portrait|square|[0-9]{1,4}:[0-9]{1,4})$/.test(args.aspectRatio)) {
    throw new RequestPreparationError("INVALID_ARGUMENT", "--aspect-ratio must be W:H, landscape, portrait, or square.");
  }
  if (args.size && args.size !== "auto" && !/^[0-9]{3,4}x[0-9]{3,4}$/.test(args.size)) {
    throw new RequestPreparationError("INVALID_ARGUMENT", "--size must be auto or look like 1024x1024.");
  }
  if (args.creativeFreedom && !["strict", "balanced", "open"].includes(args.creativeFreedom)) {
    throw new RequestPreparationError("INVALID_ARGUMENT", "--creative-freedom must be strict, balanced, or open.");
  }
  if (args.quality && !["low", "medium", "high", "auto"].includes(args.quality)) {
    throw new RequestPreparationError("INVALID_ARGUMENT", "--quality must be low, medium, high, or auto.");
  }
  if (args.outputFormat && !["png", "jpeg", "jpg", "webp"].includes(args.outputFormat.toLowerCase())) {
    throw new RequestPreparationError("INVALID_ARGUMENT", "--output-format must be png, jpeg, jpg, or webp.");
  }
  for (const [value, label, maxLength] of [
    [args.filename, "--filename", 120],
    [args.model, "--model", 200],
  ]) {
    if (value !== undefined && (!value.trim() || value.length > maxLength)) {
      throw new RequestPreparationError("INVALID_ARGUMENT", `${label} must contain 1-${maxLength} characters.`);
    }
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeNewFileAtomically(filePath, data) {
  if (await fileExists(filePath)) {
    throw new RequestPreparationError("REQUEST_EXISTS", "Request file already exists. Use a fresh run directory.", {
      request_path: filePath,
    });
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, data, { encoding: "utf8", flag: "wx" });
    try {
      await link(temporaryPath, filePath);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new RequestPreparationError("REQUEST_EXISTS", "Request file appeared while it was being prepared.", {
          request_path: filePath,
        });
      }
      throw error;
    }
  } finally {
    try { await unlink(temporaryPath); } catch {}
  }
}

function relativeSourcePath(sourcePath, requestPath) {
  const relative = path.relative(path.dirname(requestPath), sourcePath);
  if (!relative) {
    throw new RequestPreparationError("INVALID_ARGUMENT", "A bound source and request.json must be different files.");
  }
  return relative.split(path.sep).join("/");
}

async function readBoundFile(filePath, label, maxLength) {
  const resolvedPath = path.resolve(filePath);
  let text;
  try {
    text = (await readFile(resolvedPath, "utf8")).replace(/^\uFEFF/, "");
  } catch (error) {
    throw new RequestPreparationError(`${label.toUpperCase().replaceAll("-", "_")}_UNREADABLE`, `Cannot read ${label}: ${error?.message || error}`, {
      path: resolvedPath,
    });
  }
  if (!text.trim()) throw new RequestPreparationError(`INVALID_${label.toUpperCase().replaceAll("-", "_")}`, `The ${label} file is empty.`);
  if (text.length > maxLength) {
    throw new RequestPreparationError(`INVALID_${label.toUpperCase().replaceAll("-", "_")}`, `The ${label} file exceeds ${maxLength} characters.`);
  }
  return {
    path: resolvedPath,
    text,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

async function readReferenceManifest(filePath) {
  const resolvedPath = path.resolve(filePath);
  let manifest;
  try {
    manifest = JSON.parse((await readFile(resolvedPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new RequestPreparationError(
      "INVALID_REFERENCE_MANIFEST",
      `Cannot read references.json: ${error?.message || error}`,
      { manifest_path: resolvedPath },
    );
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new RequestPreparationError("INVALID_REFERENCE_MANIFEST", "references.json must be a JSON object.");
  }
  const unknown = Object.keys(manifest).filter((key) => !["schema_version", "reference_images"].includes(key));
  if (unknown.length || manifest.schema_version !== "1.0") {
    throw new RequestPreparationError(
      "INVALID_REFERENCE_MANIFEST",
      "references.json must contain only schema_version=1.0 and reference_images.",
    );
  }
  const references = await loadBoundReferenceImages(
    manifest.reference_images,
    path.dirname(resolvedPath),
    "references.json.reference_images",
  );
  return { path: resolvedPath, references };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  validateOptions(args);

  const requestPath = path.resolve(args.request);
  const promptSource = args.prompt
    ? await readBoundFile(args.prompt, "prompt", 12_000)
    : await readBoundFile(args.brief, "brief", 12_000);
  const rawRequestSource = args.rawRequest
    ? await readBoundFile(args.rawRequest, "raw-request", 24_000)
    : null;
  const referenceManifest = args.references
    ? await readReferenceManifest(args.references)
    : null;

  const request = {
    operation: "generate",
    ...(args.prompt ? {
      source_prompt: {
        path: relativeSourcePath(promptSource.path, requestPath),
        sha256: promptSource.sha256,
      },
      source_request: {
        path: relativeSourcePath(rawRequestSource.path, requestPath),
        sha256: rawRequestSource.sha256,
      },
    } : {
      source_brief: {
        path: relativeSourcePath(promptSource.path, requestPath),
        sha256: promptSource.sha256,
      },
    }),
    ...(args.creativeFreedom ? { creative_freedom: args.creativeFreedom } : {}),
    ...(args.aspectRatio ? { aspect_ratio: args.aspectRatio } : {}),
    ...(args.size ? { size: args.size } : {}),
    ...(args.filename ? { filename: args.filename } : {}),
    ...(args.quality ? { quality: args.quality } : {}),
    ...(args.outputFormat ? { output_format: args.outputFormat.toLowerCase() } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(referenceManifest ? {
      reference_images: referenceManifest.references.map((reference) => publicReferenceDescriptor(
        reference,
        relativeSourcePath(reference.resolvedPath, requestPath),
      )),
    } : {}),
    count: 1,
    background: "opaque",
  };
  await writeNewFileAtomically(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    prompt_path: promptSource.path,
    ...(rawRequestSource ? { raw_request_path: rawRequestSource.path } : {}),
    request_path: requestPath,
    prompt_sha256: promptSource.sha256,
    ...(rawRequestSource ? { raw_request_sha256: rawRequestSource.sha256 } : {}),
    ...(referenceManifest ? {
      references_manifest_path: referenceManifest.path,
      reference_count: referenceManifest.references.length,
      reference_sha256: referenceManifest.references.map((reference) => reference.sha256),
    } : {}),
    legacy_brief_mode: Boolean(args.brief),
  }, null, 2)}\n`);
}

main().catch((error) => {
  const payload = {
    ok: false,
    error: {
      code: error?.code || "UNEXPECTED_ERROR",
      message: error?.message || String(error),
      ...(error?.details ? { details: error.details } : {}),
    },
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
