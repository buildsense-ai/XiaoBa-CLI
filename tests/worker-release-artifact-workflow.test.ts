import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const releaseWorkflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'release.yml'),
  'utf8',
);
const artifactBuilder = fs.readFileSync(
  path.join(root, 'scripts', 'build-linux-worker-artifact.mjs'),
  'utf8',
);

test('release automation has no fixed-host SSH worker CD', () => {
  assert.equal(fs.existsSync(path.join(root, '.github', 'workflows', 'worker-app-update.yml')), false);
  assert.doesNotMatch(releaseWorkflow, /WORKER_SSH_TARGETS|WORKER_SSH_KEY|ssh\s|scp\s/);
});

test('stable releases publish a versioned worker artifact and manifest', () => {
  assert.match(releaseWorkflow, /build-worker:/);
  assert.match(releaseWorkflow, /npm run --silent worker:artifact -- --manifest-output "\$raw_manifest"/);
  assert.doesNotMatch(releaseWorkflow, /worker:artifact > "\$raw_manifest"/);
  assert.match(artifactBuilder, /"--manifest-output": "manifestOutput"/);
  assert.match(artifactBuilder, /fs\.writeFileSync\(manifestOutputPath, buildManifest/);
  assert.match(artifactBuilder, /process\.stdout\.write\(buildManifest\)/);
  assert.match(releaseWorkflow, /release\/worker\/manifest\.json/);
  assert.match(releaseWorkflow, /path: release-worker/);
  assert.match(releaseWorkflow, /find release-worker -maxdepth 1 -type f ! -name manifest\.json -print0/);
  assert.match(releaseWorkflow, /TOS_WORKER_BUCKET: catsco-worker-release/);
  assert.match(releaseWorkflow, /VOLC_TOS_WORKER_PUBLISH_ACCESS_KEY_ID/);
  assert.match(releaseWorkflow, /retention-days: 7/);
  assert.match(releaseWorkflow, /aws configure set default\.s3\.addressing_style virtual/);
  assert.match(releaseWorkflow, /WORKER_PREFIX="update\/worker\/\$\{WORKER_VERSION\}"/);
  assert.match(releaseWorkflow, /--acl private/);
  assert.match(releaseWorkflow, /publish_immutable_worker_file release-worker\/manifest\.json/);
  assert.match(releaseWorkflow, /Refusing to overwrite immutable worker artifact/);
  assert.match(releaseWorkflow, /Private worker manifest privacy verification failed/);
  assert.match(releaseWorkflow, /needs: \[build-mac, build-win, build-linux, build-worker\]/);
});

test('desktop releases are pruned only after publication with bounded retention', () => {
  const releaseJob = releaseWorkflow.match(/\r?\n  release:\r?\n[\s\S]*$/)?.[0] || '';

  assert.match(
    releaseJob,
    /- name: Checkout release retention scripts\s+uses: actions\/checkout@v4\s+with:\s+persist-credentials: false/,
  );
  assert.ok(
    releaseJob.indexOf('Checkout release retention scripts')
      < releaseJob.indexOf('Prune old desktop releases in both TOS buckets'),
    'release checkout must run before the retention planner',
  );
  assert.match(releaseWorkflow, /group: desktop-release-\$\{\{ github\.ref \}\}/);
  assert.match(releaseWorkflow, /- name: Publish GitHub Release[\s\S]*?- name: Prune old desktop releases in both TOS buckets/);
  assert.match(releaseWorkflow, /--keep-versions 2/);
  assert.match(releaseWorkflow, /--min-age-days 30/);
  assert.match(releaseWorkflow, /--max-delete-objects 80/);
  assert.match(releaseWorkflow, /scripts\/plan-release-retention\.mjs/);
  assert.match(releaseWorkflow, /prune_bucket "\$TOS_TARGET_BUCKET" "\$TOS_TARGET_REGION" guangzhou/);
  assert.match(releaseWorkflow, /prune_bucket "\$TOS_SOURCE_BUCKET" "\$TOS_SOURCE_REGION" hong-kong/);
  assert.match(releaseWorkflow, /delete-objects/);
  assert.match(releaseWorkflow, /One or more old \$label release objects still exist/);
});

test('worker artifacts never enter the public release paths', () => {
  const publicSourceUpload = releaseWorkflow.match(
    /- name: Upload release payloads to Hong Kong source bucket[\s\S]*?- name: Wait for Guangzhou bucket replication/,
  )?.[0] || '';
  const githubRelease = releaseWorkflow.match(
    /- name: Create draft GitHub Release[\s\S]*?- name: Publish latest metadata/,
  )?.[0] || '';

  assert.doesNotMatch(publicSourceUpload, /release-worker/);
  assert.doesNotMatch(githubRelease, /release-worker/);
});

test('worker artifacts carry the updater used by the cloud control plane', () => {
  assert.match(artifactBuilder, /scripts\/update-worker-artifact\.sh/);
});
