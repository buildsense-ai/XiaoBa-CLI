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
    assert.match(artifactBuilder, /does not match checked out HEAD/);
    assert.match(artifactBuilder, /dirty tracked tree/);
    assert.match(artifactBuilder, /lstatSync\(source\)/);
    assert.match(artifactBuilder, /Refusing tracked symbolic link/);
    assert.match(artifactBuilder, /assertSafeTree\(source, sourceRoot\)/);
    assert.match(artifactBuilder, /assertSafeTree\(path\.join\(root, "dist"\)/);
    assert.match(artifactBuilder, /run\("npm", \["run", "build"\]/);
    assert.match(workflow, /NODE_VERSION: ["']22\.23\.1["']/);
    assert.match(artifactBuilder, /stageNodeRuntime\(appRoot\)/);
    assert.match(artifactBuilder, /npm["'], \[["']root["'], ["']--global["']\]/);
  });

  test("image keeps immutable application files separate from runtime data", () => {
    assert.match(imagePreparer, /RELEASES_ROOT="\/opt\/catsco\/releases"/);
    assert.match(imagePreparer, /invalid version/);
    assert.match(imagePreparer, /release path escapes/);
    assert.match(imagePreparer, /jq -n/);
    assert.match(imagePreparer, /XIAOBA_USER_DATA_DIR=\/srv\/catsco-agent/);
    assert.match(imagePreparer, /WorkingDirectory=\/srv\/catsco-agent/);
    assert.match(
      imagePreparer,
      /systemctl disable --now catsco-agent\.service/,
    );
    assert.doesNotMatch(imagePreparer, /^\s+nodejs \\/m);
    assert.match(
      imagePreparer,
      /runtime\/node\/bin\/node .*dist\/index\.js catsco/,
    );
    assert.match(imagePreparer, /catsco-image-packages\.txt/);
    assert.match(
      imagePreparer,
      /catsco-agent ALL=\(ALL:ALL\) NOPASSWD: ALL/,
    );
    assert.match(imagePreparer, /chmod 0440 \/etc\/sudoers\.d\/catsco-agent/);
    assert.match(imagePreparer, /visudo -cf \/etc\/sudoers\.d\/catsco-agent/);
  });

  test("finalization removes worker identity and machine identity before imaging", () => {
    assert.match(imagePreparer, /\/srv\/catsco-agent\/\.env/);
    assert.match(imagePreparer, /\/srv\/catsco-agent\/\.xiaoba/);
    assert.match(imagePreparer, /\/etc\/ssh\/ssh_host_\*/);
    assert.match(imagePreparer, /truncate -s 0 \/etc\/machine-id/);
    assert.match(imagePreparer, /cloud-init clean --logs --seed/);
  });

  test("platform hardening encodes known Tianyi worker faults", () => {
    // fwupd masks prevent the systemd ABRT freeze on 8.16 hosts (mask_unit
    // creates and verifies the persistent /etc/systemd/system symlink)
    assert.match(imagePreparer, /mask_unit fwupd\.service/);
    assert.match(imagePreparer, /mask_unit fwupd-refresh\.service/);
    assert.match(imagePreparer, /mask_unit fwupd-refresh\.timer/);
    assert.match(imagePreparer, /systemctl reset-failed fwupd-refresh\.service/);
    // systemd + glibc upgrade to the known-safe 8.16/8.8 combo (_dl_fini freeze)
    assert.match(
      imagePreparer,
      /apt-get install --only-upgrade -y \\\n\s+systemd \\\n\s+systemd-sysv \\\n\s+systemd-timesyncd/,
    );
    assert.match(imagePreparer, /libsystemd0 \\/);
    assert.match(imagePreparer, /libc6 \\/);
    assert.match(imagePreparer, /dpkg --configure -a/);
    // corrupted dpkg file-list repair (assert the implementation, not the comment)
    assert.match(imagePreparer, /od -An -c/);
    assert.match(imagePreparer, /printf '\\n' >>/);
    // kernel upgrade + grub regeneration
    assert.match(imagePreparer, /linux-generic linux-image-generic/);
    assert.match(imagePreparer, /update-grub/);
    // china-region npm mirror pre-configuration for root and service user
    assert.match(imagePreparer, /registry\.npmmirror\.com/);
    assert.match(
      imagePreparer,
      /NPM_CONFIG_REGISTRY=https:\/\/registry\.npmmirror\.com/,
    );
    // observable platform versions in bake logs
    assert.match(imagePreparer, /platform_systemd=/);
    assert.match(imagePreparer, /platform_systemd=%s glibc=%s kernel=%s/);
    // fail-closed version assertions (review: required upgrades must block the bake)
    assert.match(imagePreparer, /dpkg --compare-versions/);
    assert.match(imagePreparer, /known-safe version/);
    // dpkg configuration must complete and packages must be 'ii' (review:
    // version gate masked configure failures)
    assert.match(imagePreparer, /db:Status-Abbrev/);
    assert.match(imagePreparer, /not fully configured/);
    assert.match(imagePreparer, /dpkg database not fully configured/);
    // fwupd masks are verified through their persistent /etc symlink and a
    // failed mask blocks the bake (review: swallowed mask failures)
    assert.match(imagePreparer, /readlink/);
    assert.match(imagePreparer, /failed to mask/);
    // kernel meta packages are INSTALLED (not --only-upgrade) so a base image
    // without them cannot silently skip to an old-kernel pass (review)
    assert.match(
      imagePreparer,
      /apt-get install -y --no-install-recommends \\\n\s+linux-generic linux-image-generic/,
    );
    assert.ok(
      imagePreparer.indexOf("od -An -c") < imagePreparer.indexOf("apt-get update"),
      "dpkg list repair must precede the first apt transaction",
    );
  });

  test("platform hardening fails closed and runs dpkg repair before apt", () => {
    const sandbox = fs.mkdtempSync(
      path.join(os.tmpdir(), "catsco-harden-probe-"),
    );
    try {
      const bin = path.join(sandbox, "bin");
      fs.mkdirSync(bin, { recursive: true });
      const mockLog = path.join(sandbox, "calls.log");
      // Prefer Git Bash over the WSL bash (C:\Windows\system32\bash.exe) that
      // would not understand Windows drive paths. All paths handed to bash are
      // converted to MSYS form (/c/...), and a wrapper exports a Unix-style
      // PATH so the mocked commands are found inside the script.
      const bashCandidates = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        process.env.LOCALAPPDATA
          ? path.join(
              process.env.LOCALAPPDATA,
              "Programs",
              "Git",
              "bin",
              "bash.exe",
            )
          : "",
      ].filter((p) => p && fs.existsSync(p));
      const bashExe = bashCandidates[0] || "bash";
      const toMsys = (p: string) =>
        p
          .replace(/\\/g, "/")
          .replace(/^([A-Za-z]):/, (_m: string, d: string) => `/${d.toLowerCase()}`);
      const preparer = path.join(
        root,
        "ops/ctyun-worker-image/prepare-image.sh",
      );
      const artifact = path.join(sandbox, "worker.tar.gz");
      fs.writeFileSync(artifact, "");
      const wrapper = path.join(sandbox, "run.sh");
      fs.writeFileSync(
        wrapper,
        [
          "#!/usr/bin/env bash",
          `export PATH="${toMsys(bin)}:$PATH"`,
          // exec bash explicitly: the repo's prepare-image.sh may not carry the
          // executable bit on a fresh Linux checkout, and CI runners enforce it.
          `exec bash "${toMsys(preparer)}" "$@"`,
          "",
        ].join("\n"),
        "utf8",
      );
      const sha = "a".repeat(64);

      const mocks: Record<string, string> = {
        sha256sum: [
          "#!/usr/bin/env bash",
          'echo "$CATSCO_MOCK_SHA  $1"',
        ].join("\n"),
        "apt-get": [
          "#!/usr/bin/env bash",
          'echo "apt-get:$*" >> "$CATSCO_MOCK_LOG"',
          'if [[ "$*" == *update* ]]; then exit "${CATSCO_MOCK_APT_UPDATE_RC:-0}"; fi',
          'if [[ "$*" == *linux-generic* ]]; then exit "${CATSCO_MOCK_KERNEL_UPGRADE_RC:-0}"; fi',
          'if [[ "$*" == *--only-upgrade* ]]; then exit "${CATSCO_MOCK_APT_ONLY_UPGRADE_RC:-0}"; fi',
          "exit 0",
        ].join("\n"),
        dpkg: [
          "#!/usr/bin/env bash",
          'echo "dpkg:$*" >> "$CATSCO_MOCK_LOG"',
          'if [[ "$*" == *"--compare-versions"* ]]; then',
          '  n=$(cat "$CATSCO_MOCK_COUNT" 2>/dev/null || echo 0)',
          '  echo $((n + 1)) > "$CATSCO_MOCK_COUNT"',
          '  if [[ $n -eq 0 ]]; then exit "${CATSCO_MOCK_VERSION_SYSTEMD_OK:-0}"; fi',
          '  exit "${CATSCO_MOCK_VERSION_GLIBC_OK:-0}"',
          'fi',
          'if [[ "$*" == *"--configure"* ]]; then',
          '  n=$(cat "$CATSCO_MOCK_CONFIG_COUNT" 2>/dev/null || echo 0)',
          '  echo $((n + 1)) > "$CATSCO_MOCK_CONFIG_COUNT"',
          '  if [[ $n -eq 0 ]]; then exit "${CATSCO_MOCK_DPKG_CONFIGURE_FIRST_RC:-0}"; fi',
          '  exit "${CATSCO_MOCK_DPKG_CONFIGURE_FINAL_RC:-0}"',
          'fi',
          "exit 0",
        ].join("\n"),
        "dpkg-query": [
          "#!/usr/bin/env bash",
          'echo "dpkg-query:$*" >> "$CATSCO_MOCK_LOG"',
          'if [[ "$*" == *Status* ]]; then',
          '  [[ "$*" == *systemd* ]] && echo "${CATSCO_MOCK_SYSTEMD_STATUS:-ii}"',
          '  [[ "$*" == *libc6* ]] && echo "${CATSCO_MOCK_GLIBC_STATUS:-ii}"',
          '  exit 0',
          'fi',
          '[[ "$*" == *systemd* ]] && echo "$CATSCO_MOCK_SYSTEMD_VER"',
          '[[ "$*" == *libc6* ]] && echo "$CATSCO_MOCK_GLIBC_VER"',
          "exit 0",
        ].join("\n"),
        ls: [
          "#!/usr/bin/env bash",
          'echo "ls:$*" >> "$CATSCO_MOCK_LOG"',
          'if [[ "${CATSCO_MOCK_LS_RC:-0}" != "0" ]]; then exit "${CATSCO_MOCK_LS_RC}"; fi',
          'echo "/boot/vmlinuz-6.8.0-136-generic"',
          "exit 0",
        ].join("\n"),
        systemctl: [
          "#!/usr/bin/env bash",
          'echo "systemctl:$*" >> "$CATSCO_MOCK_LOG"',
          "exit 0",
        ].join("\n"),
        uname: [
          "#!/usr/bin/env bash",
          'echo "uname:$*" >> "$CATSCO_MOCK_LOG"',
          'echo "6.8.0-136-generic"',
          "exit 0",
        ].join("\n"),
        readlink: [
          "#!/usr/bin/env bash",
          'echo "readlink:$*" >> "$CATSCO_MOCK_LOG"',
          // ${VAR-default} (no colon): only fall back when unset, so an empty
          // override simulates a missing mask symlink for the probe.
          'echo "${CATSCO_MOCK_READLINK_TARGET-/dev/null}"',
        ].join("\n"),
        "update-grub": [
          "#!/usr/bin/env bash",
          'echo "update-grub:$*" >> "$CATSCO_MOCK_LOG"',
          'exit "${CATSCO_MOCK_UPDATE_GRUB_RC:-0}"',
        ].join("\n"),
      };
      for (const [name, body] of Object.entries(mocks)) {
        const mockPath = path.join(bin, name);
        fs.writeFileSync(mockPath, body, "utf8");
        // CI runners (Linux) enforce the executable bit; Windows does not.
        fs.chmodSync(mockPath, 0o755);
      }

      const countPath = path.join(sandbox, "compare-count");
      const configCountPath = path.join(sandbox, "config-count");
      const runHardening = (extra: Record<string, string>) => {
        fs.rmSync(countPath, { force: true });
        fs.rmSync(configCountPath, { force: true });
        const result = spawnSync(
          bashExe,
          [
            toMsys(wrapper),
            "--artifact", toMsys(artifact),
            "--sha256", sha,
            "--version", "1.4.7",
            "--commit", "a".repeat(40),
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
              CATSCO_MOCK_LOG: mockLog,
              CATSCO_MOCK_SHA: sha,
              CATSCO_MOCK_COUNT: countPath,
              CATSCO_MOCK_CONFIG_COUNT: configCountPath,
              CATSCO_PREPARE_SKIP_ROOT_CHECK: "1",
              ...extra,
            },
          },
        );
        return result;
      };

      // Probe 1: every --only-upgrade attempt fails AND systemd stays old ->
      // the bake must fail closed naming systemd.
      fs.rmSync(mockLog, { force: true });
      const failResult = runHardening({
        CATSCO_MOCK_APT_ONLY_UPGRADE_RC: "42",
        CATSCO_MOCK_VERSION_SYSTEMD_OK: "1",
        CATSCO_MOCK_VERSION_GLIBC_OK: "0",
        CATSCO_MOCK_SYSTEMD_VER: "255.4-1ubuntu8.15",
        CATSCO_MOCK_GLIBC_VER: "2.39-0ubuntu8.8",
      });
      assert.notEqual(
        failResult.status,
        0,
        `${failResult.stdout}\n${failResult.stderr}`,
      );
      assert.match(
        failResult.stderr,
        /systemd upgrade failed to reach known-safe version/,
      );

      // Probe 2: apt succeeds but glibc still misses the floor -> fail closed
      // naming glibc (proves both assertions are enforced independently).
      fs.rmSync(mockLog, { force: true });
      const staleResult = runHardening({
        CATSCO_MOCK_APT_ONLY_UPGRADE_RC: "0",
        CATSCO_MOCK_VERSION_SYSTEMD_OK: "0",
        CATSCO_MOCK_VERSION_GLIBC_OK: "1",
        CATSCO_MOCK_SYSTEMD_VER: "255.4-1ubuntu8.16",
        CATSCO_MOCK_GLIBC_VER: "2.39-0ubuntu8.7",
      });
      assert.notEqual(
        staleResult.status,
        0,
        `${staleResult.stdout}\n${staleResult.stderr}`,
      );
      assert.match(
        staleResult.stderr,
        /glibc upgrade failed to reach known-safe version/,
      );

      // Probe 3: everything healthy -> version gates pass, no hardening error
      // (ls is mocked so the /boot check is satisfied), and the first dpkg
      // --configure runs before the first apt-get transaction.
      fs.rmSync(mockLog, { force: true });
      const orderResult = runHardening({
        CATSCO_MOCK_APT_ONLY_UPGRADE_RC: "0",
        CATSCO_MOCK_VERSION_SYSTEMD_OK: "0",
        CATSCO_MOCK_VERSION_GLIBC_OK: "0",
        CATSCO_MOCK_SYSTEMD_VER: "255.4-1ubuntu8.16",
        CATSCO_MOCK_GLIBC_VER: "2.39-0ubuntu8.8",
      });
      const orderCalls = fs.readFileSync(mockLog, "utf8");
      const firstConfigure = orderCalls.indexOf("dpkg:--configure");
      const firstAptUpdate = orderCalls.indexOf("apt-get:update");
      assert.ok(firstConfigure >= 0, orderCalls);
      assert.ok(firstAptUpdate >= 0, orderCalls);
      assert.ok(
        firstConfigure < firstAptUpdate,
        `dpkg repair must run before the first apt transaction\n${orderCalls}`,
      );
      assert.doesNotMatch(
        orderResult.stderr,
        /known-safe version|kernel upgrade failed|update-grub failed|no bootable kernel image/,
      );

      // Probe 4: kernel upgrade failure blocks the bake.
      fs.rmSync(mockLog, { force: true });
      const kernelResult = runHardening({
        CATSCO_MOCK_APT_ONLY_UPGRADE_RC: "0",
        CATSCO_MOCK_KERNEL_UPGRADE_RC: "1",
        CATSCO_MOCK_VERSION_SYSTEMD_OK: "0",
        CATSCO_MOCK_VERSION_GLIBC_OK: "0",
        CATSCO_MOCK_SYSTEMD_VER: "255.4-1ubuntu8.16",
        CATSCO_MOCK_GLIBC_VER: "2.39-0ubuntu8.8",
      });
      assert.notEqual(
        kernelResult.status,
        0,
        `${kernelResult.stdout}\n${kernelResult.stderr}`,
      );
      assert.match(kernelResult.stderr, /kernel upgrade failed/);

      // Probe 5: update-grub failure blocks the bake.
      fs.rmSync(mockLog, { force: true });
      const grubResult = runHardening({
        CATSCO_MOCK_APT_ONLY_UPGRADE_RC: "0",
        CATSCO_MOCK_UPDATE_GRUB_RC: "1",
        CATSCO_MOCK_VERSION_SYSTEMD_OK: "0",
        CATSCO_MOCK_VERSION_GLIBC_OK: "0",
        CATSCO_MOCK_SYSTEMD_VER: "255.4-1ubuntu8.16",
        CATSCO_MOCK_GLIBC_VER: "2.39-0ubuntu8.8",
      });
      assert.notEqual(
        grubResult.status,
        0,
        `${grubResult.stdout}\n${grubResult.stderr}`,
      );
      assert.match(grubResult.stderr, /update-grub failed/);

      // Probe 6: missing /boot kernel image blocks the bake.
      fs.rmSync(mockLog, { force: true });
      const bootResult = runHardening({
        CATSCO_MOCK_APT_ONLY_UPGRADE_RC: "0",
        CATSCO_MOCK_LS_RC: "2",
        CATSCO_MOCK_VERSION_SYSTEMD_OK: "0",
        CATSCO_MOCK_VERSION_GLIBC_OK: "0",
        CATSCO_MOCK_SYSTEMD_VER: "255.4-1ubuntu8.16",
        CATSCO_MOCK_GLIBC_VER: "2.39-0ubuntu8.8",
      });
      assert.notEqual(
        bootResult.status,
        0,
        `${bootResult.stdout}\n${bootResult.stderr}`,
      );
      assert.match(bootResult.stderr, /no bootable kernel image/);

      // Probe 7: a fwupd mask that did not take effect (persistent symlink
      // missing) blocks the bake even when versions are otherwise healthy.
      fs.rmSync(mockLog, { force: true });
      const maskResult = runHardening({
        CATSCO_MOCK_APT_ONLY_UPGRADE_RC: "0",
        CATSCO_MOCK_VERSION_SYSTEMD_OK: "0",
        CATSCO_MOCK_VERSION_GLIBC_OK: "0",
        CATSCO_MOCK_SYSTEMD_VER: "255.4-1ubuntu8.16",
        CATSCO_MOCK_GLIBC_VER: "2.39-0ubuntu8.8",
        CATSCO_MOCK_READLINK_TARGET: "",
      });
      assert.notEqual(
        maskResult.status,
        0,
        `${maskResult.stdout}\n${maskResult.stderr}`,
      );
      assert.match(maskResult.stderr, /failed to mask/);

      // Probe 8: the final dpkg configuration must complete even when the
      // versions are fine (a half-configured package still reports the new
      // version; review: version gate masked configure failures).
      fs.rmSync(mockLog, { force: true });
      const dpkgResult = runHardening({
        CATSCO_MOCK_APT_ONLY_UPGRADE_RC: "0",
        CATSCO_MOCK_DPKG_CONFIGURE_FINAL_RC: "43",
        CATSCO_MOCK_VERSION_SYSTEMD_OK: "0",
        CATSCO_MOCK_VERSION_GLIBC_OK: "0",
        CATSCO_MOCK_SYSTEMD_VER: "255.4-1ubuntu8.16",
        CATSCO_MOCK_GLIBC_VER: "2.39-0ubuntu8.8",
      });
      assert.notEqual(
        dpkgResult.status,
        0,
        `${dpkgResult.stdout}\n${dpkgResult.stderr}`,
      );
      assert.match(
        dpkgResult.stderr,
        /dpkg database not fully configured/,
      );

      // Probe 9: a half-configured package (status not 'ii') blocks the bake
      // even when the version gate would pass.
      fs.rmSync(mockLog, { force: true });
      const statusResult = runHardening({
        CATSCO_MOCK_APT_ONLY_UPGRADE_RC: "0",
        CATSCO_MOCK_VERSION_SYSTEMD_OK: "0",
        CATSCO_MOCK_VERSION_GLIBC_OK: "0",
        CATSCO_MOCK_SYSTEMD_VER: "255.4-1ubuntu8.16",
        CATSCO_MOCK_GLIBC_VER: "2.39-0ubuntu8.8",
        CATSCO_MOCK_SYSTEMD_STATUS: "iU",
      });
      assert.notEqual(
        statusResult.status,
        0,
        `${statusResult.stdout}\n${statusResult.stderr}`,
      );
      assert.match(statusResult.stderr, /not fully configured/);

      // Probe 10: real dpkg-query prints '${db:Status-Abbrev}' with a trailing
      // space for a healthy package (e.g. 'ii '). The whitespace-normalized
      // comparison must accept it, otherwise every healthy bake is rejected.
      fs.rmSync(mockLog, { force: true });
      const trailingSpaceResult = runHardening({
        CATSCO_MOCK_APT_ONLY_UPGRADE_RC: "0",
        CATSCO_MOCK_VERSION_SYSTEMD_OK: "0",
        CATSCO_MOCK_VERSION_GLIBC_OK: "0",
        CATSCO_MOCK_SYSTEMD_VER: "255.4-1ubuntu8.16",
        CATSCO_MOCK_GLIBC_VER: "2.39-0ubuntu8.8",
        CATSCO_MOCK_SYSTEMD_STATUS: "ii ",
        CATSCO_MOCK_GLIBC_STATUS: "ii ",
      });
      assert.doesNotMatch(
        trailingSpaceResult.stderr,
        /not fully configured/,
        `${trailingSpaceResult.stdout}\n${trailingSpaceResult.stderr}`,
      );
      // The status gate is passed (execution continues past it and prints the
      // platform line). The script then configures /root/.npmrc, which does
      // not exist in the non-root test sandbox, so the overall exit code is
      // not asserted here (the healthy-status probe is about the gate, not
      // about the sandbox's missing /root).
      assert.match(
        trailingSpaceResult.stdout,
        /platform_systemd=255\.4-1ubuntu8\.16/,
        `${trailingSpaceResult.stdout}\n${trailingSpaceResult.stderr}`,
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("orchestrator only mutates the exact temporary builder for this bake", () => {
    assert.match(imageOrchestrator, /StartsWith\("catsco-img-"\)/);
    assert.match(imageOrchestrator, /instanceName -ne \$script:BuilderName/);
    assert.match(
      imageOrchestrator,
      /Refusing to operate on non-builder instance/,
    );
    assert.match(imageOrchestrator, /mutatesExistingWorkers = \$false/);
    assert.match(imageOrchestrator, /no immutable builder identity was recorded/);
    assert.match(imageOrchestrator, /name and immutable ID do not uniquely match/);
    assert.match(
      imageOrchestrator,
      /Temporary cloud resource cleanup failed during reconciliation/,
    );
    assert.doesNotMatch(imageOrchestrator, /worker1|worker2|ck-work/);
  });

  test("ambiguous creates and failed images have strict compensating cleanup", () => {
    assert.match(
      imageOrchestrator,
      /"--resourceID", \$script:BuilderResourceID/,
    );
    assert.match(imageOrchestrator, /"--instanceName", \$script:BuilderName/);
    assert.match(
      imageOrchestrator,
      /No temporary builder record remains/,
    );
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

  test("private builder bootstrap is bounded and does not require inbound SSH", () => {
    assert.match(imageOrchestrator, /ApiTimeoutSeconds/);
    assert.match(imageOrchestrator, /ProgressIntervalSeconds/);
    assert.match(imageOrchestrator, /bake-progress/);
    assert.match(imageOrchestrator, /CATSCO_BASE_IMAGE_HARDENED/);
    assert.match(
      imageOrchestrator,
      /"timeout"[\s\S]*?"ctyun-cli"/,
    );
    assert.match(imageOrchestrator, /"--extIP", "0"/);
    assert.match(imageOrchestrator, /"--userData", \$userData/);
    assert.match(imageOrchestrator, /userData exceeds Tianyi Cloud's 16384-character limit/);
    assert.match(imageOrchestrator, /curl_common=[(]--fail --silent --show-error --location --ipv4/);
    assert.match(imageOrchestrator, /--connect-timeout 20 --max-time 900/);
    assert.match(imageOrchestrator, /--retry 8 --retry-all-errors/);
    assert.match(imageOrchestrator, /phase\(\) \{/);
    assert.match(imageOrchestrator, /phase download-prepare-script/);
    assert.match(imageOrchestrator, /phase shutdown/);
    assert.match(imageOrchestrator, /publish_status failed/);
    assert.match(imageOrchestrator, /heartbeat_age_s/);
    assert.match(imageOrchestrator, /Builder bootstrap failed/);
    assert.match(imageOrchestrator, /Builder bootstrap heartbeat is stale/);
    assert.match(imageOrchestrator, /Builder bootstrap status is unreachable or stale/);
    assert.match(imageOrchestrator, /-MonitorBootstrap/);
    assert.match(imageOrchestrator, /shutdown -h now/);
    assert.doesNotMatch(imageOrchestrator, /Wait-ForSsh|\bscp\b|"--extIP", "1"/);
    assert.match(imagePreparer, /platform_hardening=already-satisfied/);
    assert.match(imagePreparer, /image_phase platform-upgrade/);
    assert.match(imagePreparer, /image_phase kernel-upgrade/);
    assert.match(imagePreparer, /image_phase worker-validate/);
    assert.match(workflow, /CTYUN_WORKER_BASE_IMAGE_HARDENED/);
  });

  test("workflow is restricted and stages only a temporary private artifact", () => {
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
      /WORKER_ARTIFACT_PATH: \$\{\{ steps\.artifact_meta\.outputs\.path \}\}/,
    );
    assert.match(workflow, /-ArtifactPath \$env:WORKER_ARTIFACT_PATH/);
    assert.match(workflow, /-ArtifactUrl \$env:WORKER_ARTIFACT_URL/);
    assert.match(workflow, /-PrepareScriptUrl \$env:WORKER_PREPARE_SCRIPT_URL/);
    assert.match(workflow, /-PrepareScriptSha256 \$env:WORKER_PREPARE_SCRIPT_SHA256/);
    assert.match(workflow, /-BootstrapStatusGetUrl \$env:WORKER_BOOTSTRAP_STATUS_GET_URL/);
    assert.match(workflow, /-BootstrapStatusPutUrl \$env:WORKER_BOOTSTRAP_STATUS_PUT_URL/);
    assert.match(workflow, /-BuildNumber \$env:GITHUB_RUN_NUMBER/);
    assert.match(workflow, /-BuildIdentity \$env:GITHUB_RUN_ID/);
    assert.match(workflow, /WORKER_PROJECT_ID: \$\{\{ vars\.CTYUN_WORKER_PROJECT_ID \}\}/);
    assert.match(workflow, /WORKER_IMAGE_PROJECT_ID: \$\{\{ vars\.CTYUN_IMAGE_PROJECT_ID \|\| '0' \}\}/);
    assert.match(workflow, /-BuilderProjectID \$env:WORKER_PROJECT_ID/);
    assert.match(workflow, /-ImageProjectID \$env:WORKER_IMAGE_PROJECT_ID/);
    assert.match(workflow, /CTYUN_WORKER_PROJECT_ID is required/);
    assert.match(workflow, /CTYUN_IMAGE_PROJECT_ID is required/);
    assert.match(workflow, /timeout-minutes: 360/);
    assert.match(workflow, /-BakeTimeoutMinutes 150/);
    assert.match(workflow, /-CleanupTimeoutMinutes 40/);
    assert.match(workflow, /-Mode Cleanup/);
    assert.match(workflow, /steps\.bake\.outcome != 'success'/);
    assert.match(workflow, /actions: read/);
    assert.match(workflow, /Find interrupted image runs/);
    assert.match(workflow, /per_page=100&page=\$page/);
    assert.match(workflow, /page=\$\(\(page \+ 1\)\)/);
    assert.match(workflow, /jq -cs --arg current/);
    assert.match(workflow, /foreach \(\$run in \$runs\)/);
    assert.match(workflow, /foreach \(\$attempt in 1\.\.\$runAttempt\)/);
    assert.match(workflow, /foreach \(\$previousAttempt in 1\.\./);
    assert.match(workflow, /Historical image cleanup needs manual attention/);
    assert.match(workflow, /GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /Recent interrupted image cleanup failed/);
    assert.match(workflow, /recentDeadline[\s\S]*AddMinutes\(45\)/);
    assert.match(workflow, /historicalDeadline[\s\S]*AddMinutes\(10\)/);
    assert.match(workflow, /rerunDeadline[\s\S]*AddMinutes\(45\)/);
    assert.match(workflow, /Previous attempt cleanup failed/);
    assert.match(workflow, /\$Historical\) \{ '120s' \} else \{ '1000s' \}/);
    assert.match(
      workflow,
      /steps\.prior_runs\.outputs\.runs[\s\S]*INTERRUPTED_RUNS_JSON/,
    );
    assert.match(workflow, /Stage private artifact for the builder/);
    assert.match(workflow, /aws s3 presign/);
    assert.match(workflow, /bootstrap-status\.json/);
    assert.match(workflow, /X-Amz-SignedHeaders/);
    assert.match(workflow, /--acl private/);
    assert.match(workflow, /Remove staged private artifact/);
    assert.match(workflow, /aws s3 rm/);
    assert.match(workflow, /STAGED_STATUS_KEY/);
    assert.doesNotMatch(workflow, /public-read|upload-artifact/);
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

  test("image bake lifecycle is owned, idempotent, and strictly cleaned", () => {
    const sandbox = fs.mkdtempSync(
      path.join(os.tmpdir(), "catsco-worker-image-test-"),
    );
    try {
      fs.writeFileSync(
        path.join(sandbox, "package.json"),
        '{"type":"module"}\n',
      );
      const statePath = path.join(sandbox, "state.json");
      const logPath = path.join(sandbox, "calls.log");
      const artifactPath = path.join(sandbox, "worker.tar.gz");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: false,
          keyExists: false,
          keyPairName: "",
          imageExists: false,
          imageName: "",
          imageDescription: "",
          imageSourceServerID: "",
          imageStatus: "error",
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
  const requestedName = value("--imageName");
  returnObj = {
    images: state.imageExists && state.imageName === requestedName
      ? [{
          imageID: "image-1",
          imageName: state.imageName,
          imageStatus: state.imageStatus,
          description: state.imageDescription,
          sourceServerID: state.imageSourceServerID,
        }]
      : [],
  };
} else if (operation === "ecs ImportEcsKeypair") {
  state.keyExists = true;
  state.keyPairName = value("--keyPairName");
} else if (operation === "ecs GetEcsKeypairDetails") {
  const keyVisible = state.keyExists && !(state.keyHiddenReads > 0);
  if (state.keyHiddenReads > 0) state.keyHiddenReads -= 1;
  returnObj = {
    results: keyVisible
      ? [{ keyPairID: "key-1", keyPairName: state.keyPairName }]
      : [],
  };
} else if (operation === "ecs CreateEcsInstance") {
  state.instanceExists = true;
  state.instanceName = value("--instanceName");
  state.instanceStatus = "stopped";
  state.createExtIP = value("--extIP");
  state.createUserData = value("--userData");
  state.createHadBandwidth = args.includes("--bandwidth");
  returnObj = { masterResourceID: "resource-1" };
} else if (operation === "ecs ListEcsInstances") {
  if (state.listInstancesFailures > 0) {
    // Single-shot discovery API failure: this call errors but later calls
    // succeed, so a discovery failure must not be mistaken for "gone".
    state.listInstancesFailures -= 1;
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(JSON.stringify({
      statusCode: 900,
      message: "ERROR",
      description: "fake discovery error",
      returnObj: {},
    }));
    process.exit(0);
  }
  const instanceID = state.instanceID || "instance-1";
  const requestedID = value("--instanceIDList");
  const requestedName = value("--instanceName");
  const orderLookupStillPending = args.includes("--resourceID");
  const instanceVisible =
    state.instanceExists && !(state.instanceHiddenReads > 0);
  if (state.instanceHiddenReads > 0) state.instanceHiddenReads -= 1;
  // A just-created instance is returned with an empty instanceID for the
  // first reads (eventual consistency), mirroring the real Tianyi API where
  // Find-BuilderInstance must skip such candidates and retry instead of
  // recording an empty BuilderID.
  const instanceIDEmpty = state.instanceIDEmptyReads > 0;
  if (state.instanceIDEmptyReads > 0) state.instanceIDEmptyReads -= 1;
  returnObj = {
    results:
      instanceVisible &&
      !orderLookupStillPending &&
      (!requestedID || requestedID === instanceID) &&
      (!requestedName || requestedName === state.instanceName)
      ? [{
          instanceID: instanceIDEmpty ? "" : instanceID,
          resourceID: "resource-1",
          instanceName: state.instanceName,
          instanceStatus: state.instanceStatus,
          floatingIP: "127.0.0.1",
        }]
      : [],
  };
} else if (operation === "ims CreateImage") {
  state.imageExists = true;
  state.imageName = value("--imageName");
  state.imageDescription = value("--description");
  state.imageSourceServerID =
    process.env.FAKE_CTYUN_SCENARIO === "foreign-image" ||
    process.env.FAKE_CTYUN_SCENARIO === "foreign-id"
      ? "instance-foreign"
      : "instance-1";
  state.imageStatus =
    process.env.FAKE_CTYUN_SCENARIO === "success" ? "active" : "error";
  returnObj = {
    images:
      process.env.FAKE_CTYUN_SCENARIO === "success"
        || process.env.FAKE_CTYUN_SCENARIO === "foreign-id"
        ? [{ imageID: "image-1" }]
        : [],
  };
} else if (operation === "ims GetImageDetail") {
  returnObj = {
    images: state.imageExists
      ? [{
          imageID: "image-1",
          imageName: state.imageName,
          imageStatus: state.imageStatus,
          taskProgress: "100",
          description: state.imageDescription,
          sourceServerID: state.imageSourceServerID,
        }]
      : [],
  };
} else if (operation === "ims UpdateImage") {
  state.imageName = value("--imageName");
  state.imageDescription = value("--description");
  state.imageStatus = "active";
} else if (operation === "ims DeleteImage") {
  if (state.deleteImageFails) {
    // Simulate a DeleteImage API failure: the image stays and the call errors.
    state.imageExists = true;
    state.fakeApiError = true;
  } else if (state.deleteImageSticky) {
    // Simulate a delete that never becomes visible (confirmation timeout).
    state.imageExists = true;
  } else {
    state.imageExists = false;
  }
} else if (operation === "ecs DeleteEcsInstance") {
  if (args.includes("--deleteEip") && state.deleteEipNotSupported) {
    // Multi-AZ pools (e.g. cn-huanan2) reject releasing associated resources
    // at delete time (Ecs.Region.NotSupport). The orchestrator must retry the
    // plain delete instead of leaking the billed ECS.
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(JSON.stringify({
      statusCode: 900,
      message: "ERROR",
      description: "The region does not support unsubscribing/deleting instance to release associated resources",
      errorCode: "Ecs.Region.NotSupport",
      returnObj: {},
    }));
    process.exit(0);
  }
  state.instanceExists = false;
} else if (operation === "ecs DeleteEcsKeypair") {
  state.keyExists = false;
} else {
  process.stderr.write("unexpected fake operation: " + operation + "\\n");
  process.exit(2);
}
fs.writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify({
  statusCode: state.fakeApiError ? 900 : 800,
  message: state.fakeApiError ? "ERROR" : "SUCCESS",
  description: state.fakeApiError ? "fake api error" : "success",
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
      writeCommand(
        sandbox,
        "timeout",
        `
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
`,
      );

      const runBake = (
        buildNumber: string,
        imageName: string,
        scenario = "",
      ) =>
        spawnSync(
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
            "-ArtifactUrl",
            "https://example.test/private-worker?signature=test",
            "-PrepareScriptUrl",
            "https://example.test/prepare-image.sh?signature=test",
            "-PrepareScriptSha256",
            crypto.createHash("sha256").update("prepare-image").digest("hex"),
            "-BootstrapStatusGetUrl",
            "https://example.test/bootstrap-status.json?signature=get-test",
            "-BootstrapStatusPutUrl",
            "https://example.test/bootstrap-status.json?signature=put-test",
            "-BuildNumber",
            buildNumber,
            "-BuildAttempt",
            "1",
            "-LateResourceWaitSeconds",
            "10",
            "-PollIntervalSeconds",
            "1",
            "-ImageName",
            imageName,
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
            // Consecutive-empty deletion confirmation adds bounded waits; keep
            // plenty of headroom above the orchestrator's own deadlines.
            timeout: 120_000,
            env: {
              ...process.env,
              PATH: `${sandbox}${path.delimiter}${process.env.PATH || ""}`,
              FAKE_CTYUN_STATE: statePath,
              FAKE_CTYUN_LOG: logPath,
              FAKE_CTYUN_SCENARIO: scenario,
            },
          },
        );

      const runCleanup = (
        buildNumber: string,
        imageName: string,
        extraArgs: string[] = [],
      ) =>
        spawnSync(
          "pwsh",
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            imageOrchestratorPath,
            "-Mode",
            "Cleanup",
            "-SourceRef",
            "HEAD",
            "-BuildNumber",
            buildNumber,
            "-BuildAttempt",
            "1",
            "-PollIntervalSeconds",
            "1",
            "-ImageName",
            imageName,
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
            ...extraArgs,
          ],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 120_000,
            env: {
              ...process.env,
              PATH: `${sandbox}${path.delimiter}${process.env.PATH || ""}`,
              FAKE_CTYUN_STATE: statePath,
              FAKE_CTYUN_LOG: logPath,
            },
          },
        );

      const result = runBake("999", "catsco-worker-test-999");

      assert.notEqual(
        result.status,
        0,
        `expected the image error to fail the bake\n${result.stdout}\n${result.stderr}`,
      );
      assert.ok(
        fs.existsSync(logPath),
        `expected fake cloud CLI to be invoked\n${result.stdout}\n${result.stderr}`,
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
      const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(finalState.instanceExists, false);
      assert.equal(finalState.keyExists, false);
      assert.equal(finalState.imageExists, false);
      assert.equal(finalState.instanceName, "catsco-img-000999-01");
      assert.equal(finalState.instanceStatus, "stopped");
      assert.equal(finalState.createExtIP, "0");
      assert.equal(finalState.createHadBandwidth, false);
      assert.ok(finalState.createUserData.length <= 16384);
      const bootstrap = Buffer.from(finalState.createUserData, "base64").toString("utf8");
      assert.match(bootstrap, /#cloud-config/);
      assert.match(bootstrap, /write_files:/);
      assert.match(bootstrap, /runcmd:/);
      assert.match(bootstrap, /catsco-image-bootstrap\.sh/);
      const contentMatch = bootstrap.match(/    content: ([A-Za-z0-9+/=]+)\n/);
      assert.ok(contentMatch, "cloud-config must contain base64 bootstrap content");
      const decodedBootstrap = Buffer.from(contentMatch[1], "base64").toString("utf8");
      assert.match(decodedBootstrap, /curl_common=\(--fail --silent --show-error/);
      assert.match(decodedBootstrap, /--ipv4/);
      assert.match(decodedBootstrap, /--connect-timeout 20/);
      assert.match(decodedBootstrap, /--max-time 900/);
      assert.match(decodedBootstrap, /phase download-prepare-script/);
      assert.match(decodedBootstrap, /phase shutdown/);
      assert.match(decodedBootstrap, /publish_status failed/);
      assert.match(decodedBootstrap, /heartbeat &/);
      assert.match(decodedBootstrap, /shutdown -h now/);
      assert.match(decodedBootstrap, new RegExp(artifactSha));
      assert.match(decodedBootstrap, /sha256sum --check --strict/);
      assert.doesNotMatch(bootstrap, /example\.test\/private-worker/);
      assert.doesNotMatch(bootstrap, /example\.test\/prepare-image/);
      assert.doesNotMatch(bootstrap, /example\.test\/bootstrap-status/);
      assert.doesNotMatch(bootstrap, /\bscp\b|\bssh\b/);
      assert.equal(finalState.imageSourceServerID, "instance-1");
      assert.match(
        finalState.imageName,
        /^catsco-bake-[0-9a-f]{8}-[0-9a-f]{8}$/,
      );
      assert.match(
        finalState.imageDescription,
        /^CatsCo worker \S+ commit [0-9a-f]{40} bake 000999-01$/,
      );

      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: false,
          keyExists: false,
          keyPairName: "",
          imageExists: false,
          imageName: "",
          imageDescription: "",
          imageSourceServerID: "",
          imageStatus: "error",
          instanceName: "",
          instanceStatus: "running",
        }),
      );
      const foreignResult = runBake(
        "1000",
        "catsco-worker-test-1000",
        "foreign-image",
      );
      assert.notEqual(foreignResult.status, 0);
      assert.match(
        `${foreignResult.stdout}\n${foreignResult.stderr}`,
        /Refusing to delete[\s\S]*sourceServerID 'instance-foreign'/,
      );
      const foreignCalls = fs.readFileSync(logPath, "utf8");
      assert.doesNotMatch(foreignCalls, /ims DeleteImage/);
      assert.match(foreignCalls, /ecs DeleteEcsInstance/);
      assert.match(foreignCalls, /ecs DeleteEcsKeypair/);
      const foreignState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(foreignState.imageExists, true);
      assert.equal(foreignState.instanceExists, false);
      assert.equal(foreignState.keyExists, false);

      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: false,
          keyExists: false,
          keyPairName: "",
          imageExists: false,
          imageName: "",
          imageDescription: "",
          imageSourceServerID: "",
          imageStatus: "error",
          instanceName: "",
          instanceStatus: "running",
        }),
      );
      const foreignIdResult = runBake(
        "1005",
        "catsco-worker-test-1005",
        "foreign-id",
      );
      assert.notEqual(foreignIdResult.status, 0);
      assert.match(
        `${foreignIdResult.stdout}\n${foreignIdResult.stderr}`,
        /Refusing to delete[\s\S]*does not belong to this bake/,
      );
      const foreignIdCalls = fs.readFileSync(logPath, "utf8");
      assert.doesNotMatch(foreignIdCalls, /ims DeleteImage/);
      assert.match(foreignIdCalls, /ecs DeleteEcsInstance/);
      assert.match(foreignIdCalls, /ecs DeleteEcsKeypair/);

      // Key pair identity resolution failure: ImportEcsKeypair succeeds on the
      // cloud, but the follow-up GetEcsKeypairDetails returns nothing, so
      // KeyPairID stays empty. The failed bake must still clean up the created
      // key pair by its unique name (KeyPairCreateAttempted is set right after
      // the import, before the resolution read).
      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: false,
          keyExists: false,
          keyPairName: "",
          keyHiddenReads: 2, // hide the existing-check and the ID-resolution reads
          imageExists: false,
          imageName: "",
          imageDescription: "",
          imageSourceServerID: "",
          imageStatus: "error",
          instanceName: "",
          instanceStatus: "running",
        }),
      );
      const keyResolutionFailResult = runBake(
        "1012",
        "catsco-worker-test-1012",
      );
      assert.notEqual(
        keyResolutionFailResult.status,
        0,
        `${keyResolutionFailResult.stdout}\n${keyResolutionFailResult.stderr}`,
      );
      assert.match(
        `${keyResolutionFailResult.stdout}\n${keyResolutionFailResult.stderr}`,
        /Imported key pair could not be resolved/,
      );
      const keyResolutionFailCalls = fs.readFileSync(logPath, "utf8");
      assert.match(keyResolutionFailCalls, /ecs ImportEcsKeypair/);
      assert.match(keyResolutionFailCalls, /ecs DeleteEcsKeypair/);
      const keyResolutionFailState = JSON.parse(
        fs.readFileSync(statePath, "utf8"),
      );
      assert.equal(keyResolutionFailState.keyExists, false);

      const commit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      const version = JSON.parse(read("package.json")).version;
      const releaseIdentity = `CatsCo worker ${version} commit ${commit}`;
      const releaseDescription = `${releaseIdentity} ready`;
      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: false,
          keyExists: false,
          keyPairName: "",
          imageExists: true,
          imageName: "catsco-worker-existing",
          imageDescription: releaseDescription,
          imageSourceServerID: "instance-prior",
          imageStatus: "active",
          instanceName: "",
          instanceStatus: "stopped",
        }),
      );
      const reuseResult = runBake("1001", "catsco-worker-existing");
      assert.equal(
        reuseResult.status,
        0,
        `${reuseResult.stdout}\n${reuseResult.stderr}`,
      );
      assert.match(reuseResult.stdout, /"result":\s*"reused"/);
      const reuseCalls = fs.readFileSync(logPath, "utf8");
      assert.doesNotMatch(reuseCalls, /ecs CreateEcsInstance/);
      assert.doesNotMatch(reuseCalls, /ecs ImportEcsKeypair/);

      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: true,
          instanceHiddenReads: 1,
          keyExists: true,
          keyHiddenReads: 1,
          keyPairName: "catsco-img-key-001003-01",
          imageExists: true,
          imageName: "catsco-worker-pending",
          imageDescription: `${releaseIdentity} bake 001003-01`,
          imageSourceServerID: "instance-1",
          imageStatus: "active",
          instanceName: "catsco-img-001003-01",
          instanceStatus: "stopped",
        }),
      );
      const recoveryResult = runBake("1004", "catsco-worker-pending");
      assert.equal(
        recoveryResult.status,
        0,
        `${recoveryResult.stdout}\n${recoveryResult.stderr}`,
      );
      assert.match(recoveryResult.stdout, /"result":\s*"recovered"/);
      const recoveryCalls = fs.readFileSync(logPath, "utf8");
      assert.doesNotMatch(recoveryCalls, /ecs CreateEcsInstance/);
      assert.ok(
        (recoveryCalls.match(/ecs ListEcsInstances/g) || []).length >= 2,
      );
      assert.match(recoveryCalls, /ecs GetEcsKeypairDetails/);
      assert.match(recoveryCalls, /ecs DeleteEcsInstance/);
      assert.match(recoveryCalls, /ecs DeleteEcsKeypair/);
      assert.match(recoveryCalls, /ims UpdateImage/);
      const recoveryState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(recoveryState.imageExists, true);
      assert.equal(recoveryState.imageDescription, releaseDescription);
      assert.equal(recoveryState.instanceExists, false);
      assert.equal(recoveryState.keyExists, false);

      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: true,
          instanceID: "instance-new",
          keyExists: true,
          keyPairName: "catsco-img-key-001008-01",
          imageExists: true,
          imageName: "catsco-pending-reused",
          imageDescription: `${releaseIdentity} bake 001008-01`,
          imageSourceServerID: "instance-prior",
          imageStatus: "active",
          instanceName: "catsco-img-001008-01",
          instanceStatus: "running",
        }),
      );
      const reusedNameRecoveryResult = runBake(
        "1008",
        "catsco-pending-reused",
      );
      assert.equal(
        reusedNameRecoveryResult.status,
        0,
        `${reusedNameRecoveryResult.stdout}\n${reusedNameRecoveryResult.stderr}`,
      );
      const reusedNameRecoveryCalls = fs.readFileSync(logPath, "utf8");
      assert.doesNotMatch(
        reusedNameRecoveryCalls,
        /ecs DeleteEcsInstance/,
      );
      // The instance is protected (source ID mismatch), but the key pair's
      // unique temporary name is proven by the pending bake marker, so the
      // recovery deletes it instead of leaking a billed key pair.
      assert.match(reusedNameRecoveryCalls, /ecs DeleteEcsKeypair/);
      const reusedNameRecoveryState = JSON.parse(
        fs.readFileSync(statePath, "utf8"),
      );
      assert.equal(reusedNameRecoveryState.instanceExists, true);
      assert.equal(reusedNameRecoveryState.instanceID, "instance-new");
      assert.equal(reusedNameRecoveryState.keyExists, false);
      assert.equal(
        reusedNameRecoveryState.imageDescription,
        releaseDescription,
      );

      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: false,
          keyExists: false,
          keyPairName: "",
          imageExists: false,
          imageName: "",
          imageDescription: "",
          imageSourceServerID: "",
          imageStatus: "error",
          instanceName: "",
          instanceStatus: "running",
        }),
      );
      const successResult = runBake(
        "1002",
        "catsco-worker-published",
        "success",
      );
      assert.equal(
        successResult.status,
        0,
        `${successResult.stdout}\n${successResult.stderr}`,
      );
      assert.match(successResult.stdout, /"result":\s*"created"/);
      const successCalls = fs.readFileSync(logPath, "utf8");
      assert.match(successCalls, /ims UpdateImage/);
      assert.match(successCalls, /ecs DeleteEcsInstance/);
      assert.match(successCalls, /ecs DeleteEcsKeypair/);
      const successState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(successState.imageExists, true);
      assert.equal(successState.imageName, "catsco-worker-published");
      assert.equal(successState.imageDescription, releaseDescription);
      assert.equal(successState.imageStatus, "active");
      assert.equal(successState.instanceExists, false);
      assert.equal(successState.keyExists, false);

      const cleanupBuildNumber = "1006";
      const cleanupBakeId = "001006-01";
      const cleanupToken = crypto
        .createHash("sha256")
        .update(`${cleanupBuildNumber}/1/${commit}`)
        .digest("hex")
        .slice(0, 8);
      const cleanupImageName =
        `catsco-bake-${commit.slice(0, 8)}-${cleanupToken}`;
      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: true,
          keyExists: true,
          keyPairName: `catsco-img-key-${cleanupBakeId}`,
          imageExists: true,
          imageName: cleanupImageName,
          imageDescription: `${releaseIdentity} bake ${cleanupBakeId}`,
          imageSourceServerID: "instance-1",
          imageStatus: "error",
          instanceName: `catsco-img-${cleanupBakeId}`,
          instanceStatus: "stopped",
        }),
      );
      const cleanupResult = runCleanup(
        cleanupBuildNumber,
        "catsco-worker-cleanup",
      );
      // All three resources are uniquely owned by this bake, so reconcile
      // deletes them (review: cleanup must actually recover, not only report).
      assert.equal(
        cleanupResult.status,
        0,
        `${cleanupResult.stdout}\n${cleanupResult.stderr}`,
      );
      assert.match(cleanupResult.stdout, /"result":\s*"reconciled"/);
      const cleanupCalls = fs.readFileSync(logPath, "utf8");
      assert.match(cleanupCalls, /ims DeleteImage/);
      assert.match(cleanupCalls, /ecs DeleteEcsInstance/);
      assert.match(cleanupCalls, /ecs DeleteEcsKeypair/);
      // The image must be deleted before the builder, which stays as the
      // sourceServerID ownership evidence until the image is gone.
      assert.ok(
        cleanupCalls.indexOf("ims DeleteImage") <
          cleanupCalls.indexOf("ecs DeleteEcsInstance"),
        "image must be deleted before the builder (ownership evidence)",
      );
      const cleanupState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(cleanupState.imageExists, false);
      assert.equal(cleanupState.instanceExists, false);
      assert.equal(cleanupState.keyExists, false);

      const foreignCleanupBuildNumber = "1007";
      const foreignCleanupBakeId = "001007-01";
      const foreignCleanupToken = crypto
        .createHash("sha256")
        .update(`${foreignCleanupBuildNumber}/1/${commit}`)
        .digest("hex")
        .slice(0, 8);
      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: true,
          keyExists: true,
          keyPairName: `catsco-img-key-${foreignCleanupBakeId}`,
          imageExists: true,
          imageName:
            `catsco-bake-${commit.slice(0, 8)}-${foreignCleanupToken}`,
          imageDescription:
            `${releaseIdentity} bake ${foreignCleanupBakeId}`,
          imageSourceServerID: "instance-foreign",
          imageStatus: "error",
          instanceName: `catsco-img-${foreignCleanupBakeId}`,
          instanceStatus: "stopped",
        }),
      );
      const foreignCleanupResult = runCleanup(
        foreignCleanupBuildNumber,
        "catsco-worker-cleanup-foreign",
      );
      // The builder (unique name) and key pair are reconciled, but the image's
      // sourceServerID does not match the resolved builder, so it cannot be
      // proven and stays fail-closed.
      assert.notEqual(foreignCleanupResult.status, 0);
      assert.match(
        `${foreignCleanupResult.stdout}\n${foreignCleanupResult.stderr}`,
        /Temporary cloud resource cleanup failed during reconciliation/,
      );
      const foreignCleanupCalls = fs.readFileSync(logPath, "utf8");
      assert.doesNotMatch(foreignCleanupCalls, /ims DeleteImage/);
      assert.match(foreignCleanupCalls, /ecs DeleteEcsInstance/);
      assert.match(foreignCleanupCalls, /ecs DeleteEcsKeypair/);
      const foreignCleanupState = JSON.parse(
        fs.readFileSync(statePath, "utf8"),
      );
      assert.equal(foreignCleanupState.imageExists, true);
      assert.equal(foreignCleanupState.instanceExists, false);
      assert.equal(foreignCleanupState.keyExists, false);

      // Cleanup must detect a bake interrupted right after ImportEcsKeypair:
      // only the temporary key pair exists (no image, no builder). It must
      // fail closed with the key pair identity instead of silently reporting
      // nothing-to-clean.
      const keyOnlyCleanupBuildNumber = "1010";
      const keyOnlyCleanupBakeId = "001010-01";
      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: false,
          keyExists: true,
          keyPairName: `catsco-img-key-${keyOnlyCleanupBakeId}`,
          imageExists: false,
          imageName: "",
          imageDescription: "",
          imageSourceServerID: "",
          imageStatus: "error",
          instanceName: "",
          instanceStatus: "stopped",
        }),
      );
      const keyOnlyCleanupResult = runCleanup(
        keyOnlyCleanupBuildNumber,
        "catsco-worker-cleanup-keyonly",
      );
      // The key pair's unique temporary name is owned by this bake, so reconcile
      // deletes it instead of only reporting it.
      assert.equal(
        keyOnlyCleanupResult.status,
        0,
        `${keyOnlyCleanupResult.stdout}\n${keyOnlyCleanupResult.stderr}`,
      );
      assert.match(keyOnlyCleanupResult.stdout, /"result":\s*"reconciled"/);
      const keyOnlyCleanupCalls = fs.readFileSync(logPath, "utf8");
      assert.match(keyOnlyCleanupCalls, /ecs GetEcsKeypairDetails/);
      assert.match(keyOnlyCleanupCalls, /ecs DeleteEcsKeypair/);
      const keyOnlyCleanupState = JSON.parse(
        fs.readFileSync(statePath, "utf8"),
      );
      assert.equal(keyOnlyCleanupState.keyExists, false);

      // Scenario A: DeleteImage fails -> the image stays and the builder must
      // be retained as ownership evidence for the next reconciliation.
      const failImageBuildNumber = "1011";
      const failImageBakeId = "001011-01";
      const failImageToken = crypto
        .createHash("sha256")
        .update(`${failImageBuildNumber}/1/${commit}`)
        .digest("hex")
        .slice(0, 8);
      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: true,
          keyExists: true,
          keyPairName: `catsco-img-key-${failImageBakeId}`,
          imageExists: true,
          imageName: `catsco-bake-${commit.slice(0, 8)}-${failImageToken}`,
          imageDescription: `${releaseIdentity} bake ${failImageBakeId}`,
          imageSourceServerID: "instance-1",
          imageStatus: "error",
          deleteImageFails: true,
          instanceName: `catsco-img-${failImageBakeId}`,
          instanceStatus: "stopped",
        }),
      );
      const failImageResult = runCleanup(
        failImageBuildNumber,
        "catsco-worker-cleanup-failimage",
      );
      assert.notEqual(failImageResult.status, 0);
      assert.match(
        `${failImageResult.stdout}\n${failImageResult.stderr}`,
        /builder cleanup deferred/,
      );
      const failImageCalls = fs.readFileSync(logPath, "utf8");
      assert.match(failImageCalls, /ims DeleteImage/);
      assert.doesNotMatch(failImageCalls, /ecs DeleteEcsInstance/);
      const failImageState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(failImageState.imageExists, true);
      assert.equal(failImageState.instanceExists, true);

      // Scenario B: DeleteImage succeeds but the image never disappears until
      // the confirmation window times out -> the builder must be retained.
      // CleanupTimeoutMinutes is reduced so the bounded confirmation window
      // fits inside the test timeout.
      const stickyBuildNumber = "1012";
      const stickyBakeId = "001012-01";
      const stickyToken = crypto
        .createHash("sha256")
        .update(`${stickyBuildNumber}/1/${commit}`)
        .digest("hex")
        .slice(0, 8);
      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: true,
          keyExists: true,
          keyPairName: `catsco-img-key-${stickyBakeId}`,
          imageExists: true,
          imageName: `catsco-bake-${commit.slice(0, 8)}-${stickyToken}`,
          imageDescription: `${releaseIdentity} bake ${stickyBakeId}`,
          imageSourceServerID: "instance-1",
          imageStatus: "error",
          deleteImageSticky: true,
          instanceName: `catsco-img-${stickyBakeId}`,
          instanceStatus: "stopped",
        }),
      );
      const stickyResult = runCleanup(
        stickyBuildNumber,
        "catsco-worker-cleanup-sticky",
        ["-ImageDeleteConfirmSeconds", "2"],
      );
      assert.notEqual(stickyResult.status, 0);
      assert.match(
        `${stickyResult.stdout}\n${stickyResult.stderr}`,
        /builder cleanup deferred/,
      );
      const stickyCalls = fs.readFileSync(logPath, "utf8");
      assert.match(stickyCalls, /ims DeleteImage/);
      assert.doesNotMatch(stickyCalls, /ecs DeleteEcsInstance/);
      const stickyState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(stickyState.imageExists, true);
      assert.equal(stickyState.instanceExists, true);

      // Cleanup discovery must not trust a single empty read: the key pair is
      // hidden for the first reads (eventual consistency), so discovery must
      // retry with consecutive-empty reads before concluding it is gone.
      const hiddenKeyBuildNumber = "1013";
      const hiddenKeyBakeId = "001013-01";
      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: false,
          keyExists: true,
          keyHiddenReads: 2, // hide the discovery reads; visible on the 3rd
          keyPairName: `catsco-img-key-${hiddenKeyBakeId}`,
          imageExists: false,
          imageName: "",
          imageDescription: "",
          imageSourceServerID: "",
          imageStatus: "error",
          instanceName: "",
          instanceStatus: "stopped",
        }),
      );
      const hiddenKeyResult = runCleanup(
        hiddenKeyBuildNumber,
        "catsco-worker-cleanup-hiddenkey",
      );
      assert.equal(
        hiddenKeyResult.status,
        0,
        `${hiddenKeyResult.stdout}\n${hiddenKeyResult.stderr}`,
      );
      assert.match(hiddenKeyResult.stdout, /"result":\s*"reconciled"/);
      const hiddenKeyCalls = fs.readFileSync(logPath, "utf8");
      assert.ok(
        (hiddenKeyCalls.match(/ecs GetEcsKeypairDetails/g) || []).length >= 3,
        `expected consecutive-empty key discovery reads\n${hiddenKeyCalls}`,
      );
      assert.match(hiddenKeyCalls, /ecs DeleteEcsKeypair/);
      const hiddenKeyState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(hiddenKeyState.keyExists, false);

      // Cleanup builder discovery must also survive eventually-consistent
      // empty reads: the builder is hidden for the first reads, then found by
      // its unique temporary name and reconciled.
      const hiddenBuilderBuildNumber = "1014";
      const hiddenBuilderBakeId = "001014-01";
      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: true,
          instanceHiddenReads: 2,
          keyExists: false,
          keyPairName: "",
          imageExists: false,
          imageName: "",
          imageDescription: "",
          imageSourceServerID: "",
          imageStatus: "error",
          instanceName: `catsco-img-${hiddenBuilderBakeId}`,
          instanceStatus: "stopped",
        }),
      );
      const hiddenBuilderResult = runCleanup(
        hiddenBuilderBuildNumber,
        "catsco-worker-cleanup-hbuilder",
      );
      assert.equal(
        hiddenBuilderResult.status,
        0,
        `${hiddenBuilderResult.stdout}\n${hiddenBuilderResult.stderr}`,
      );
      assert.match(hiddenBuilderResult.stdout, /"result":\s*"reconciled"/);
      const hiddenBuilderCalls = fs.readFileSync(logPath, "utf8");
      assert.ok(
        (hiddenBuilderCalls.match(/ecs ListEcsInstances/g) || []).length >= 3,
        `expected consecutive-empty builder discovery reads\n${hiddenBuilderCalls}`,
      );
      assert.match(hiddenBuilderCalls, /ecs DeleteEcsInstance/);
      const hiddenBuilderState = JSON.parse(
        fs.readFileSync(statePath, "utf8"),
      );
      assert.equal(hiddenBuilderState.instanceExists, false);

      // A builder-discovery API failure must not skip the other resources:
      // the key pair is still reconciled even though the builder query
      // errored. The error joins the aggregate and the run fails closed
      // naming it, instead of aborting before the key pair is touched.
      const discoveryErrorBuildNumber = "1015";
      const discoveryErrorBakeId = "001015-01";
      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: true,
          listInstancesFailures: 1, // first ListEcsInstances call errors
          keyExists: true,
          keyPairName: `catsco-img-key-${discoveryErrorBakeId}`,
          imageExists: false,
          imageName: "",
          imageDescription: "",
          imageSourceServerID: "",
          imageStatus: "error",
          instanceName: `catsco-img-${discoveryErrorBakeId}`,
          instanceStatus: "stopped",
        }),
      );
      const discoveryErrorResult = runCleanup(
        discoveryErrorBuildNumber,
        "catsco-worker-cleanup-discerr",
      );
      assert.notEqual(discoveryErrorResult.status, 0);
      assert.match(
        `${discoveryErrorResult.stdout}\n${discoveryErrorResult.stderr}`,
        /builder discovery/,
      );
      const discoveryErrorCalls = fs.readFileSync(logPath, "utf8");
      assert.match(discoveryErrorCalls, /ecs DeleteEcsKeypair/);
      const discoveryErrorState = JSON.parse(
        fs.readFileSync(statePath, "utf8"),
      );
      assert.equal(discoveryErrorState.keyExists, false);

      // A just-created builder is returned with an empty instanceID for the
      // first reads (Tianyi eventual consistency, reproduced against the real
      // API). Find-BuilderInstance must skip the empty-ID candidate and retry;
      // recording an empty BuilderID would make Assert-TemporaryBuilder reject
      // the bake with 'outside this bake'.
      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: false,
          keyExists: false,
          keyPairName: "",
          imageExists: false,
          imageName: "",
          imageDescription: "",
          imageSourceServerID: "",
          imageStatus: "error",
          instanceName: "",
          instanceStatus: "running",
          instanceIDEmptyReads: 2, // first 2 ListEcsInstances reads: empty ID
        }),
      );
      const emptyIdResult = runBake(
        "1016",
        "catsco-worker-emptyid",
        "success",
      );
      assert.equal(
        emptyIdResult.status,
        0,
        `${emptyIdResult.stdout}\n${emptyIdResult.stderr}`,
      );
      assert.match(emptyIdResult.stdout, /"result":\s*"created"/);
      const emptyIdCalls = fs.readFileSync(logPath, "utf8");
      assert.ok(
        (emptyIdCalls.match(/ecs ListEcsInstances/g) || []).length >= 3,
        `expected Find-BuilderInstance to retry past empty-ID reads\n${emptyIdCalls}`,
      );
      const emptyIdState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(emptyIdState.imageExists, true);
      assert.equal(emptyIdState.instanceExists, false);
      assert.equal(emptyIdState.keyExists, false);

      // Multi-AZ pools reject deleting an ECS while releasing associated
      // resources (Ecs.Region.NotSupport, reproduced against cn-huanan2).
      // Remove-Builder must fall back to a plain delete so the failed-bake
      // path still cleans up the billed builder.
      const notSupportBuildNumber = "1017";
      const notSupportBakeId = "001017-01";
      fs.writeFileSync(logPath, "");
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          instanceExists: false,
          keyExists: false,
          keyPairName: "",
          imageExists: false,
          imageName: "",
          imageDescription: "",
          imageSourceServerID: "",
          imageStatus: "error",
          instanceName: "",
          instanceStatus: "running",
          deleteEipNotSupported: true,
        }),
      );
      const notSupportResult = runBake(
        notSupportBuildNumber,
        "catsco-worker-notsupport",
      );
      // Image creation fails by design (default scenario); the point is that
      // cleanup still succeeds despite the Region.NotSupport delete error.
      assert.notEqual(notSupportResult.status, 0);
      const notSupportCalls = fs.readFileSync(logPath, "utf8");
      assert.ok(
        (notSupportCalls.match(/ecs DeleteEcsInstance/g) || []).length >= 2,
        `expected DeleteEcsInstance fallback after NotSupport\n${notSupportCalls}`,
      );
      const notSupportState = JSON.parse(
        fs.readFileSync(statePath, "utf8"),
      );
      assert.equal(notSupportState.instanceExists, false);
      assert.equal(notSupportState.keyExists, false);
      // The error-status image is removed by Remove-FailedImage on the failed
      // bake path, just like the instance and key pair.
      assert.equal(notSupportState.imageExists, false);

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
