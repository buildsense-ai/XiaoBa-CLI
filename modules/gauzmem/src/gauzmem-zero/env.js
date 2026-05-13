"use strict";

const fs = require("fs");
const path = require("path");

let loaded = false;

function loadGauzMemEnv() {
  if (loaded) return;
  loaded = true;
  const envFile = findEnvFile();
  if (!envFile) return;
  const text = fs.readFileSync(envFile, "utf8");
  loadEnvText(text);
}

function findEnvFile() {
  if (process.env.GAUZMEM_ENV_FILE) return process.env.GAUZMEM_ENV_FILE;
  for (const candidate of [path.resolve(".gauzmem-zero.env"), path.resolve(".env")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function loadEnvText(text) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(match[2].trim());
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

module.exports = {
  loadGauzMemEnv,
};
