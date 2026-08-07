import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "..");
const managePath = path.join(
  root,
  "ops",
  "ctyun-worker-image",
  "Manage-WorkerImages.ps1",
);

test("worker image lifecycle: list, latest, and prune keeps N (default 6)", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "catsco-img-mgmt-"));
  try {
    const statePath = path.join(sandbox, "state.json");
    const logPath = path.join(sandbox, "calls.log");
    const bin = path.join(sandbox, "bin");
    fs.mkdirSync(bin);

    const images = [
      // 8 worker images, newest first by createdTime
      { imageID: "img-08", imageName: "catsco-worker-1-4-8-x", imageStatus: "active", createdTime: 800000008, labels: [{ labelKey: "bake", labelValue: "b8" }, { labelKey: "version", labelValue: "1.4.8" }, { labelKey: "commit", labelValue: "c8" }] },
      { imageID: "img-07", imageName: "catsco-worker-1-4-8-y", imageStatus: "active", createdTime: 800000007, labels: [{ labelKey: "bake", labelValue: "b7" }, { labelKey: "version", labelValue: "1.4.8" }, { labelKey: "commit", labelValue: "c7" }] },
      { imageID: "img-06", imageName: "catsco-worker-1-4-7-a", imageStatus: "active", createdTime: 800000006, labels: [{ labelKey: "bake", labelValue: "b6" }, { labelKey: "version", labelValue: "1.4.7" }, { labelKey: "commit", labelValue: "c6" }] },
      { imageID: "img-05", imageName: "catsco-worker-1-4-7-b", imageStatus: "active", createdTime: 800000005, labels: [{ labelKey: "bake", labelValue: "b5" }, { labelKey: "version", labelValue: "1.4.7" }, { labelKey: "commit", labelValue: "c5" }] },
      { imageID: "img-04", imageName: "catsco-worker-1-4-6-a", imageStatus: "active", createdTime: 800000004, labels: [{ labelKey: "bake", labelValue: "b4" }, { labelKey: "version", labelValue: "1.4.6" }, { labelKey: "commit", labelValue: "c4" }] },
      { imageID: "img-03", imageName: "catsco-worker-1-4-6-b", imageStatus: "active", createdTime: 800000003, labels: [{ labelKey: "bake", labelValue: "b3" }, { labelKey: "version", labelValue: "1.4.6" }, { labelKey: "commit", labelValue: "c3" }] },
      { imageID: "img-02", imageName: "catsco-worker-1-4-5-a", imageStatus: "active", createdTime: 800000002, labels: [{ labelKey: "bake", labelValue: "b2" }, { labelKey: "version", labelValue: "1.4.5" }, { labelKey: "commit", labelValue: "c2" }] },
      { imageID: "img-01", imageName: "catsco-worker-1-4-5-b", imageStatus: "active", createdTime: 800000001, labels: [{ labelKey: "bake", labelValue: "b1" }, { labelKey: "version", labelValue: "1.4.5" }, { labelKey: "commit", labelValue: "c1" }] },
      // unrelated private image with bake label -> must never be pruned
      { imageID: "img-other", imageName: "catsco-unrelated-base", imageStatus: "active", createdTime: 900000000, labels: [{ labelKey: "bake", labelValue: "bx" }] },
      // worker-prefixed but NO bake label -> not part of this bake channel
      { imageID: "img-nobake", imageName: "catsco-worker-manual", imageStatus: "active", createdTime: 950000000, labels: [] },
    ];

    const writeState = (overrides: Record<string, unknown> = {}) => {
      fs.writeFileSync(
        statePath,
        JSON.stringify({ images, ...overrides }),
      );
    };
    writeState();

    const writeCommand = (name: string, body: string) => {
      const p = path.join(bin, name);
      fs.writeFileSync(p, `#!/usr/bin/env node\n${body.trim()}\n`);
      fs.chmodSync(p, 0o755);
      fs.writeFileSync(`${p}.cmd`, `@echo off\r\nnode "%~dp0${name}" %*\r\n`);
    };

    writeCommand("ctyun-cli", `
import fs from "node:fs";
const statePath = process.env.FAKE_IMG_STATE;
const logPath = process.env.FAKE_IMG_LOG;
const args = process.argv.slice(2);
const operation = args.slice(0, 2).join(" ");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const value = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
};
fs.appendFileSync(logPath, operation + "\\n");
let returnObj = {};
if (operation === "ims ListImage") {
  const requestedName = value("--imageName");
  returnObj = {
    images: state.images
      .filter(img => !requestedName || img.imageName === requestedName)
      .map(img => JSON.parse(JSON.stringify(img))),
    totalPage: 1,
  };
} else if (operation === "ims DeleteImage") {
  const id = value("--imageID");
  if (state.deleteFailures && state.deleteFailures.includes(id)) {
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(JSON.stringify({
      statusCode: 900,
      message: "ERROR",
      description: "fake delete error",
      errorCode: "ims.DeleteImage.Failed",
      returnObj: {},
    }));
    process.exit(0);
  }
  state.images = state.images.filter(img => img.imageID !== id);
} else {
  process.stderr.write("unexpected fake operation: " + operation + "\\n");
  process.exit(2);
}
fs.writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify({
  statusCode: 800,
  message: "SUCCESS",
  description: "success",
  returnObj,
}));
`);

    writeCommand("timeout", `
import { spawnSync } from "node:child_process";
import path from "node:path";
const args = process.argv.slice(2);
const durationIndex = args.findIndex(arg => !arg.startsWith("-"));
if (durationIndex < 0 || !args[durationIndex + 1]) process.exit(2);
const command = args[durationIndex + 1];
const commandPath = path.join(path.dirname(process.argv[1]), command);
const result = spawnSync(
  process.execPath,
  [commandPath, ...args.slice(durationIndex + 2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
`);

    const runScript = (action: string, extra: string[] = []) =>
      spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          managePath,
          "-RegionID",
          "region-test",
          ...(action ? ["-Action", action] : []),
          ...extra,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
            FAKE_IMG_STATE: statePath,
            FAKE_IMG_LOG: logPath,
          },
        },
      );

    // --- List: only catsco-worker-* with bake label, newest first ---
    fs.rmSync(logPath, { force: true });
    const listResult = runScript("List");
    assert.equal(
      listResult.status,
      0,
      `${listResult.stdout}\n${listResult.stderr}`,
    );
    const listed = JSON.parse(listResult.stdout);
    assert.equal(listed.length, 8);
    assert.equal(listed[0].imageID, "img-08");
    assert.equal(listed[7].imageID, "img-01");
    assert.equal(listed[0].version, "1.4.8");
    assert.equal(listed[0].commit, "c8");
    assert.ok(!listed.some((i: any) => i.imageID === "img-other"));
    assert.ok(!listed.some((i: any) => i.imageID === "img-nobake"));

    // --- Latest: newest worker image id ---
    const latestResult = runScript("Latest");
    assert.equal(
      latestResult.status,
      0,
      `${latestResult.stdout}\n${latestResult.stderr}`,
    );
    assert.equal(latestResult.stdout.trim(), "img-08");

    // --- Prune 6: deletes the 2 oldest, keeps 6 ---
    writeState();
    fs.rmSync(logPath, { force: true });
    const pruneResult = runScript("Prune", ["-Keep", "6"]);
    assert.equal(
      pruneResult.status,
      0,
      `${pruneResult.stdout}\n${pruneResult.stderr}`,
    );
    const calls = fs.readFileSync(logPath, "utf8");
    assert.match(calls, /ims DeleteImage/);
    const prunedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const remaining = prunedState.images.filter((i: any) =>
      i.imageName.startsWith("catsco-worker-") &&
      i.labels.some((l: any) => l.labelKey === "bake"),
    );
    assert.equal(remaining.length, 6);
    assert.ok(!remaining.some((i: any) => i.imageID === "img-01"));
    assert.ok(!remaining.some((i: any) => i.imageID === "img-02"));
    // unrelated and no-bake images untouched
    assert.ok(prunedState.images.some((i: any) => i.imageID === "img-other"));
    assert.ok(prunedState.images.some((i: any) => i.imageID === "img-nobake"));

    // --- Prune 6 with only 5 -> nothing to delete ---
    writeState({
      images: images.slice(0, 5),
    });
    fs.rmSync(logPath, { force: true });
    const noOpResult = runScript("Prune", ["-Keep", "6"]);
    assert.equal(
      noOpResult.status,
      0,
      `${noOpResult.stdout}\n${noOpResult.stderr}`,
    );
    const noOpCalls = fs.readFileSync(logPath, "utf8");
    assert.doesNotMatch(noOpCalls, /ims DeleteImage/);

    // --- Prune with a delete failure -> fail closed, keeps others ---
    writeState({ deleteFailures: ["img-01"] });
    fs.rmSync(logPath, { force: true });
    const failResult = runScript("Prune", ["-Keep", "6"]);
    assert.notEqual(failResult.status, 0);
    assert.match(failResult.stderr, /Worker image cleanup failed/);
    const failCalls = fs.readFileSync(logPath, "utf8");
    assert.ok(
      (failCalls.match(/ims DeleteImage/g) || []).length >= 2,
      `expected the other delete to proceed\n${failCalls}`,
    );
    const failState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(failState.images.some((i: any) => i.imageID === "img-01"));
    assert.ok(!failState.images.some((i: any) => i.imageID === "img-02"));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
