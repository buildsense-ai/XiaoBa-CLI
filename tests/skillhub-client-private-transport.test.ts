import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SkillHubClient } from '../src/skillhub/client';
import type {
  SkillHubBotCredential,
  SkillHubPrivateUpsertInput,
  SkillHubRegistryEntry,
} from '../src/skillhub/types';

describe('SkillHubClient Bot private transport', () => {
  let root: string;
  let originalUserDataDir: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skillhub-client-'));
    originalUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
    process.env.XIAOBA_USER_DATA_DIR = root;
  });

  afterEach(() => {
    if (originalUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = originalUserDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('uses isolated Bot credentials for private PUT, metadata, trust, and download', async () => {
    const observed: Array<{
      method: string;
      url: string;
      authorization?: string;
      botId?: string;
      cookie?: string;
      body: string;
    }> = [];
    const server = await startServer(async (request, response) => {
      const body = await readRequestBody(request);
      observed.push({
        method: request.method || '',
        url: request.url || '',
        authorization: header(request, 'authorization'),
        botId: header(request, 'x-catsco-bot-id'),
        cookie: header(request, 'cookie'),
        body,
      });
      if (request.url === '/api/auth/login') {
        response.setHeader('Set-Cookie', 'user_session=before-bot; Path=/; HttpOnly');
        return json(response, {});
      }
      if (request.url === '/api/auth/me') {
        return json(response, {
          user: { id: 'user-1', email: 'user@example.com', displayName: 'User' },
          roles: [],
          permissions: [],
        });
      }
      if (request.method === 'PUT' && request.url?.startsWith('/api/bots/')) {
        response.setHeader('Set-Cookie', 'bot_session=must-not-persist; Path=/; HttpOnly');
        return json(response, { skill: { skillId: 'private/skill', latestVersion: HASH } });
      }
      if (request.url === '/api/skills/private/skill/versions/content-version') {
        return json(response, { version: { skillId: 'private/skill', latestVersion: 'content-version' } });
      }
      if (request.url === '/api/skills/private/skill/versions/content-version/download') {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        response.end('private-package');
        return;
      }
      if (request.url === '/api/trust/public-keys') {
        return json(response, { trustModel: 'root-signed-signing-keys', keys: [] });
      }
      if (request.url === '/api/skills') {
        return json(response, { skills: [] });
      }
      response.writeHead(404);
      response.end();
    });
    try {
      const client = new SkillHubClient({ baseUrl: server.baseUrl });
      await client.login({
        email: 'user@example.com',
        password: 'password',
      });
      const credential = botCredential();
      await client.upsertPrivateSkill(privateInput(), credential);
      await client.getVersion('private/skill', 'content-version', credential);
      const packageBytes = await client.downloadPackage(
        registryEntry('private/skill', 'content-version'),
        credential,
      );
      await client.getTrust(credential);
      await client.searchSkills();

      assert.equal(packageBytes.toString('utf8'), 'private-package');
      const botRequests = observed.filter(item => (
        item.url.startsWith('/api/bots/')
        || item.url.includes('/versions/content-version')
        || item.url === '/api/trust/public-keys'
      ));
      assert.equal(botRequests.length, 4);
      for (const request of botRequests) {
        assert.equal(request.authorization, 'ApiKey bot-secret-key');
        assert.equal(request.botId, 'bot A');
        assert.equal(request.cookie, undefined);
      }
      const put = botRequests.find(item => item.method === 'PUT');
      assert.equal(
        put?.url,
        `/api/bots/bot%20A/private-skills/${LOCAL_SKILL_ID}/versions/${HASH}`,
      );
      assert.deepEqual(JSON.parse(put?.body || '{}'), privateInput());

      const userRequestAfterBot = observed.at(-1);
      assert.equal(userRequestAfterBot?.url, '/api/skills');
      assert.match(userRequestAfterBot?.cookie || '', /user_session=before-bot/);
      assert.doesNotMatch(userRequestAfterBot?.cookie || '', /bot_session/);
      assert.equal(userRequestAfterBot?.authorization, undefined);
    } finally {
      await server.close();
    }
  });

  test('rejects redirects for Bot-authenticated calls', async () => {
    let redirectedRequests = 0;
    const server = await startServer((_request, response) => {
      if (_request.url === '/redirect-target') redirectedRequests += 1;
      response.writeHead(302, { Location: '/redirect-target' });
      response.end();
    });
    try {
      const client = new SkillHubClient({ baseUrl: server.baseUrl });
      await assert.rejects(
        () => client.getVersion('private/skill', 'v1', botCredential()),
        (error: any) => error?.status === 502,
      );
      assert.equal(redirectedRequests, 0);
    } finally {
      await server.close();
    }
  });

  test('rejects invalid refs before constructing or sending a request', async () => {
    let requests = 0;
    const server = await startServer((_request, response) => {
      requests += 1;
      json(response, {});
    });
    try {
      const client = new SkillHubClient({ baseUrl: server.baseUrl });
      await assert.rejects(
        () => client.getVersion('../secret', 'v1', botCredential()),
        invalidReference,
      );
      await assert.rejects(
        () => client.downloadPackage(registryEntry('private/skill', '../v1'), botCredential()),
        invalidReference,
      );
      await assert.rejects(
        () => client.upsertPrivateSkill(
          { ...privateInput(), contentHash: 'not-a-hash' },
          botCredential(),
        ),
        invalidReference,
      );
      await assert.rejects(
        () => client.upsertPrivateSkill(
          {
            ...privateInput(),
            files: [{ ...privateInput().files[0], sha256: 'd'.repeat(64) }],
          },
          botCredential(),
        ),
        invalidReference,
      );
      await assert.rejects(
        () => client.upsertPrivateSkill(
          { ...privateInput(), workspaceId: '../other-workspace' },
          botCredential(),
        ),
        invalidReference,
      );
      await assert.rejects(
        () => client.upsertPrivateSkill(
          privateInput(),
          { ...botCredential(), botId: 'another-bot' },
        ),
        invalidReference,
      );
      assert.equal(requests, 0);
    } finally {
      await server.close();
    }
  });

  test('limits declared and streamed JSON responses to 2 MiB', async () => {
    const limit = 2 * 1024 * 1024;
    const server = await startServer((request, response) => {
      if (request.url?.endsWith('/declared')) {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': String(limit + 1),
        });
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"padding":"');
      response.end(`${'x'.repeat(limit)}"}`);
    });
    try {
      const client = new SkillHubClient({ baseUrl: server.baseUrl });
      for (const version of ['declared', 'streamed']) {
        await assert.rejects(
          () => client.getVersion('private/skill', version, botCredential()),
          (error: any) => (
            error?.status === 502
            && error?.code === 'skillhub.response_too_large'
          ),
        );
      }
    } finally {
      await server.close();
    }
  });

  test('times out while a response body is still streaming', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"trustModel":');
      setTimeout(() => response.end('"root-signed-signing-keys","keys":[]}'), 150);
    });
    try {
      const client = new SkillHubClient({ baseUrl: server.baseUrl, timeoutMs: 30 });
      await assert.rejects(
        () => client.getTrust(botCredential()),
        (error: any) => (
          error?.status === 408
          && error?.code === 'skillhub.response_timeout'
        ),
      );
    } finally {
      await server.close();
    }
  });

  test('allows HTTP only for loopback SkillHub servers', () => {
    assert.throws(
      () => new SkillHubClient({ baseUrl: 'http://example.com' }),
      /requires HTTPS/,
    );
    assert.doesNotThrow(
      () => new SkillHubClient({ baseUrl: 'http://localhost:3800' }),
    );
    assert.doesNotThrow(
      () => new SkillHubClient({ baseUrl: 'http://127.9.8.7:3800' }),
    );
    assert.doesNotThrow(
      () => new SkillHubClient({ baseUrl: 'https://skillhub.example.com' }),
    );
  });
});

const HASH = 'a'.repeat(64);
const LOCAL_SKILL_ID = '123e4567-e89b-42d3-a456-426614174000';

function botCredential(): SkillHubBotCredential {
  return {
    botId: 'bot A',
    apiKey: 'bot-secret-key',
  };
}

function privateInput(): SkillHubPrivateUpsertInput {
  return {
    botId: 'bot A',
    workspaceId: 'workspace-1',
    localSkillId: LOCAL_SKILL_ID,
    contentHash: HASH,
    name: 'private-skill',
    installName: 'private-skill',
    forkedFrom: {
      skillId: 'public/source',
      version: '1.0.0',
    },
    files: [{
      path: 'SKILL.md',
      size: 7,
      sha256: crypto.createHash('sha256').update('# skill', 'utf8').digest('hex'),
      contentBase64: 'IyBza2lsbA==',
    }],
  };
}

function registryEntry(skillId: string, latestVersion: string): SkillHubRegistryEntry {
  return {
    skillId,
    latestVersion,
    packageUrl: '/unused',
    checksumSha256: 'c'.repeat(64),
    signature: {
      algorithm: 'ed25519',
      keyId: 'key',
      signature: 'signature',
    },
  };
}

function invalidReference(error: any): boolean {
  return error?.status === 400 && error?.code === 'skillhub.invalid_reference';
}

async function startServer(
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => void | Promise<void>,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(error => {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function header(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

function json(response: http.ServerResponse, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
}
