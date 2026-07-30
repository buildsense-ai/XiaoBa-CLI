import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');

describe('Tianyi Cloud worker image pipeline', () => {
  const artifactBuilder = read('scripts/build-linux-worker-artifact.mjs');
  const imagePreparer = read('ops/ctyun-worker-image/prepare-image.sh');
  const imageOrchestrator = read('ops/ctyun-worker-image/New-CatsCoWorkerImage.ps1');
  const workflow = read('.github/workflows/worker-image.yml');

  test('artifact copies tracked source assets and never packages repository history', () => {
    assert.match(artifactBuilder, /git\(sourceRoot, \['ls-files'/);
    assert.match(artifactBuilder, /'dist'/);
    assert.doesNotMatch(artifactBuilder, /fs\.cpSync\(path\.join\(root, '\.git'/);
    assert.match(artifactBuilder, /--omit=dev/);
  });

  test('image keeps immutable application files separate from runtime data', () => {
    assert.match(imagePreparer, /RELEASE_ROOT="\/opt\/catsco\/releases\//);
    assert.match(imagePreparer, /XIAOBA_USER_DATA_DIR=\/srv\/catsco-agent/);
    assert.match(imagePreparer, /WorkingDirectory=\/srv\/catsco-agent/);
    assert.match(imagePreparer, /systemctl disable --now catsco-agent\.service/);
  });

  test('finalization removes worker identity and machine identity before imaging', () => {
    assert.match(imagePreparer, /\/srv\/catsco-agent\/\.env/);
    assert.match(imagePreparer, /\/srv\/catsco-agent\/\.xiaoba/);
    assert.match(imagePreparer, /\/etc\/ssh\/ssh_host_\*/);
    assert.match(imagePreparer, /truncate -s 0 \/etc\/machine-id/);
    assert.match(imagePreparer, /cloud-init clean --logs --seed/);
  });

  test('orchestrator can mutate only a temporary catsco image builder', () => {
    assert.match(imageOrchestrator, /StartsWith\("catsco-img-"\)/);
    assert.match(imageOrchestrator, /Refusing to operate on non-builder instance/);
    assert.match(imageOrchestrator, /mutatesExistingWorkers = \$false/);
    assert.doesNotMatch(imageOrchestrator, /worker1|worker2|ck-work/);
  });

  test('tag workflow publishes a private China artifact before optional image baking', () => {
    assert.match(workflow, /tags:\s*\n\s*- 'v\*'/);
    assert.match(workflow, /worker-private\//);
    assert.match(workflow, /aws s3 presign/);
    assert.match(workflow, /--expires-in 3600/);
    assert.doesNotMatch(workflow, /public-read/);
    assert.match(workflow, /needs: artifact/);
    assert.match(workflow, /CTYUN_AUTO_BAKE_WORKER_IMAGE/);
  });

  test('orchestrator never prints the private artifact URL', () => {
    assert.match(imageOrchestrator, /signed URL redacted/);
    assert.doesNotMatch(imageOrchestrator, /artifactSource = \$ArtifactUrl/);
  });
});

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}
