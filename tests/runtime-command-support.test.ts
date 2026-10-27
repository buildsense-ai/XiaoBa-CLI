import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CatscoLogUploadScheduler } from '../src/utils/catsco-log-upload-scheduler';
import { startRuntimeCommandSupport, stopRuntimeCommandSupport } from '../src/utils/runtime-command-support';

describe('runtime command support', () => {
  const originalUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
  const originalShouldStart = CatscoLogUploadScheduler.shouldStartForCurrentRuntime;
  const originalStart = CatscoLogUploadScheduler.prototype.start;
  const originalStop = CatscoLogUploadScheduler.prototype.stop;

  afterEach(async () => {
    await stopRuntimeCommandSupport();
    CatscoLogUploadScheduler.shouldStartForCurrentRuntime = originalShouldStart;
    CatscoLogUploadScheduler.prototype.start = originalStart;
    CatscoLogUploadScheduler.prototype.stop = originalStop;
    if (originalUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = originalUserDataDir;
  });

  test('starts the uploader with the logger runtime data root when cwd differs', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-support-'));
    let resolvedRoot: string | undefined;
    try {
      process.env.XIAOBA_USER_DATA_DIR = runtimeRoot;
      CatscoLogUploadScheduler.shouldStartForCurrentRuntime = ((workingDirectory?: string) => {
        resolvedRoot = workingDirectory;
        return true;
      }) as typeof CatscoLogUploadScheduler.shouldStartForCurrentRuntime;
      CatscoLogUploadScheduler.prototype.start = async function startForTest(): Promise<void> {};
      CatscoLogUploadScheduler.prototype.stop = async function stopForTest(): Promise<void> {};

      const support = await startRuntimeCommandSupport();
      assert.equal(resolvedRoot, path.resolve(runtimeRoot));
      assert.equal(
        (support.catscoLogUploadScheduler as unknown as { workingDirectory: string }).workingDirectory,
        path.resolve(runtimeRoot),
      );
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});
