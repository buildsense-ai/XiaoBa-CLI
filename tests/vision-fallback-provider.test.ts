import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  analyzeImageWithVisionFallback,
  resolveVisionFallbackProviderConfig,
} from '../src/utils/vision-fallback-provider';

const ENV_KEYS = [
  'CATSCOMPANY_VISION_FALLBACK_ENABLED',
  'CATSCOMPANY_VISION_FALLBACK_USE_PRIMARY',
  'CATSCOMPANY_VISION_FALLBACK_BASE_URL',
  'CATSCOMPANY_VISION_FALLBACK_API_KEY',
  'CATSCOMPANY_VISION_FALLBACK_MODEL',
  'CATSCOMPANY_VISION_FALLBACK_TIMEOUT_MS',
  'CATSCOMPANY_VISION_FALLBACK_MAX_TOKENS',
] as const;
const originalEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('vision fallback provider', () => {
  test('is disabled unless explicitly enabled', () => {
    const resolved = resolveVisionFallbackProviderConfig({
      apiUrl: 'https://example.test/v1',
      apiKey: 'primary-key',
      model: 'vision-model',
    });
    assert.equal(resolved, undefined);
  });

  test('can reuse the primary model connection when enabled', () => {
    const resolved = resolveVisionFallbackProviderConfig({
      apiUrl: 'https://example.test/v1',
      apiKey: 'primary-key',
      model: 'gpt-5.6-sol',
      visionFallback: { enabled: true, usePrimaryModel: true },
    });
    assert.deepEqual(resolved, {
      baseUrl: 'https://example.test/v1',
      apiKey: 'primary-key',
      model: 'gpt-5.6-sol',
      timeoutMs: 300000,
      maxTokens: 4096,
    });
  });

  test('sends an OpenAI-compatible multimodal request and returns text', async () => {
    let requestPath = '';
    let authorization = '';
    let body: any;
    const server = http.createServer((req, res) => {
      requestPath = req.url || '';
      authorization = String(req.headers.authorization || '');
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'visible text' } }] }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-fallback-'));
    const imagePath = path.join(root, 'sample.png');
    fs.writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));

    try {
      const result = await analyzeImageWithVisionFallback({
        filePath: imagePath,
        prompt: 'Read this image',
        config: {
          visionFallback: {
            enabled: true,
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: 'fallback-key',
            model: 'fallback-vision',
          },
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.analysis, 'visible text');
      assert.equal(requestPath, '/v1/chat/completions');
      assert.equal(authorization, 'Bearer fallback-key');
      assert.equal(body.model, 'fallback-vision');
      assert.equal(body.messages[0].content[0].text, 'Read this image');
      assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns provider errors without throwing', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-fallback-'));
    const imagePath = path.join(root, 'sample.jpg');
    fs.writeFileSync(imagePath, Buffer.from([255, 216, 255]));

    try {
      const result = await analyzeImageWithVisionFallback({
        filePath: imagePath,
        prompt: 'Read',
        config: {
          visionFallback: {
            enabled: true,
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: 'bad-key',
            model: 'fallback-vision',
          },
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.configured, true);
      assert.equal(result.status, 401);
      assert.equal(result.error, 'bad key');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
