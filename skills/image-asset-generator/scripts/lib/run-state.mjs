import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "EPERM"]);
const ATOMIC_RENAME_ATTEMPTS = 8;

export class RunStateError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "RunStateError";
    this.code = code;
    this.details = details;
  }
}

export async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(filePath, options = {}) {
  try {
    return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (options.optional && error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new RunStateError("INVALID_STATE", `Invalid JSON file: ${filePath}`);
    }
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let renamed = false;
  try {
    for (let attempt = 0; attempt < ATOMIC_RENAME_ATTEMPTS; attempt += 1) {
      try {
        await rename(temporary, filePath);
        renamed = true;
        return;
      } catch (error) {
        if (!TRANSIENT_RENAME_CODES.has(error?.code) || attempt === ATOMIC_RENAME_ATTEMPTS - 1) {
          throw error;
        }
        await unlink(filePath).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT" && !TRANSIENT_RENAME_CODES.has(unlinkError?.code)) {
            throw unlinkError;
          }
        });
        await sleep(Math.min(250, 20 * (2 ** attempt)));
      }
    }
  } finally {
    if (!renamed) await unlink(temporary).catch(() => {});
  }
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function acquireRunLock(outDir, options = {}) {
  await mkdir(outDir, { recursive: true });
  const lockPath = resolve(outDir, ".image-run.lock");
  const staleMs = options.staleMs || 60 * 60 * 1000;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        host: hostname(),
        acquired_at: new Date().toISOString(),
      })}\n`, "utf8");
      return {
        path: lockPath,
        async release() {
          await handle.close().catch(() => {});
          await unlink(lockPath).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      const lockRecord = await readJson(lockPath, { optional: true }).catch(() => null);
      const sameHost = lockRecord?.host === hostname();
      const live = sameHost && processIsAlive(Number(lockRecord?.pid));
      const stale = lockStat && Date.now() - lockStat.mtimeMs > staleMs;
      if (!live && (sameHost || stale)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      throw new RunStateError("RUN_LOCKED", "This image run is already being processed.");
    }
  }
  throw new RunStateError("RUN_LOCKED", "Could not acquire the image run lock.");
}

export function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}
