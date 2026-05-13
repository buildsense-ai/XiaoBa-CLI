#!/usr/bin/env node
"use strict";

const {
  listen,
  registerAttachment,
  retrieve,
  withStoreWriteLock,
} = require("./gauzmem-zero");
const { loadGauzMemEnv } = require("./gauzmem-zero/env");

loadGauzMemEnv();

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      out._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    index += 1;
  }
  return out;
}

function usage() {
  process.stdout.write(`gauzmem

Commands:
  serve [--store ./.gauzmem-zero] [--host 127.0.0.1] [--port 8788]
  retrieve --query <text> --root <path> [--store ./.gauzmem-zero]
  source --path <file> --text <text> [--store ./.gauzmem-zero]

Environment:
  GauzMem loads .env by default, or GAUZMEM_ENV_FILE when set.
  Required for HTTP source paths: GAUZMEM_ALLOWED_ROOTS.
  Required for real LLM: GAUZMEM_LLM_API_KEY.
`);
}

function required(args, key) {
  const value = args[key];
  if (!value || value === true) throw new Error(`Missing required --${key}`);
  return value;
}

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }

  if (command === "serve") {
    const { url } = await listen({
      storeRoot: args.store && args.store !== true ? args.store : ".gauzmem-zero",
      host: args.host && args.host !== true ? args.host : "127.0.0.1",
      port: numberArg(args.port, 8788),
    });
    process.stdout.write(`GauzMem sidecar listening at ${url}\n`);
    return;
  }

  if (command === "retrieve") {
    const storeRoot = args.store && args.store !== true ? args.store : ".gauzmem-zero";
    const result = await withStoreWriteLock(storeRoot, () => retrieve({
      storeRoot,
      query: required(args, "query"),
      rootPaths: [required(args, "root")],
    }));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "source") {
    const storeRoot = args.store && args.store !== true ? args.store : ".gauzmem-zero";
    const result = await withStoreWriteLock(storeRoot, () => registerAttachment(storeRoot, {
      path: required(args, "path"),
      text: required(args, "text"),
    }));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
