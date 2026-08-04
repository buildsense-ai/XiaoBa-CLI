import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_REFERENCE_IMAGES = 3;
export const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_REFERENCE_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_REFERENCE_SOURCE_BYTES = 25 * 1024 * 1024;
export const MIN_REFERENCE_EDGE = 64;
export const MAX_REFERENCE_EDGE = 8192;
export const MAX_REFERENCE_PIXELS = 40_000_000;
export const REFERENCE_COMPRESSION_THRESHOLD_BYTES = 3 * 1024 * 1024;
export const REFERENCE_TRANSPORT_MAX_EDGE = 1536;

const REFERENCE_WEBP_QUALITY = 85;

const ALLOWED_DESCRIPTOR_FIELDS = new Set([
  "path",
  "sha256",
  "media_type",
  "bytes",
  "width",
  "height",
  "use_for",
  "source_url",
  "source_name",
]);

export class ReferenceImageError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ReferenceImageError";
    this.code = code;
    this.details = details;
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReferenceImageError("INVALID_REFERENCE_IMAGE", `${label} must be a JSON object.`);
  }
}

function requiredString(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ReferenceImageError("INVALID_REFERENCE_IMAGE", `${label} must be a non-empty string.`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new ReferenceImageError("INVALID_REFERENCE_IMAGE", `${label} exceeds ${maxLength} characters.`);
  }
  return text;
}

function requiredInteger(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ReferenceImageError(
      "INVALID_REFERENCE_IMAGE",
      `${label} must be an integer from ${min} to ${max}.`,
    );
  }
  return value;
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

function inspectReferenceImageWithByteLimit(buffer, label, maxBytes) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new ReferenceImageError("INVALID_REFERENCE_IMAGE", `${label} is empty.`);
  }
  if (buffer.length > maxBytes) {
    throw new ReferenceImageError(
      "REFERENCE_IMAGE_TOO_LARGE",
      `${label} exceeds ${maxBytes} bytes.`,
      { bytes: buffer.length, max_bytes: maxBytes },
    );
  }

  let image;
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(pngSignature)) {
    if (buffer.toString("ascii", 12, 16) !== "IHDR") {
      throw new ReferenceImageError("INVALID_REFERENCE_IMAGE", `${label} has an invalid PNG header.`);
    }
    image = {
      extension: "png",
      mediaType: "image/png",
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  } else if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    const dimensions = jpegDimensions(buffer);
    if (!dimensions) {
      throw new ReferenceImageError("INVALID_REFERENCE_IMAGE", `${label} JPEG dimensions could not be read.`);
    }
    image = { extension: "jpg", mediaType: "image/jpeg", ...dimensions };
  } else if (
    buffer.length >= 30
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    const dimensions = webpDimensions(buffer);
    if (!dimensions) {
      throw new ReferenceImageError("INVALID_REFERENCE_IMAGE", `${label} WebP dimensions could not be read.`);
    }
    image = { extension: "webp", mediaType: "image/webp", ...dimensions };
  } else {
    throw new ReferenceImageError(
      "UNSUPPORTED_REFERENCE_IMAGE",
      `${label} must contain actual PNG, JPEG, or WebP bytes. HTML pages, GIF, SVG, and text descriptions are not accepted.`,
    );
  }

  const { width, height } = image;
  if (
    width < MIN_REFERENCE_EDGE
    || height < MIN_REFERENCE_EDGE
    || width > MAX_REFERENCE_EDGE
    || height > MAX_REFERENCE_EDGE
    || width * height > MAX_REFERENCE_PIXELS
  ) {
    throw new ReferenceImageError(
      "REFERENCE_IMAGE_DIMENSIONS_UNSUPPORTED",
      `${label} dimensions ${width}x${height} are outside the supported reference range.`,
      {
        width,
        height,
        min_edge: MIN_REFERENCE_EDGE,
        max_edge: MAX_REFERENCE_EDGE,
        max_pixels: MAX_REFERENCE_PIXELS,
      },
    );
  }
  return image;
}

export function inspectReferenceImage(buffer, label = "reference image") {
  return inspectReferenceImageWithByteLimit(buffer, label, MAX_REFERENCE_IMAGE_BYTES);
}

export function inspectReferenceSourceImage(buffer, label = "reference source image") {
  return inspectReferenceImageWithByteLimit(buffer, label, MAX_REFERENCE_SOURCE_BYTES);
}

function addModuleRoot(roots, value) {
  if (!value?.trim()) return;
  let resolved = path.resolve(value.trim());
  if (path.basename(resolved).toLowerCase() === "node_modules") resolved = path.dirname(resolved);
  roots.add(resolved);
}

function addAncestorModuleRoots(roots, value) {
  if (!value) return;
  let current = path.resolve(value);
  while (true) {
    roots.add(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function loadSharp() {
  const attempts = [];
  const requireHere = createRequire(import.meta.url);
  try {
    const loaded = requireHere("sharp");
    return loaded?.default || loaded;
  } catch (error) {
    attempts.push(error?.message || String(error));
  }

  const roots = new Set();
  addModuleRoot(roots, process.env.XIAOBA_NODE_MODULES);
  addModuleRoot(roots, process.env.XIAOBA_APP_ROOT);
  for (const entry of (process.env.NODE_PATH || "").split(path.delimiter)) addModuleRoot(roots, entry);
  addAncestorModuleRoots(roots, process.cwd());
  addAncestorModuleRoots(roots, path.dirname(process.execPath));

  for (const root of roots) {
    try {
      const requireFromRoot = createRequire(path.join(root, "package.json"));
      const loaded = requireFromRoot("sharp");
      return loaded?.default || loaded;
    } catch (error) {
      attempts.push(error?.message || String(error));
    }
  }

  throw new ReferenceImageError(
    "REFERENCE_COMPRESSION_UNAVAILABLE",
    "The reference is oversized, but XiaoBa's bundled image compressor could not be loaded.",
    { attempted_roots: [...roots], cause: attempts.at(-1) },
  );
}

export async function prepareReferenceImage(buffer, label = "reference source image") {
  const source = inspectReferenceSourceImage(buffer, label);
  const reasons = [];
  if (buffer.length > REFERENCE_COMPRESSION_THRESHOLD_BYTES) reasons.push("bytes");
  if (Math.max(source.width, source.height) > REFERENCE_TRANSPORT_MAX_EDGE) reasons.push("dimensions");
  if (!reasons.length) {
    return {
      buffer,
      image: source,
      compression: {
        applied: false,
        source_bytes: buffer.length,
        source_width: source.width,
        source_height: source.height,
      },
    };
  }

  const sharp = loadSharp();
  let prepared;
  try {
    prepared = await sharp(buffer, {
      failOn: "error",
      limitInputPixels: MAX_REFERENCE_PIXELS,
    })
      .rotate()
      .resize({
        width: REFERENCE_TRANSPORT_MAX_EDGE,
        height: REFERENCE_TRANSPORT_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: REFERENCE_WEBP_QUALITY, effort: 4, smartSubsample: true })
      .toBuffer();
  } catch (error) {
    throw new ReferenceImageError(
      "REFERENCE_COMPRESSION_FAILED",
      `Could not prepare oversized ${label}: ${error?.message || error}`,
      { source_bytes: buffer.length, source_width: source.width, source_height: source.height },
    );
  }

  const image = inspectReferenceImage(prepared, `compressed ${label}`);
  return {
    buffer: prepared,
    image,
    compression: {
      applied: true,
      reasons,
      format: "webp",
      quality: REFERENCE_WEBP_QUALITY,
      max_edge: REFERENCE_TRANSPORT_MAX_EDGE,
      source_bytes: buffer.length,
      source_width: source.width,
      source_height: source.height,
      output_bytes: prepared.length,
      output_width: image.width,
      output_height: image.height,
    },
  };
}

export function sanitizeSourceUrl(value, label = "source URL") {
  const text = requiredString(value, label, 4_000);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ReferenceImageError("INVALID_REFERENCE_IMAGE", `${label} must be a valid HTTP or HTTPS URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ReferenceImageError("INVALID_REFERENCE_IMAGE", `${label} must use HTTP or HTTPS.`);
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  return url.toString();
}

export function createReferenceDescriptor({ relativePath, buffer, useFor, sourceUrl, sourceName }) {
  const image = inspectReferenceImage(buffer);
  const descriptor = {
    path: requiredString(relativePath, "reference path", 1_000).replaceAll("\\", "/"),
    sha256: createHash("sha256").update(buffer).digest("hex"),
    media_type: image.mediaType,
    bytes: buffer.length,
    width: image.width,
    height: image.height,
    use_for: requiredString(useFor, "--use-for", 500),
    ...(sourceUrl ? { source_url: sanitizeSourceUrl(sourceUrl) } : {}),
    ...(sourceName ? { source_name: requiredString(sourceName, "source name", 255) } : {}),
  };
  return descriptor;
}

export function normalizeReferenceDescriptor(raw, label) {
  requireObject(raw, label);
  const unknown = Object.keys(raw).filter((key) => !ALLOWED_DESCRIPTOR_FIELDS.has(key));
  if (unknown.length) {
    throw new ReferenceImageError(
      "INVALID_REFERENCE_IMAGE",
      `Unknown ${label} field(s): ${unknown.join(", ")}`,
    );
  }
  const sha256 = requiredString(raw.sha256, `${label}.sha256`, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new ReferenceImageError("INVALID_REFERENCE_IMAGE", `${label}.sha256 must be a SHA-256 digest.`);
  }
  const mediaType = requiredString(raw.media_type, `${label}.media_type`, 100).toLowerCase();
  if (!["image/png", "image/jpeg", "image/webp"].includes(mediaType)) {
    throw new ReferenceImageError("INVALID_REFERENCE_IMAGE", `${label}.media_type is unsupported.`);
  }
  return {
    path: requiredString(raw.path, `${label}.path`, 1_000),
    sha256,
    media_type: mediaType,
    bytes: requiredInteger(raw.bytes, `${label}.bytes`, 1, MAX_REFERENCE_IMAGE_BYTES),
    width: requiredInteger(raw.width, `${label}.width`, MIN_REFERENCE_EDGE, MAX_REFERENCE_EDGE),
    height: requiredInteger(raw.height, `${label}.height`, MIN_REFERENCE_EDGE, MAX_REFERENCE_EDGE),
    use_for: requiredString(raw.use_for, `${label}.use_for`, 500),
    ...(raw.source_url ? { source_url: sanitizeSourceUrl(raw.source_url, `${label}.source_url`) } : {}),
    ...(raw.source_name ? { source_name: requiredString(raw.source_name, `${label}.source_name`, 255) } : {}),
  };
}

export async function loadBoundReferenceImages(rawList, baseDir, label = "reference_images") {
  if (rawList === undefined || rawList === null) return [];
  if (!Array.isArray(rawList) || rawList.length < 1 || rawList.length > MAX_REFERENCE_IMAGES) {
    throw new ReferenceImageError(
      "INVALID_REFERENCE_IMAGE",
      `${label} must contain 1-${MAX_REFERENCE_IMAGES} items.`,
    );
  }

  const loaded = [];
  let totalBytes = 0;
  for (let index = 0; index < rawList.length; index += 1) {
    const itemLabel = `${label}[${index}]`;
    const descriptor = normalizeReferenceDescriptor(rawList[index], itemLabel);
    const resolvedPath = path.isAbsolute(descriptor.path)
      ? path.resolve(descriptor.path)
      : path.resolve(baseDir, descriptor.path);
    let fileStat;
    let buffer;
    try {
      fileStat = await stat(resolvedPath);
      if (!fileStat.isFile()) throw new Error("path is not a regular file");
      if (fileStat.size > MAX_REFERENCE_IMAGE_BYTES) {
        throw new ReferenceImageError(
          "REFERENCE_IMAGE_TOO_LARGE",
          `${itemLabel} exceeds ${MAX_REFERENCE_IMAGE_BYTES} bytes. Compress or resize it before use.`,
          { path: resolvedPath, bytes: fileStat.size, max_bytes: MAX_REFERENCE_IMAGE_BYTES },
        );
      }
      buffer = await readFile(resolvedPath);
    } catch (error) {
      if (error instanceof ReferenceImageError) throw error;
      throw new ReferenceImageError(
        "REFERENCE_IMAGE_UNREADABLE",
        `Cannot read ${itemLabel}: ${error?.message || error}`,
        { path: resolvedPath },
      );
    }

    const image = inspectReferenceImage(buffer, itemLabel);
    const actualSha256 = createHash("sha256").update(buffer).digest("hex");
    if (actualSha256 !== descriptor.sha256) {
      throw new ReferenceImageError(
        "REFERENCE_IMAGE_HASH_MISMATCH",
        `${itemLabel} changed after it was prepared. Start a fresh request or restore the original file.`,
        { path: resolvedPath, expected_sha256: descriptor.sha256, actual_sha256: actualSha256 },
      );
    }
    const actual = {
      media_type: image.mediaType,
      bytes: buffer.length,
      width: image.width,
      height: image.height,
    };
    const mismatched = Object.entries(actual).filter(([key, value]) => descriptor[key] !== value);
    if (mismatched.length) {
      throw new ReferenceImageError(
        "REFERENCE_IMAGE_METADATA_MISMATCH",
        `${itemLabel} metadata does not match its prepared descriptor.`,
        {
          path: resolvedPath,
          mismatched_fields: mismatched.map(([key]) => key),
          expected: Object.fromEntries(mismatched.map(([key]) => [key, descriptor[key]])),
          actual: Object.fromEntries(mismatched),
        },
      );
    }
    totalBytes += buffer.length;
    if (totalBytes > MAX_REFERENCE_TOTAL_BYTES) {
      throw new ReferenceImageError(
        "REFERENCE_IMAGES_TOO_LARGE",
        `Reference images exceed ${MAX_REFERENCE_TOTAL_BYTES} bytes in total. Compress or remove a reference.`,
        { total_bytes: totalBytes, max_total_bytes: MAX_REFERENCE_TOTAL_BYTES },
      );
    }
    loaded.push({ ...descriptor, resolvedPath, buffer });
  }
  return loaded;
}

export function publicReferenceDescriptor(reference, pathValue = reference.path) {
  return {
    path: pathValue.replaceAll("\\", "/"),
    sha256: reference.sha256,
    media_type: reference.media_type,
    bytes: reference.bytes,
    width: reference.width,
    height: reference.height,
    use_for: reference.use_for,
    ...(reference.source_url ? { source_url: reference.source_url } : {}),
    ...(reference.source_name ? { source_name: reference.source_name } : {}),
  };
}

export function referenceImageDataUrl(reference) {
  return `data:${reference.media_type};base64,${reference.buffer.toString("base64")}`;
}
