import * as fs from 'node:fs';
import * as path from 'node:path';

export const OFFICIAL_XURL_SMOKE_ROOT = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'xurl-official-smoke',
);

export type OfficialSmokeProvider = 'codex' | 'claude' | 'pi';

interface ProviderFixtureConfig {
  readonly provider: OfficialSmokeProvider;
  readonly envVar: 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR' | 'PI_CODING_AGENT_DIR';
  readonly fixtureRoot: string;
  readonly threadFile: string;
}

const PROVIDER_FIXTURES: readonly ProviderFixtureConfig[] = [
  {
    provider: 'codex',
    envVar: 'CODEX_HOME',
    fixtureRoot: path.join(OFFICIAL_XURL_SMOKE_ROOT, 'codex'),
    threadFile: path.join(
      'sessions',
      '2026',
      '02',
      '23',
      'rollout-2026-02-23T06-55-38-29bf19c3-b83e-401d-8f38-5660b7f67152.jsonl',
    ),
  },
  {
    provider: 'claude',
    envVar: 'CLAUDE_CONFIG_DIR',
    fixtureRoot: path.join(OFFICIAL_XURL_SMOKE_ROOT, 'claude'),
    threadFile: path.join('projects', 'project-smoke', 'b90fc33d-33cb-4027-8558-119e2b56c74e.jsonl'),
  },
  {
    provider: 'pi',
    envVar: 'PI_CODING_AGENT_DIR',
    fixtureRoot: path.join(OFFICIAL_XURL_SMOKE_ROOT, 'pi'),
    threadFile: path.join(
      'agent',
      'sessions',
      '--Users-redacted-workspace-project--',
      '2026-02-23T13-20-05-148Z_bc6ea3d9-0e40-4942-a490-3e0aa7f125de.jsonl',
    ),
  },
] as const;

export function listOfficialXurlSmokeFixtures(): readonly ProviderFixtureConfig[] {
  return PROVIDER_FIXTURES;
}

export function validateOfficialXurlSmokeFixtures(): void {
  for (const fixture of PROVIDER_FIXTURES) {
    const root = fixture.fixtureRoot;
    const threadFile = path.join(root, fixture.threadFile);
    if (!fs.existsSync(root)) {
      throw new Error(`missing official xURL smoke fixture root for ${fixture.provider}: ${root}`);
    }
    if (!fs.existsSync(threadFile)) {
      throw new Error(`missing official xURL smoke thread file for ${fixture.provider}: ${threadFile}`);
    }
    const lines = fs.readFileSync(threadFile, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      throw new Error(`official xURL smoke fixture thread is empty for ${fixture.provider}`);
    }
    for (const line of lines) {
      JSON.parse(line);
    }
  }
}

export function materializeOfficialXurlSmokeFixtures(destinationRoot: string): {
  readonly env: Record<string, string>;
  appendStableCompletedTurn(provider: OfficialSmokeProvider): void;
} {
  validateOfficialXurlSmokeFixtures();
  const env: Record<string, string> = {};

  for (const fixture of PROVIDER_FIXTURES) {
    const destination = path.join(destinationRoot, fixture.provider);
    fs.cpSync(fixture.fixtureRoot, destination, { recursive: true });
    env[fixture.envVar] = fixture.provider === 'pi'
      ? path.join(destination, 'agent')
      : destination;
  }

  return {
    env,
    appendStableCompletedTurn(provider: OfficialSmokeProvider): void {
      const fixture = PROVIDER_FIXTURES.find(candidate => candidate.provider === provider);
      if (!fixture) throw new Error(`unsupported smoke provider: ${provider}`);
      const root = path.join(destinationRoot, provider);
      const filePath = path.join(root, fixture.threadFile);
      fs.appendFileSync(filePath, renderAppendedTurn(provider), 'utf8');
    },
  };
}

function renderAppendedTurn(provider: OfficialSmokeProvider): string {
  switch (provider) {
    case 'codex':
      return [
        JSON.stringify({
          timestamp: '2026-02-23T07:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Please generate and send the report.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-02-23T07:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Done.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-02-23T07:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Thanks, that works perfectly.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-02-23T07:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Glad it helped.' }],
          },
        }),
        '',
      ].join('\n');
    case 'claude':
      return [
        JSON.stringify({
          timestamp: '2026-02-23T00:00:02Z',
          type: 'user',
          sessionId: 'b90fc33d-33cb-4027-8558-119e2b56c74e',
          cwd: '/redacted/workspace/project',
          message: { role: 'user', content: 'Please generate and send the report.' },
        }),
        JSON.stringify({
          timestamp: '2026-02-23T00:00:03Z',
          type: 'assistant',
          sessionId: 'b90fc33d-33cb-4027-8558-119e2b56c74e',
          cwd: '/redacted/workspace/project',
          message: { role: 'assistant', content: 'Done.' },
        }),
        JSON.stringify({
          timestamp: '2026-02-23T00:00:04Z',
          type: 'user',
          sessionId: 'b90fc33d-33cb-4027-8558-119e2b56c74e',
          cwd: '/redacted/workspace/project',
          message: { role: 'user', content: 'Thanks, that works perfectly.' },
        }),
        JSON.stringify({
          timestamp: '2026-02-23T00:00:05Z',
          type: 'assistant',
          sessionId: 'b90fc33d-33cb-4027-8558-119e2b56c74e',
          cwd: '/redacted/workspace/project',
          message: { role: 'assistant', content: 'Glad it helped.' },
        }),
        '',
      ].join('\n');
    case 'pi':
      return [
        JSON.stringify({
          type: 'message',
          id: 'b1c2d3e4',
          parentId: 'a995f57d',
          timestamp: '2026-02-23T13:21:05.162Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Please generate and send the report.' }],
            timestamp: 1771852865162,
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'c5d6e7f8',
          parentId: 'b1c2d3e4',
          timestamp: '2026-02-23T13:21:07.862Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Done.', textSignature: 'msg_pi_smoke_done_2' }],
            api: 'openai-codex-responses',
            provider: 'openai-codex',
            model: 'gpt-5.3-codex',
            usage: {
              input: 3111,
              output: 11,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3122,
              cost: {
                input: 0.00544425,
                output: 0.000154,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.00559825,
              },
            },
            stopReason: 'stop',
            timestamp: 1771852867862,
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'd9e0f1a2',
          parentId: 'c5d6e7f8',
          timestamp: '2026-02-23T13:21:08.862Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Thanks, that works perfectly.' }],
            timestamp: 1771852868862,
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'e3f4a5b6',
          parentId: 'd9e0f1a2',
          timestamp: '2026-02-23T13:21:09.862Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Glad it helped.', textSignature: 'msg_pi_smoke_ack_2' }],
            api: 'openai-codex-responses',
            provider: 'openai-codex',
            model: 'gpt-5.3-codex',
            usage: {
              input: 128,
              output: 8,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 136,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: 'stop',
            timestamp: 1771852869862,
          },
        }),
        '',
      ].join('\n');
  }
}
