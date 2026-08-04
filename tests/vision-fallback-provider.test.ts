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
import { MAX_IMAGE_INPUT_BYTES } from '../src/utils/image-utils';
import { writeBmpHeader, writeOnePixelBmp } from './helpers/image-fixtures';

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
      provider: 'openai',
      openaiApiMode: 'chat_completions',
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

  test('rejects primary connections that are not OpenAI Chat Completions compatible', () => {
    const resolved = resolveVisionFallbackProviderConfig({
      apiUrl: 'https://api.anthropic.com/v1',
      apiKey: 'primary-key',
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      visionFallback: { enabled: true, usePrimaryModel: true },
    });

    assert.equal(resolved, undefined);
  });

  test('does not mix an environment endpoint with file credentials', () => {
    process.env.CATSCOMPANY_VISION_FALLBACK_BASE_URL = 'https://environment.example/v1';

    const resolved = resolveVisionFallbackProviderConfig({
      visionFallback: {
        enabled: true,
        baseUrl: 'https://config.example/v1',
        apiKey: 'config-key',
        model: 'config-model',
      },
    });

    assert.equal(resolved, undefined);
  });

  test('distinguishes invalid enabled configuration from a disabled provider', async () => {
    const result = await analyzeImageWithVisionFallback({
      filePath: '/unused/for-invalid-config.png',
      prompt: 'Read',
      config: {
        visionFallback: {
          enabled: true,
          baseUrl: 'https://fallback.example/v1',
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.match(result.error || '', /missing apiKey, model/i);
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
    writeOnePixelBmp(imagePath);

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
      assert.equal(body.messages[0].role, 'system');
      assert.match(body.messages[0].content, /untrusted content/i);
      assert.equal(body.messages[1].role, 'user');
      assert.equal(body.messages[1].content[0].text, 'Read this image');
      assert.match(body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
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
    writeOnePixelBmp(imagePath);

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

  test('converts BMP input to a bounded JPEG before sending it', async () => {
    let imageUrl = '';
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        imageUrl = body.messages[1].content[1].image_url.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'red pixel' } }] }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-fallback-'));
    const imagePath = path.join(root, 'sample.bmp');
    writeOnePixelBmp(imagePath);

    try {
      const result = await analyzeImageWithVisionFallback({
        filePath: imagePath,
        prompt: 'Read',
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
      assert.match(imageUrl, /^data:image\/jpeg;base64,/);
      const encoded = imageUrl.slice(imageUrl.indexOf(',') + 1);
      assert.deepEqual([...Buffer.from(encoded, 'base64').subarray(0, 3)], [255, 216, 255]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not start a provider request after the caller has cancelled', async () => {
    let requestCount = 0;
    const server = http.createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'too late' } }] }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-fallback-'));
    const imagePath = path.join(root, 'sample.bmp');
    writeOnePixelBmp(imagePath);
    const controller = new AbortController();
    controller.abort();

    try {
      const result = await analyzeImageWithVisionFallback({
        filePath: imagePath,
        prompt: 'Read',
        signal: controller.signal,
        config: {
          visionFallback: {
            enabled: true,
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: 'fallback-key',
            model: 'fallback-vision',
          },
        },
      });

      assert.equal(result.ok, false);
      assert.match(result.error || '', /aborted/i);
      assert.equal(requestCount, 0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('enforces an absolute deadline even while the provider trickles data', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(' ');
      const interval = setInterval(() => res.write(' '), 5);
      res.once('close', () => clearInterval(interval));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-fallback-'));
    const imagePath = path.join(root, 'sample.bmp');
    writeOnePixelBmp(imagePath);

    try {
      const result = await Promise.race([
        analyzeImageWithVisionFallback({
          filePath: imagePath,
          prompt: 'Read',
          config: {
            visionFallback: {
              enabled: true,
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: 'fallback-key',
              model: 'fallback-vision',
              timeoutMs: 40,
            },
          },
        }),
        new Promise<{ hung: true }>(resolve => setTimeout(() => resolve({ hung: true }), 250)),
      ]);

      assert.equal('hung' in result, false);
      if (!('hung' in result)) {
        assert.equal(result.ok, false);
        assert.match(result.error || '', /timed out/i);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects provider responses above the response-size limit', async () => {
    const server = http.createServer((_req, res) => {
      const body = JSON.stringify({
        choices: [{ message: { content: 'x'.repeat(1_100_000) } }],
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      });
      res.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-fallback-'));
    const imagePath = path.join(root, 'sample.bmp');
    writeOnePixelBmp(imagePath);

    try {
      const result = await analyzeImageWithVisionFallback({
        filePath: imagePath,
        prompt: 'Read',
        config: {
          visionFallback: {
            enabled: true,
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: 'fallback-key',
            model: 'fallback-vision',
          },
        },
      });

      assert.equal(result.ok, false);
      assert.match(result.error || '', /content length|maxContentLength|size limit/i);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects oversized source images before opening a provider connection', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-fallback-'));
    const imagePath = path.join(root, 'oversized.jpg');
    fs.writeFileSync(imagePath, Buffer.alloc(1));
    fs.truncateSync(imagePath, MAX_IMAGE_INPUT_BYTES + 1);

    try {
      const result = await analyzeImageWithVisionFallback({
        filePath: imagePath,
        prompt: 'Read',
        config: {
          visionFallback: {
            enabled: true,
            baseUrl: 'http://127.0.0.1:1/v1',
            apiKey: 'fallback-key',
            model: 'fallback-vision',
          },
        },
      });

      assert.equal(result.ok, false);
      assert.match(result.error || '', /input limit/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects oversized BMP dimensions before native decoding', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-fallback-'));
    const imagePath = path.join(root, 'oversized-dimensions.bmp');
    writeBmpHeader(imagePath, 100_000, 100_000);

    try {
      const result = await analyzeImageWithVisionFallback({
        filePath: imagePath,
        prompt: 'Read',
        config: {
          visionFallback: {
            enabled: true,
            baseUrl: 'http://127.0.0.1:1/v1',
            apiKey: 'fallback-key',
            model: 'fallback-vision',
          },
        },
      });

      assert.equal(result.ok, false);
      assert.match(result.error || '', /pixel limit/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('redacts the configured credential from provider-controlled errors', async () => {
    const secret = 'arbitrary-fallback-credential';
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: `Authorization: Bearer ${secret}; api_key=${secret}` },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-fallback-'));
    const imagePath = path.join(root, 'sample.jpg');
    writeOnePixelBmp(imagePath);

    try {
      const result = await analyzeImageWithVisionFallback({
        filePath: imagePath,
        prompt: 'Read',
        config: {
          visionFallback: {
            enabled: true,
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: secret,
            model: 'fallback-vision',
          },
        },
      });

      assert.equal(result.ok, false);
      assert.doesNotMatch(result.error || '', new RegExp(secret));
      assert.match(result.error || '', /redacted-token/);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
