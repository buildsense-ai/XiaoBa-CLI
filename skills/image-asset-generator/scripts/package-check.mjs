#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(scriptsDir);

function runNode(args, label, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: skillDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${label} failed with exit ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function main() {
  const jsonFiles = [
    "schemas/request.schema.json",
    "schemas/review.schema.json",
  ];
  for (const relativePath of jsonFiles) {
    JSON.parse(await readFile(path.join(skillDir, relativePath), "utf8"));
  }
  const skillText = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
  const frontmatterMatch = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = frontmatterMatch?.[1] || "";
  if (!/^name:\s*image-asset-generator\s*$/m.test(frontmatter) || !/^description:\s*.+$/m.test(frontmatter)) {
    throw new Error("SKILL.md frontmatter is missing the expected name and description.");
  }
  if (/\bTODO\b|placeholder/i.test(skillText)) throw new Error("SKILL.md contains unfinished template text.");
  for (const toolName of ["send_text", "read_file", "send_file"]) {
    if (!skillText.includes(`\`${toolName}\``)) {
      throw new Error(`SKILL.md is missing the ${toolName} host handoff instruction.`);
    }
  }
  for (const scriptName of ["prepare-reference.mjs", "prepare-request.mjs", "run-image.mjs", "record-review.mjs", "deliver-asset.mjs"]) {
    if (!skillText.includes(`node \"<SKILL_DIR>/scripts/${scriptName}\"`)) {
      throw new Error(`SKILL.md must quote the ${scriptName} absolute script path.`);
    }
  }

  const scripts = [
    "reference-image-utils.mjs",
    "prepare-reference.mjs",
    "prepare-request.mjs",
    "generate-image.mjs",
    "generate-dreamina-image.mjs",
    "run-image.mjs",
    "lib/dreamina-cli.mjs",
    "lib/failure-policy.mjs",
    "lib/run-state.mjs",
    "record-review.mjs",
    "deliver-asset.mjs",
    "smoke-test.mjs",
    "reference-smoke-test.mjs",
    "provider-fallback-smoke-test.mjs",
    "fixtures/fake-dreamina-image.mjs",
    "package-check.mjs",
  ];
  for (const script of scripts) {
    await runNode(["--check", path.join(scriptsDir, script)], `syntax check: ${script}`);
  }
  const smoke = await runNode([path.join(scriptsDir, "smoke-test.mjs")], "offline smoke test", 60_000);
  const smokeResult = JSON.parse(smoke.stdout);
  const referenceSmoke = await runNode(
    [path.join(scriptsDir, "reference-smoke-test.mjs")],
    "reference-image smoke test",
    60_000,
  );
  const referenceSmokeResult = JSON.parse(referenceSmoke.stdout);
  const providerFallbackSmoke = await runNode(
    [path.join(scriptsDir, "provider-fallback-smoke-test.mjs")],
    "provider fallback smoke test",
    120_000,
  );
  const providerFallbackSmokeResult = JSON.parse(providerFallbackSmoke.stdout);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    skill: "image-asset-generator",
    json_files: jsonFiles,
    scripts,
    smoke_checks: smokeResult.checks,
    reference_smoke_checks: referenceSmokeResult.checks,
    provider_fallback_smoke_checks: providerFallbackSmokeResult.checks,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2)}\n`);
  process.exitCode = 1;
});
