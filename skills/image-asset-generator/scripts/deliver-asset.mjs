#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const EXTENSIONS_BY_MEDIA_TYPE = new Map([
  ["image/png", new Set([".png"])],
  ["image/jpeg", new Set([".jpg", ".jpeg"])],
  ["image/webp", new Set([".webp"])],
]);

class DeliveryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "DeliveryError";
    this.code = code;
    this.details = details;
  }
}

function usage() {
  return [
    "Usage:",
    "  node deliver-asset.mjs --result <result.json> --destination-dir <directory> [--overwrite]",
    "  node deliver-asset.mjs --result <result.json> --destination-file <file> [--overwrite]",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { overwrite: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--result") args.result = argv[++index];
    else if (token === "--destination-dir") args.destinationDir = argv[++index];
    else if (token === "--destination-file") args.destinationFile = argv[++index];
    else if (token === "--overwrite") args.overwrite = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new DeliveryError("INVALID_ARGUMENT", `Unknown argument: ${token}`);
  }
  if (args.help) return args;
  if (!args.result) throw new DeliveryError("INVALID_ARGUMENT", "--result is required.");
  if (Boolean(args.destinationDir) === Boolean(args.destinationFile)) {
    throw new DeliveryError("INVALID_ARGUMENT", "Provide exactly one of --destination-dir or --destination-file.");
  }
  return args;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new DeliveryError("INVALID_RESULT", `Cannot read result JSON: ${error?.message || error}`, {
      result_path: filePath,
    });
  }
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(filePath, code = "SOURCE_NOT_FOUND") {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw new DeliveryError(code, `Cannot read image file: ${error?.message || error}`, { path: filePath });
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveSource(result, resultPath) {
  if (!result || result.ok !== true || result.status !== "generated") {
    throw new DeliveryError("INVALID_RESULT", "Only a successful generated result can be delivered.");
  }
  const sourceValue = result?.output?.image_path;
  const expectedHash = result?.output?.sha256;
  const mediaType = result?.output?.media_type;
  if (typeof sourceValue !== "string" || typeof expectedHash !== "string" || typeof mediaType !== "string") {
    throw new DeliveryError("INVALID_RESULT", "result.output must contain image_path, media_type, and sha256.");
  }
  if (!EXTENSIONS_BY_MEDIA_TYPE.has(mediaType)) {
    throw new DeliveryError("UNSUPPORTED_MEDIA_TYPE", `Unsupported image media type: ${mediaType}`);
  }
  return {
    sourcePath: path.isAbsolute(sourceValue)
      ? path.resolve(sourceValue)
      : path.resolve(path.dirname(resultPath), sourceValue),
    expectedHash,
    mediaType,
  };
}

function resolveDestination(args, sourcePath, mediaType) {
  const destinationPath = args.destinationDir
    ? path.resolve(args.destinationDir, path.basename(sourcePath))
    : path.resolve(args.destinationFile);
  const extension = path.extname(destinationPath).toLowerCase();
  if (!EXTENSIONS_BY_MEDIA_TYPE.get(mediaType).has(extension)) {
    throw new DeliveryError(
      "DESTINATION_EXTENSION_MISMATCH",
      `Destination extension ${extension || "(missing)"} does not match ${mediaType}.`,
      { destination_path: destinationPath, media_type: mediaType },
    );
  }
  const samePath = process.platform === "win32"
    ? destinationPath.toLowerCase() === sourcePath.toLowerCase()
    : destinationPath === sourcePath;
  if (samePath) {
    throw new DeliveryError("DESTINATION_IS_SOURCE", "Destination must differ from the generated run artifact.");
  }
  return destinationPath;
}

async function copyVerified(sourcePath, destinationPath, expectedHash, overwrite) {
  const destinationExists = await fileExists(destinationPath);
  if (destinationExists) {
    const destinationStats = await stat(destinationPath);
    if (!destinationStats.isFile()) {
      throw new DeliveryError("DESTINATION_NOT_FILE", "Destination exists but is not a file.", {
        destination_path: destinationPath,
      });
    }
    const destinationHash = await sha256File(destinationPath, "DESTINATION_NOT_READABLE");
    if (destinationHash === expectedHash) return "already_present";
    if (!overwrite) {
      throw new DeliveryError(
        "DESTINATION_EXISTS",
        "Destination already contains a different file. Use a versioned filename or pass --overwrite only after explicit user approval.",
        { destination_path: destinationPath },
      );
    }
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await copyFile(
      sourcePath,
      destinationPath,
      destinationExists ? 0 : fsConstants.COPYFILE_EXCL,
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new DeliveryError("DESTINATION_EXISTS", "Destination appeared while copying; no file was overwritten.", {
        destination_path: destinationPath,
      });
    }
    throw new DeliveryError("DELIVERY_COPY_FAILED", `Cannot copy image: ${error?.message || error}`, {
      destination_path: destinationPath,
    });
  }

  const deliveredHash = await sha256File(destinationPath, "DELIVERY_VERIFY_FAILED");
  if (deliveredHash !== expectedHash) {
    throw new DeliveryError("DELIVERY_HASH_MISMATCH", "Delivered image does not match the generated source hash.", {
      destination_path: destinationPath,
      expected_sha256: expectedHash,
      actual_sha256: deliveredHash,
    });
  }
  return destinationExists ? "overwritten" : "copied";
}

async function writeResultAtomically(resultPath, result) {
  const temporaryPath = `${resultPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rename(temporaryPath, resultPath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const resultPath = path.resolve(args.result);
  const result = await readJson(resultPath);
  if (result.deliveries !== undefined && !Array.isArray(result.deliveries)) {
    throw new DeliveryError("INVALID_RESULT", "result.deliveries must be an array when present.");
  }
  const { sourcePath, expectedHash, mediaType } = resolveSource(result, resultPath);
  const sourceHash = await sha256File(sourcePath);
  if (sourceHash !== expectedHash) {
    throw new DeliveryError("SOURCE_HASH_MISMATCH", "Generated image changed after result.json was created.", {
      source_path: sourcePath,
      expected_sha256: expectedHash,
      actual_sha256: sourceHash,
    });
  }

  const destinationPath = resolveDestination(args, sourcePath, mediaType);
  const deliveryStatus = await copyVerified(sourcePath, destinationPath, expectedHash, args.overwrite);
  const deliveries = Array.isArray(result.deliveries) ? result.deliveries : [];
  const existingRecord = deliveries.find((item) => (
    item && path.resolve(String(item.path || "")) === destinationPath && item.sha256 === expectedHash
  ));
  if (!existingRecord) {
    deliveries.push({
      kind: "project_asset",
      status: deliveryStatus,
      path: destinationPath,
      filename: path.basename(destinationPath),
      media_type: mediaType,
      sha256: expectedHash,
      delivered_at: new Date().toISOString(),
    });
    result.deliveries = deliveries;
    await writeResultAtomically(resultPath, result);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: deliveryStatus,
    source_path: sourcePath,
    destination_path: destinationPath,
    sha256: expectedHash,
    result_path: resultPath,
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
