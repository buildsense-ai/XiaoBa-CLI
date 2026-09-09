import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveDeploymentProfile} from '../ops/ctyun-worker-image/deployment-profile.mjs';

const required=['REGION_ID','PROJECT_ID','IMAGE_PROJECT_ID','AZ_NAME','BASE_IMAGE_ID','FLAVOR_ID','VPC_ID','SUBNET_ID','SECURITY_GROUP_ID'];
const nat=Object.fromEntries(required.map(key=>['WORKER_'+key,'nat-'+key]));
const publicValues=Object.fromEntries(required.map(key=>[key==='IMAGE_PROJECT_ID'?'CTYUN_IMAGE_PROJECT_ID':'CTYUN_WORKER_'+key,'public-'+key]));
publicValues.CTYUN_WORKER_REGION_ID='200000004421';

test('public bake configuration is region scoped and never inherits NAT resources',()=>{
  const env={...nat,WORKER_BASE_IMAGE_HARDENED:'true',WORKER_PROTECTED_IMAGE_IDS:'nat-protected',CTYUN_PUBLIC_WORKER_PROFILE_JSON:JSON.stringify(publicValues)};
  const result=resolveDeploymentProfile('public_ip',env);
  assert.equal(result.WORKER_REGION_ID,'200000004421');
  assert.equal(result.WORKER_PUBLIC_IP,'true');
  assert.equal(result.WORKER_BASE_IMAGE_HARDENED,'false');
  assert.equal(result.WORKER_PROTECTED_IMAGE_IDS,'');
  assert.equal(result.WORKER_VPC_ID,'public-VPC_ID');
  assert.equal(env.WORKER_VPC_ID,'nat-VPC_ID');
});
test('incomplete, injected and wrong-region public profiles fail before cloud operations',()=>{
  for(const raw of [{}, {...publicValues,CTYUN_WORKER_REGION_ID:'nat-region'}, {...publicValues,CTYUN_WORKER_VPC_ID:'vpc\nCTYUN_AK=fake'}, {...publicValues,CTYUN_AK:'fake'}]) {
    assert.throws(()=>resolveDeploymentProfile('public_ip',{...nat,CTYUN_PUBLIC_WORKER_PROFILE_JSON:JSON.stringify(raw)}));
  }
});
test('default NAT image and protected resources remain unchanged',()=>{
  const result=resolveDeploymentProfile('private_nat',{...nat,WORKER_PROTECTED_IMAGE_IDS:'nat-protected'});
  assert.equal(result.WORKER_REGION_ID,nat.WORKER_REGION_ID);
  assert.equal(result.WORKER_PUBLIC_IP,'false');
  assert.equal(result.WORKER_PROTECTED_IMAGE_IDS,'nat-protected');
});
