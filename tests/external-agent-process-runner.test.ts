import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ProcessRunner } from '../src/runtime/external-agent/process-runner';

async function runChunkedOutput(stdout: string, stderr: string): Promise<{ stdout: string; stderr: string }> {
  const script = [
    'const pause=()=>new Promise(resolve=>setTimeout(resolve,1));',
    'async function write(stream,text){for(const character of text){const bytes=Buffer.from(character);for(let i=0;i<bytes.length;i+=1){stream.write(bytes.subarray(i,i+1));await pause();}}}',
    `(async()=>{await write(process.stdout,${JSON.stringify(stdout)});await write(process.stderr,${JSON.stringify(stderr)});})().catch(error=>{console.error(error);process.exitCode=1;});`,
  ].join('');

  return new ProcessRunner().run({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
  });
}

describe('ProcessRunner UTF-8 stream decoding', () => {
  test('preserves stdout and stderr split inside multi-byte characters', async () => {
    const result = await runChunkedOutput('标准输出中文🙂', '标准错误中文🚫');

    assert.equal(result.stdout, '标准输出中文🙂');
    assert.equal(result.stderr, '标准错误中文🚫');
    assert.equal(result.stdout.includes('\uFFFD'), false);
    assert.equal(result.stderr.includes('\uFFFD'), false);
  });

  test('preserves normal ASCII and genuine replacement characters', async () => {
    const result = await runChunkedOutput('stdout � ok', 'stderr � ok');

    assert.equal(result.stdout, 'stdout � ok');
    assert.equal(result.stderr, 'stderr � ok');
  });
});
