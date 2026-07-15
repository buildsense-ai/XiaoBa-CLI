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
      'rollout-2026-02-23T06-55-38-codex-smoke-session.jsonl',
    ),
  },
  {
    provider: 'claude',
    envVar: 'CLAUDE_CONFIG_DIR',
    fixtureRoot: path.join(OFFICIAL_XURL_SMOKE_ROOT, 'claude'),
    threadFile: path.join('projects', 'project-smoke', 'claude-smoke-session.jsonl'),
  },
  {
    provider: 'pi',
    envVar: 'PI_CODING_AGENT_DIR',
    fixtureRoot: path.join(OFFICIAL_XURL_SMOKE_ROOT, 'pi', 'agent'),
    threadFile: path.join(
      'sessions',
      '--Users-redacted-workspace-project--',
      '2026-02-23T13-20-05-148Z_pi-smoke-session.jsonl',
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
      const root = provider === 'pi'
        ? path.join(destinationRoot, provider, 'agent')
        : path.join(destinationRoot, provider);
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
        '',
      ].join('\n');
    case 'claude':
      return [
        JSON.stringify({
          timestamp: '2026-02-23T00:00:02Z',
          type: 'user',
          sessionId: 'claude-smoke-session',
          cwd: '/redacted/workspace/project',
          message: { role: 'user', content: 'Please generate and send the report.' },
        }),
        JSON.stringify({
          timestamp: '2026-02-23T00:00:03Z',
          type: 'assistant',
          sessionId: 'claude-smoke-session',
          cwd: '/redacted/workspace/project',
          message: { role: 'assistant', content: 'Done.' },
        }),
        '',
      ].join('\n');
    case 'pi':
      return [
        JSON.stringify({
          type: 'message',
          id: 'pi-smoke-user-2',
          parentId: 'pi-smoke-assistant-1',
          timestamp: '2026-02-23T13:21:05.162Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Please generate and send the report.' }],
            timestamp: 1771852865162,
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'pi-smoke-assistant-2',
          parentId: 'pi-smoke-user-2',
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
        '',
      ].join('\n');
  }
}
