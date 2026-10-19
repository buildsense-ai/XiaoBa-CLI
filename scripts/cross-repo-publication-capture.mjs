#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cloud=process.env.SKILLHUB_CLOUD_REPO;
if(!cloud)throw Error('SKILLHUB_CLOUD_REPO must identify a real checkout with installed dependencies; no skip');
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:cloud,encoding:'utf8'}).trim();
if(process.env.SKILLHUB_CLOUD_REVISION)assert.equal(revision,process.env.SKILLHUB_CLOUD_REVISION);
const {validatePublishRequest}=await import(pathToFileURL(path.join(cloud,'packages/publish-validation/index.js')));
const require=createRequire(import.meta.url);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoba-capture-contract-'));
try{
  const result=spawnSync(process.execPath,[require.resolve('tsx/cli'),path.join(root,'tests/fixtures/publication-capture-contract.ts'),temp],
    {cwd:root,windowsHide:true,shell:false,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  if(result.error||result.status!==0||result.signal)throw Error('Runtime capture fixture failed');
  const rows=JSON.parse(result.stdout);assert.deepEqual(rows.map(r=>r.kind),['valid','invalid','script']);
  for(const row of rows){
    const report=validatePublishRequest(row.request);
    const validation=report.body.validation??report.body.error?.validation;
    assert.ok(validation?.candidateHash);assert.equal(validation.candidateHash,row.receipt.sourceSnapshotHash);
    assert.equal(createHash('sha256').update(row.request).digest('hex'),row.receipt.requestHash);
    assert.equal(Buffer.byteLength(row.request),row.receipt.requestBytes);
    assert.equal(validation.outcome,row.kind==='valid'?'passed':'rejected');
  }
  console.log(`[capture-contract] 3/3 real runtime captures match Cloud ${revision} validation; no upload, credentials, or model calls.`);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
