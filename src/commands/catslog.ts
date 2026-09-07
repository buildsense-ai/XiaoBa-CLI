import { CatscoLogUploadScheduler, type CatscoLogSkillQuery } from '../utils/catsco-log-upload-scheduler';

export async function catslogSkillsCommand(options: CatscoLogSkillQuery): Promise<void> {
  const result = await new CatscoLogUploadScheduler(process.cwd()).readSkills(options);
  // Runtime-generated Skill text is intentionally emitted as data. Do not
  // silently inject it into a prompt or reinterpret it as trusted policy.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function catslogSkillOutcomeCommand(handle: string, revision: number, outcome: 'succeeded' | 'failed' | 'corrected'): Promise<void> {
  await new CatscoLogUploadScheduler(process.cwd()).reportSkillOutcome(handle, revision, outcome);
}
