import { Command } from 'commander';
import { CatscoLogAgentClient } from '../utils/catsco-log-agent-client';
import { getCatscoLogAgentConfig } from '../utils/catsco-log-agent-config';
import { loadCatscoLogAgentState } from '../utils/catsco-log-agent-state';

export function registerCatslogCommand(program: Command): void {
  const catslog = program.command('catslog').description('Inspect CatsLog Runtime Learning Skills');
  catslog.command('skills')
    .option('--content', 'Request untrusted Skill markdown explicitly')
    .option('--limit <n>', 'Maximum Skills to return', value => Number(value), 50)
    .action(async (options) => {
      const { client, state } = skillClient();
      const result = await client.readSkills({ skillToken: state.skillToken!, skillsUrl: state.skillsUrl, includeContent: options.content === true, limit: options.limit });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
  catslog.command('outcome <handle> <revision> <outcome>')
    .description('Report succeeded, failed, or corrected after actually using an explicit Skill revision')
    .action(async (handle: string, revision: string, outcome: string) => {
      if (!/^(succeeded|failed|corrected)$/.test(outcome) || !Number.isInteger(Number(revision)) || Number(revision) < 1) throw new Error('outcome and revision are invalid');
      const { client, state } = skillClient();
      await client.reportSkillOutcome({ skillToken: state.skillToken!, skillsUrl: state.skillsUrl, handle, revision: Number(revision), outcome });
    });
}

function skillClient() {
  const config = getCatscoLogAgentConfig();
  const state = loadCatscoLogAgentState(config.stateFilePath);
  if (!state.skillToken || !state.skillTokenExpiresAt || Date.parse(state.skillTokenExpiresAt) <= Date.now()) throw new Error('CatsLog Skill capability is unavailable; upload/bootstrap first');
  return { client: new CatscoLogAgentClient(config.apiBaseUrl), state };
}
