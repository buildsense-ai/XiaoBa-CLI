import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function bakeRunResults(jobs, profile) {
  if (!['private_nat', 'public_ip'].includes(profile)) throw new Error('Invalid deployment profile');
  const name = `Build artifact and bake private image [${profile}]`;
  const job = jobs.find(job => job.name === name) ||
    jobs.find(job => job.name === 'Build artifact and bake private image');
  const conclusion = name => job?.steps?.find(step => step.name === name)?.conclusion || 'unknown';
  return {bake: conclusion('Bake private ECS image'), cleanup: conclusion('Reconcile this attempt after a failed bake')};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const response = JSON.parse(fs.readFileSync(0, 'utf8'));
  console.log(JSON.stringify(bakeRunResults(response.jobs || [], process.argv[2])));
}
