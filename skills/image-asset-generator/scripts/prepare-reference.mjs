#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { access, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import {
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_SOURCE_BYTES,
  ReferenceImageError,
  createReferenceDescriptor,
  loadBoundReferenceImages,
  prepareReferenceImage,
  publicReferenceDescriptor,
  sanitizeSourceUrl,
} from "./reference-image-utils.mjs";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

class ReferencePreparationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ReferencePreparationError";
    this.code = code;
    this.details = details;
  }
}

function usage() {
  return [
    "Usage:",
    "  node prepare-reference.mjs --input <local-image-or-https-url> --out-dir <run-dir> --use-for <instruction> [--source-url <page-url>]",
    "",
    `The command copies normal PNG/JPEG/WebP inputs, derives a compact WebP for oversized inputs, and appends one hash-bound entry to references.json (maximum ${MAX_REFERENCE_IMAGES}).`,
    "--use-for states what the model should take from this reference, for example: character identity and facial features only.",
    "A remote input must resolve directly to image bytes; an HTML page or text description is rejected.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  const options = new Map([
    ["--input", "input"],
    ["--out-dir", "outDir"],
    ["--use-for", "useFor"],
    ["--source-url", "sourceUrl"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    const property = options.get(token);
    if (!property) throw new ReferencePreparationError("INVALID_ARGUMENT", `Unknown argument: ${token}`);
    const value = argv[++index];
    if (value === undefined || value === "") {
      throw new ReferencePreparationError("INVALID_ARGUMENT", `${token} requires a value.`);
    }
    if (args[property] !== undefined) {
      throw new ReferencePreparationError("INVALID_ARGUMENT", `${token} may be provided only once.`);
    }
    args[property] = value;
  }
  if (args.help) return args;
  if (!args.input) throw new ReferencePreparationError("INVALID_ARGUMENT", "--input is required.");
  if (!args.outDir) throw new ReferencePreparationError("INVALID_ARGUMENT", "--out-dir is required.");
  if (!args.useFor?.trim() || args.useFor.trim().length > 500) {
    throw new ReferencePreparationError("INVALID_ARGUMENT", "--use-for must contain 1-500 characters.");
  }
  return args;
}

function looksLikeHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function isBlockedIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function isBlockedIpv6(address) {
  const value = address.toLowerCase().split("%")[0];
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    return isIP(mapped) === 4 ? isBlockedIpv4(mapped) : true;
  }
  return value.startsWith("fc")
    || value.startsWith("fd")
    || /^fe[89ab]/.test(value)
    || value.startsWith("ff")
    || value.startsWith("2001:db8:");
}

function isBlockedAddress(address) {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

async function validateDownloadUrl(value, allowUnsafeLocal) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ReferencePreparationError("INVALID_REFERENCE_URL", "Remote reference input is not a valid URL.");
  }
  if (url.username || url.password) {
    throw new ReferencePreparationError("INVALID_REFERENCE_URL", "Remote reference URLs must not contain credentials.");
  }
  if (url.protocol !== "https:" && !(allowUnsafeLocal && url.protocol === "http:")) {
    throw new ReferencePreparationError(
      "INVALID_REFERENCE_URL",
      "Remote reference URLs must use HTTPS. HTTP is allowed only for an explicit trusted local test.",
    );
  }
  if (allowUnsafeLocal) return url;

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new ReferencePreparationError("UNSAFE_REFERENCE_URL", "Remote reference URLs cannot target a local host.");
  }
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new ReferencePreparationError(
      "REFERENCE_DOWNLOAD_FAILED",
      `Cannot resolve the remote reference host: ${error?.message || error}`,
    );
  }
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new ReferencePreparationError(
      "UNSAFE_REFERENCE_URL",
      "Remote reference URLs must resolve only to public Internet addresses.",
    );
  }
  return url;
}

async function readResponseLimited(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REFERENCE_SOURCE_BYTES) {
    throw new ReferencePreparationError(
      "REFERENCE_IMAGE_TOO_LARGE",
      `Remote reference exceeds the ${MAX_REFERENCE_SOURCE_BYTES}-byte acquisition limit.`,
    );
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_REFERENCE_SOURCE_BYTES) {
      throw new ReferencePreparationError(
        "REFERENCE_IMAGE_TOO_LARGE",
        `Remote reference exceeds the ${MAX_REFERENCE_SOURCE_BYTES}-byte acquisition limit.`,
      );
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > MAX_REFERENCE_SOURCE_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new ReferencePreparationError(
        "REFERENCE_IMAGE_TOO_LARGE",
        `Remote reference exceeds the ${MAX_REFERENCE_SOURCE_BYTES}-byte acquisition limit.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function downloadReference(value) {
  const allowUnsafeLocal = process.env.IMAGE_GEN_ALLOW_INSECURE_REFERENCE_HTTP === "true";
  let current = await validateDownloadUrl(value, allowUnsafeLocal);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "image/png,image/jpeg,image/webp,image/*;q=0.8,*/*;q=0.1",
          "User-Agent": "Mozilla/5.0 (compatible; CatsCoImageReference/1.0)",
        },
      });
    } catch (error) {
      const message = error?.name === "AbortError"
        ? `Remote reference download timed out after ${DOWNLOAD_TIMEOUT_MS} ms.`
        : `Remote reference download failed: ${error?.message || error}`;
      throw new ReferencePreparationError("REFERENCE_DOWNLOAD_FAILED", message);
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new ReferencePreparationError("REFERENCE_DOWNLOAD_FAILED", "Remote reference redirect omitted Location.");
      }
      if (redirects === MAX_REDIRECTS) {
        throw new ReferencePreparationError("REFERENCE_DOWNLOAD_FAILED", "Remote reference exceeded the redirect limit.");
      }
      current = await validateDownloadUrl(new URL(location, current).toString(), allowUnsafeLocal);
      continue;
    }
    if (!response.ok) {
      throw new ReferencePreparationError(
        "REFERENCE_DOWNLOAD_FAILED",
        `Remote reference returned HTTP ${response.status}. Download it through the browser and pass the local file instead.`,
        { status: response.status },
      );
    }
    return { buffer: await readResponseLimited(response), finalUrl: current.toString() };
  }
  throw new ReferencePreparationError("REFERENCE_DOWNLOAD_FAILED", "Remote reference could not be downloaded.");
}

async function readLocalReference(value) {
  const resolvedPath = path.resolve(value);
  try {
    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) throw new Error("path is not a regular file");
    if (fileStat.size > MAX_REFERENCE_SOURCE_BYTES) {
      throw new ReferencePreparationError(
        "REFERENCE_IMAGE_TOO_LARGE",
        `Local reference exceeds the ${MAX_REFERENCE_SOURCE_BYTES}-byte acquisition limit.`,
        { path: resolvedPath, bytes: fileStat.size, max_bytes: MAX_REFERENCE_SOURCE_BYTES },
      );
    }
    return { buffer: await readFile(resolvedPath), resolvedPath };
  } catch (error) {
    if (error instanceof ReferencePreparationError) throw error;
    throw new ReferencePreparationError(
      "REFERENCE_IMAGE_UNREADABLE",
      `Cannot read local reference image: ${error?.message || error}`,
      { path: resolvedPath },
    );
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

async function readManifest(manifestPath) {
  if (!(await fileExists(manifestPath))) {
    return { schema_version: "1.0", reference_images: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new ReferencePreparationError(
      "INVALID_REFERENCE_MANIFEST",
      `Cannot read references.json: ${error?.message || error}`,
      { manifest_path: manifestPath },
    );
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ReferencePreparationError("INVALID_REFERENCE_MANIFEST", "references.json must be a JSON object.");
  }
  const unknown = Object.keys(manifest).filter((key) => !["schema_version", "reference_images"].includes(key));
  if (unknown.length || manifest.schema_version !== "1.0" || !Array.isArray(manifest.reference_images)) {
    throw new ReferencePreparationError(
      "INVALID_REFERENCE_MANIFEST",
      "references.json must contain only schema_version=1.0 and reference_images.",
    );
  }
  if (manifest.reference_images.length) {
    const loaded = await loadBoundReferenceImages(
      manifest.reference_images,
      path.dirname(manifestPath),
      "references.json.reference_images",
    );
    manifest.reference_images = loaded.map((reference) => publicReferenceDescriptor(reference));
  }
  return manifest;
}

async function writeManifestAtomically(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
    await rm(manifestPath, { force: true });
    await rename(temporaryPath, manifestPath);
  } finally {
    try { await unlink(temporaryPath); } catch {}
  }
}

function sourceNameFromInput(input, remote, finalUrl) {
  if (!remote) return path.basename(path.resolve(input)).slice(0, 255) || "reference-image";
  const url = new URL(finalUrl || input);
  let name = path.posix.basename(url.pathname);
  try { name = decodeURIComponent(name); } catch {}
  return name.slice(0, 255) || "remote-reference-image";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const outDir = path.resolve(args.outDir);
  const referencesDir = path.join(outDir, "references");
  const manifestPath = path.join(outDir, "references.json");
  const lockPath = `${manifestPath}.lock`;
  await mkdir(referencesDir, { recursive: true });

  const remote = looksLikeHttpUrl(args.input);
  const acquired = remote ? await downloadReference(args.input) : await readLocalReference(args.input);
  const sourceUrl = args.sourceUrl
    ? sanitizeSourceUrl(args.sourceUrl, "--source-url")
    : (remote ? sanitizeSourceUrl(args.input, "remote reference URL") : undefined);
  const sourceName = sourceNameFromInput(args.input, remote, acquired.finalUrl);
  const prepared = await prepareReferenceImage(acquired.buffer, sourceName);

  let lock;
  let destinationPath;
  try {
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new ReferencePreparationError(
          "REFERENCE_MANIFEST_BUSY",
          "Another reference preparation is updating this run directory. Retry after it finishes.",
          { lock_path: lockPath },
        );
      }
      throw error;
    }

    const manifest = await readManifest(manifestPath);
    if (manifest.reference_images.length >= MAX_REFERENCE_IMAGES) {
      throw new ReferencePreparationError(
        "TOO_MANY_REFERENCE_IMAGES",
        `A run may contain at most ${MAX_REFERENCE_IMAGES} reference images.`,
      );
    }

    const preliminary = createReferenceDescriptor({
      relativePath: "pending",
      buffer: prepared.buffer,
      useFor: args.useFor,
      sourceUrl,
      sourceName,
    });
    const duplicateIndex = manifest.reference_images.findIndex((item) => item.sha256 === preliminary.sha256);
    if (duplicateIndex >= 0) {
      throw new ReferencePreparationError(
        "DUPLICATE_REFERENCE_IMAGE",
        `The same image is already reference ${duplicateIndex + 1}; do not attach duplicate pixels.`,
        { existing_path: manifest.reference_images[duplicateIndex].path },
      );
    }

    const index = manifest.reference_images.length + 1;
    const extension = preliminary.media_type === "image/png"
      ? "png"
      : (preliminary.media_type === "image/jpeg" ? "jpg" : "webp");
    destinationPath = path.join(referencesDir, `reference-${String(index).padStart(2, "0")}.${extension}`);
    await writeFile(destinationPath, prepared.buffer, { flag: "wx" });
    const relativePath = path.relative(outDir, destinationPath).split(path.sep).join("/");
    const descriptor = createReferenceDescriptor({
      relativePath,
      buffer: prepared.buffer,
      useFor: args.useFor,
      sourceUrl,
      sourceName,
    });
    manifest.reference_images.push(descriptor);
    await writeManifestAtomically(manifestPath, manifest);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      reference_index: index,
      reference_path: destinationPath,
      manifest_path: manifestPath,
      descriptor,
      compression: prepared.compression,
    }, null, 2)}\n`);
  } catch (error) {
    if (destinationPath) {
      try { await unlink(destinationPath); } catch {}
    }
    throw error;
  } finally {
    if (lock) {
      try { await lock.close(); } catch {}
      try { await unlink(lockPath); } catch {}
    }
  }
}

main().catch((error) => {
  const wrapped = error instanceof ReferenceImageError
    ? error
    : error;
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: {
      code: wrapped?.code || "UNEXPECTED_ERROR",
      message: wrapped?.message || String(wrapped),
      ...(wrapped?.details ? { details: wrapped.details } : {}),
    },
  }, null, 2)}\n`);
  process.exitCode = 1;
});
