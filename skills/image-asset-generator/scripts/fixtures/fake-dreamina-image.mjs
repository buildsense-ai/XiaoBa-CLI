#!/usr/bin/env node

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const statePath = process.env.FAKE_DREAMINA_STATE;
if (!statePath) throw new Error("FAKE_DREAMINA_STATE is required.");
const scenario = process.env.FAKE_DREAMINA_SCENARIO || "success";
const command = process.argv[2] || "";
const args = process.argv.slice(3);

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { calls: [], credit_count: 0, submit_count: 0, query_count: 0 };
    throw error;
  }
}

async function saveState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function option(name) {
  const prefix = `--${name}=`;
  return args.find((item) => item.startsWith(prefix))?.slice(prefix.length) || null;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function solidPng(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(width * 4, 0);
  for (let offset = 0; offset < row.length; offset += 4) {
    row[offset] = 40;
    row[offset + 1] = 130;
    row[offset + 2] = 220;
    row[offset + 3] = 255;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), row])));
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const state = await readState();
state.calls.push({ command, args, at: new Date().toISOString() });

if (command === "user_credit") {
  state.credit_count += 1;
  await saveState(state);
  if (scenario === "auth_required" || scenario === "empty_auth") {
    if (scenario === "auth_required") process.stderr.write("未检测到有效登录态，请先执行 dreamina login\n");
    process.exitCode = 1;
  } else if (scenario === "credit_unavailable" || (scenario === "credit_transient_once" && state.credit_count === 1)) {
    process.stderr.write("network error while checking credits\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ vip_level: "test", total_credit: 1000 })}\n`);
  }
} else if (command === "text2image" || command === "image2image") {
  state.submit_count += 1;
  state.last_submit_command = command;
  state.last_submit_args = args;
  await saveState(state);
  if (scenario === "submission_unknown") {
    process.stderr.write("connection reset during submit\n");
    process.exitCode = 1;
  } else if (scenario === "compliance_required") {
    process.stderr.write("AigcComplianceConfirmationRequired\n");
    process.exitCode = 1;
  } else if (scenario === "generation_failed" || scenario === "initial_fail_then_success") {
    process.stdout.write(`${JSON.stringify({ submit_id: "fake-image-submit-1", gen_status: "fail", fail_reason: "provider rejected prompt" })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ submit_id: "fake-image-submit-1", gen_status: "querying" })}\n`);
  }
} else if (command === "query_result") {
  state.query_count += 1;
  state.last_submit_id = option("submit_id");
  await saveState(state);
  if (scenario === "always_pending") {
    process.stdout.write(`${JSON.stringify({ submit_id: state.last_submit_id, gen_status: "querying" })}\n`);
  } else if (scenario === "query_hang") {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
    process.stdout.write(`${JSON.stringify({ submit_id: state.last_submit_id, gen_status: "querying" })}\n`);
  } else if (scenario === "query_auth_required") {
    process.stderr.write("Authentication required. Please run dreamina login.\n");
    process.exitCode = 1;
  } else if (scenario === "query_failed" || (scenario === "query_transient_once" && state.query_count === 1)) {
    process.stderr.write("network error while querying\n");
    process.exitCode = 1;
  } else {
    const downloadDir = option("download_dir");
    if (!downloadDir) throw new Error("--download_dir is required by the fake CLI.");
    await mkdir(downloadDir, { recursive: true });
    const outputPath = path.join(downloadDir, "dreamina-output.png");
    if (scenario === "corrupt_download") {
      await writeFile(outputPath, "not-an-image", "utf8");
    } else if (scenario !== "download_missing" && !(scenario === "download_missing_once" && state.query_count === 1)) {
      const image = solidPng(96, 64);
      await writeFile(outputPath, image);
      state.output_sha256 = createHash("sha256").update(image).digest("hex");
    }
    await saveState(state);
    process.stdout.write(`${JSON.stringify({
      submit_id: state.last_submit_id,
      gen_status: "success",
      output_path: outputPath,
    })}\n`);
  }
} else {
  await saveState(state);
  process.stderr.write(`unsupported fake command: ${command}\n`);
  process.exitCode = 2;
}
