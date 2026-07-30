import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { describe, test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(__dirname, "..");

describe("Tianyi Cloud worker image pipeline", () => {
  const artifactBuilder = read("scripts/build-linux-worker-artifact.mjs");
  const imagePreparer = read("ops/ctyun-worker-image/prepare-image.sh");
  const imageOrchestratorPath = path.join(
    root,
    "ops/ctyun-worker-image/New-CatsCoWorkerImage.ps1",
  );
  const imageOrchestrator = fs.readFileSync(imageOrchestratorPath, "utf8");
  const workflow = read(".github/workflows/worker-image.yml");

  test("artifact is source-free and reproducible for one commit", () => {
    assert.match(artifactBuilder, /git\(sourceRoot, \[["']ls-files["']/);
    assert.match(artifactBuilder, /["']dist["']/);
    assert.doesNotMatch(
      artifactBuilder,
      /fs\.cpSync\(path\.join\(root, ["']\.git["']/,
    );
    assert.match(artifactBuilder, /--omit=dev/);
    assert.match(artifactBuilder, /--sort=name/);
    assert.match(artifactBuilder, /--mtime=@\$\{commitEpoch\}/);
    assert.match(artifactBuilder, /gzip["'], \[["']-n["']/);
    assert.match(artifactBuilder, /createdAt: new Date\(commitEpoch \* 1000\)/);
  });

  test("image keeps immutable application files separate from runtime data", () => {
    assert.match(imagePreparer, /RELEASE_ROOT="\/opt\/catsco\/releases\//);
    assert.match(imagePreparer, /XIAOBA_USER_DATA_DIR=\/srv\/catsco-agent/);
    assert.match(imagePreparer, /WorkingDirectory=\/srv\/catsco-agent/);
    assert.match(
      imagePreparer,
      /systemctl disable --now catsco-agent\.service/,
    );
    assert.match(imagePreparer, /nodejs/);
  });

  test("finalization removes worker identity and machine identity before imaging", () => {
    assert.match(imagePreparer, /\/srv\/catsco-agent\/\.env/);
    assert.match(imagePreparer, /\/srv\/catsco-agent\/\.xiaoba/);
    assert.match(imagePreparer, /\/etc\/ssh\/ssh_host_\*/);
    assert.match(imagePreparer, /truncate -s 0 \/etc\/machine-id/);
    assert.match(imagePreparer, /cloud-init clean --logs --seed/);
  });

  test("orchestrator only mutates the exact temporary builder for this bake", () => {
    assert.match(imageOrchestrator, /StartsWith\("catsco-img-"\)/);
    assert.match(imageOrchestrator, /instanceName -ne \$script:BuilderName/);
    assert.match(
      imageOrchestrator,
      /Refusing to operate on non-builder instance/,
    );
    assert.match(imageOrchestrator, /mutatesExistingWorkers = \$false/);
    assert.doesNotMatch(imageOrchestrator, /worker1|worker2|ck-work/);
  });

  test("ambiguous creates and failed images have strict compensating cleanup", () => {
    assert.match(
      imageOrchestrator,
      /"--resourceID", \$script:BuilderResourceID/,
    );
    assert.match(imageOrchestrator, /"--instanceName", \$script:BuilderName/);
    assert.match(imageOrchestrator, /Could not prove cleanup of builder/);
    assert.match(imageOrchestrator, /ImageCreateAttempted/);
    assert.match(imageOrchestrator, /Find-ImageByName/);
    assert.match(imageOrchestrator, /"ims", "DeleteImage"/);
    assert.match(
      imageOrchestrator,
      /Could not confirm deletion of incomplete image/,
    );
    assert.match(
      imageOrchestrator,
      /Could not confirm deletion of temporary builder/,
    );
    assert.doesNotMatch(
      imageOrchestrator,
      /Could not delete temporary builder/,
    );
  });

  test("remote transfer and image preparation cannot run indefinitely", () => {
    assert.match(imageOrchestrator, /ArtifactTransferTimeoutMinutes/);
    assert.match(imageOrchestrator, /RemoteBuildTimeoutMinutes/);
    assert.match(imageOrchestrator, /ServerAliveInterval=15/);
    assert.match(imageOrchestrator, /--kill-after=120s/);
  });

  test("workflow is restricted, secret-scoped, and never publishes the artifact", () => {
    assert.match(workflow, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
    assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
    assert.match(workflow, /default: false/);
    assert.match(
      workflow,
      /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/,
    );
    assert.match(workflow, /CTYUN_CLI_PACKAGE_SHA256/);
    assert.match(workflow, /sha256sum --check --strict/);
    assert.match(
      workflow,
      /ArtifactPath '\$\{\{ steps\.artifact_meta\.outputs\.path \}\}'/,
    );
    assert.match(workflow, /BuildNumber '\$\{\{ github\.run_number \}\}'/);
    assert.doesNotMatch(
      workflow,
      /TOS_|aws s3|presign|upload-artifact|public-read/,
    );
    assert.doesNotMatch(workflow, /^    env:\s*\n\s+CTYUN_AK:/m);
    assert.match(
      workflow,
      /- name: Bake private ECS image[\s\S]*?env:\s*\n\s+CTYUN_AK:/,
    );
  });

  test("PowerShell image orchestrator parses successfully", () => {
    const escapedPath = imageOrchestratorPath.replaceAll("'", "''");
    execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[scriptblock]::Create((Get-Content -Raw -LiteralPath '${escapedPath}')) | Out-Null`,
      ],
      { stdio: "pipe" },
    );
  });

  test("failed image bake deletes the image, builder, and key pair", () => {
    const sandbox = fs.mkdtempSync(
      path.join(os.tmpdir(), "catsco-worker-image-test-"),
    );
    try {
      const statePath = path.join(sandbox, "state.json");
      const logPath = path.join(sandbox, "calls.log");
      const artifactPath = path.join(sandbox, "worker.tar.gz");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: false,
          keyExists: false,
          imageExists: false,
          instanceName: "",
          instanceStatus: "running",
        }),
      );
      fs.writeFileSync(artifactPath, "source-free-worker-artifact");
      const artifactSha = crypto
        .createHash("sha256")
        .update(fs.readFileSync(artifactPath))
        .digest("hex");

      writeCommand(
        sandbox,
        "ctyun-cli",
        `
import fs from "node:fs";
const statePath = process.env.FAKE_CTYUN_STATE;
const logPath = process.env.FAKE_CTYUN_LOG;
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
  returnObj = {
    images: state.imageExists
      ? [{ imageID: "image-1", imageName: "catsco-worker-test-999" }]
      : [],
  };
} else if (operation === "ecs ImportEcsKeypair") {
  state.keyExists = true;
} else if (operation === "ecs GetEcsKeypairDetails") {
  returnObj = {
    results: state.keyExists
      ? [{ keyPairID: "key-1", keyPairName: "catsco-img-key-000999-01" }]
      : [],
  };
} else if (operation === "ecs CreateEcsInstance") {
  state.instanceExists = true;
  state.instanceName = value("--instanceName");
  returnObj = { masterResourceID: "resource-1" };
} else if (operation === "ecs ListEcsInstances") {
  const orderLookupStillPending = args.includes("--resourceID");
  returnObj = {
    results: state.instanceExists && !orderLookupStillPending
      ? [{
          instanceID: "instance-1",
          resourceID: "resource-1",
          instanceName: state.instanceName,
          instanceStatus: state.instanceStatus,
          floatingIP: "127.0.0.1",
        }]
      : [],
  };
} else if (operation === "ecs StopEcsInstance") {
  state.instanceStatus = "stopped";
} else if (operation === "ims CreateImage") {
  state.imageExists = true;
  returnObj = { images: [] };
} else if (operation === "ims GetImageDetail") {
  returnObj = {
    images: state.imageExists
      ? [{ imageID: "image-1", imageStatus: "error", taskProgress: "100" }]
      : [],
  };
} else if (operation === "ims DeleteImage") {
  state.imageExists = false;
} else if (operation === "ecs DeleteEcsInstance") {
  state.instanceExists = false;
} else if (operation === "ecs DeleteEcsKeypair") {
  state.keyExists = false;
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
`,
      );
      writeCommand(
        sandbox,
        "ssh-keygen",
        `
import fs from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("-f") + 1];
fs.writeFileSync(output, "private");
fs.writeFileSync(output + ".pub", "ssh-rsa AAAA catsco-test");
`,
      );
      for (const command of ["ssh", "scp", "timeout"]) {
        writeCommand(sandbox, command, "process.exit(0);");
      }

      const result = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          imageOrchestratorPath,
          "-Mode",
          "Create",
          "-SourceRef",
          "HEAD",
          "-ArtifactPath",
          artifactPath,
          "-ArtifactSha256",
          artifactSha,
          "-BuildNumber",
          "999",
          "-BuildAttempt",
          "1",
          "-ImageName",
          "catsco-worker-test-999",
          "-RegionID",
          "region-test",
          "-AzName",
          "az-test",
          "-BaseImageID",
          "base-image-test",
          "-FlavorID",
          "flavor-test",
          "-VpcID",
          "vpc-test",
          "-SubnetID",
          "subnet-test",
          "-SecurityGroupID",
          "security-group-test",
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            PATH: `${sandbox}${path.delimiter}${process.env.PATH || ""}`,
            FAKE_CTYUN_STATE: statePath,
            FAKE_CTYUN_LOG: logPath,
          },
        },
      );

      assert.notEqual(
        result.status,
        0,
        `expected the image error to fail the bake\n${result.stdout}\n${result.stderr}`,
      );
      const calls = fs.readFileSync(logPath, "utf8");
      assert.match(
        calls,
        /ims DeleteImage/,
        `${result.stdout}\n${result.stderr}`,
      );
      assert.match(calls, /ecs DeleteEcsInstance/);
      assert.match(calls, /ecs DeleteEcsKeypair/);
      assert.ok(
        calls.indexOf("ims DeleteImage") <
          calls.indexOf("ecs DeleteEcsInstance"),
      );
      assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), {
        instanceExists: false,
        keyExists: false,
        imageExists: false,
        instanceName: "catsco-img-000999-01",
        instanceStatus: "stopped",
      });
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function writeCommand(directory: string, name: string, body: string): void {
  const commandPath = path.join(directory, name);
  fs.writeFileSync(commandPath, `#!/usr/bin/env node\n${body.trim()}\n`);
  fs.chmodSync(commandPath, 0o755);
  fs.writeFileSync(
    `${commandPath}.cmd`,
    `@echo off\r\nnode "%~dp0${name}" %*\r\n`,
  );
}
