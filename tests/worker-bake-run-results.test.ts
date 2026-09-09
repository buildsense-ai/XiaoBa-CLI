import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bakeRunResults} from '../ops/ctyun-worker-image/bake-run-results.mjs';

const job=(profile:string,bake:string,cleanup:string)=>({
  name:`Build artifact and bake private image [${profile}]`,
  steps:[{name:'Bake private ECS image',conclusion:bake},{name:'Reconcile this attempt after a failed bake',conclusion:cleanup}],
});
test('successful NAT sibling cannot hide a failed public bake or cleanup',()=>{
  const jobs=[job('private_nat','success','skipped'),job('public_ip','failure','failure')];
  assert.deepEqual(bakeRunResults(jobs,'public_ip'),{bake:'failure',cleanup:'failure'});
  assert.deepEqual(bakeRunResults(jobs,'private_nat'),{bake:'success',cleanup:'skipped'});
  assert.deepEqual(bakeRunResults(jobs.reverse(),'public_ip'),{bake:'failure',cleanup:'failure'});
});
test('a failed NAT job cannot borrow successful public cleanup',()=>{
  const jobs=[job('public_ip','failure','success'),job('private_nat','cancelled','failure')];
  assert.deepEqual(bakeRunResults(jobs,'private_nat'),{bake:'cancelled',cleanup:'failure'});
});
test('legacy single-profile runs remain reconcilable and missing data is not success',()=>{
  const legacy=job('private_nat','failure','success');
  legacy.name='Build artifact and bake private image';
  assert.deepEqual(bakeRunResults([legacy],'private_nat'),{bake:'failure',cleanup:'success'});
  assert.deepEqual(bakeRunResults([job('private_nat','success','skipped')],'public_ip'),{bake:'unknown',cleanup:'unknown'});
  assert.throws(()=>bakeRunResults([],'all'));
});
