import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const workflow:any=yaml.load(fs.readFileSync(path.resolve(__dirname,'../.github/workflows/worker-image.yml'),'utf8'));
test('release and default manual baking target both regions, while a repair can select one',()=>{
  const image=workflow.jobs.image;
  const expression=image.strategy.matrix.deployment_profile.replace(/^\$\{\{\s*|\s*\}\}$/g,'');
  // Evaluate the checked-in matrix expression with only trusted fixture inputs.
  const resolve=new Function('fromJSON','format','github','inputs',`return (${expression})`);
  const format=(pattern:string,value:string)=>pattern.replace('{0}',value);
  assert.deepEqual(resolve(JSON.parse,format,{event_name:'push'},{}),['private_nat','public_ip']);
  const input=workflow.on.workflow_dispatch.inputs.deployment_profile;
  assert.equal(input.default,'all');
  assert.deepEqual(resolve(JSON.parse,format,{event_name:'workflow_dispatch'},{deployment_profile:input.default}),['private_nat','public_ip']);
  for(const profile of ['private_nat','public_ip']) {
    assert.deepEqual(resolve(JSON.parse,format,{event_name:'workflow_dispatch'},{deployment_profile:profile}),[profile]);
  }
  assert.equal(image.strategy['fail-fast'],false);
});
test('parallel regions cannot overwrite or remove each others TOS staging keys',()=>{
  const stage=workflow.jobs.image.steps.find((step:any)=>step.id==='artifact_transport').run;
  const templates=Array.from(stage.matchAll(/^\s*(?:key|script_key|status_key)="(update\/worker\/\.bake\/[^"\n]*)/gm),(m:any)=>m[1]);
  assert.equal(templates.length,3);
  const keys=(profile:string)=>templates.map((s:string)=>s.replace(/\$\{GITHUB_RUN_ID\}/g,'123').replace(/\$\{GITHUB_RUN_ATTEMPT\}/g,'2').replace(/\$\{WORKER_DEPLOYMENT_PROFILE\}/g,profile));
  const nat=keys('private_nat'), pub=keys('public_ip');
  for(const key of nat) assert.ok(key.startsWith('update/worker/.bake/123/2/private_nat/'));
  for(const key of pub) assert.ok(key.startsWith('update/worker/.bake/123/2/public_ip/'));
  assert.equal(new Set([...nat,...pub]).size,6);
  const cleanup=workflow.jobs.image.steps.find((step:any)=>step.name==='Remove staged private artifact');
  assert.deepEqual(Object.keys(cleanup.env).sort(),['STAGED_ARTIFACT_KEY','STAGED_SCRIPT_KEY','STAGED_STATUS_KEY']);
});
