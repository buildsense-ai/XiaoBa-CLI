import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const cloud=process.env.SKILLHUB_CLOUD_REPO;
assert.ok(cloud,'SKILLHUB_CLOUD_REPO with installed dependencies required; no skip');
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:cloud,encoding:'utf8'}).trim();
if(process.env.SKILLHUB_CLOUD_REVISION)assert.equal(revision,process.env.SKILLHUB_CLOUD_REVISION);
const load=p=>import(pathToFileURL(path.join(cloud,p)));
const {createPublicationUploadHandler}=await load('apps/api/publication-upload.js');
const {loadConfig}=await load('packages/config/index.js');
const {validatePublishRequest}=await load('packages/publish-validation/index.js');
const {publicationPeerTLS}=await load('tests/helpers/publication-peer-tls.js');
const {createCatsCoLocalConfigService}=require('../dist/catscompany/local-config.js');
const {BotSkillWorkspaceService}=require('../dist/bot-skills/workspace.js');
const {describePublicationSource}=require('../dist/skillhub/publication-source.js');
const {PublicationCaptureStore}=require('../dist/skillhub/publication-capture.js');
const {PublicationCandidateUploader}=require('../dist/skillhub/publication-upload.js');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'publication-upload-contract-'));
let tls,server;
try{
  const source=path.join(root,'skills','demo');await fs.mkdir(source,{recursive:true});
  await fs.writeFile(path.join(source,'SKILL.md'),'---\nname: demo\ndescription: Real handler contract\n---\nDemo');
  await fs.writeFile(path.join(source,'binary.bin'),Buffer.from([0,255,128]));
  new BotSkillWorkspaceService(root,path.join(root,'skills')).activate('42');
  const binding={botUid:'42',ownerUid:'7',bodyId:'contract-body',installationId:'contract-install'};
  createCatsCoLocalConfigService({runtimeRoot:root}).save({version:1,currentBot:{uid:'42',apiKey:'test',boundByUserUid:'7'},
    account:{uid:'7',username:'fixture',token:'test'},device:{bodyId:binding.bodyId,installationId:binding.installationId}});
  const input={entryId:'pubentry_'+'a'.repeat(32),binding,source:describePublicationSource(path.join(root,'skills'),source,binding)};
  const capture=new PublicationCaptureStore({runtimeRoot:root,enabled:true}),receipt=await capture.capture(input,()=>{});
  const original=await capture.readRequest(input,()=>{});
  tls=await publicationPeerTLS();let handler;
  server=https.createServer(tls,(req,res)=>void handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const audience=`https://127.0.0.1:${server.address().port}`,issuer='https://cats.example';
  let calls=0,checks=0;
  const config=loadConfig({publicationTasksEnabled:true,publicationUploadEnabled:true,publicationUploadIssuer:issuer,
    publicationUploadAudience:audience,publicationUploadPeerSecret:'1'.repeat(64)});
  handler=createPublicationUploadHandler(config,{}, {
    introspectionClient:{async checkUploadGrant(r){checks++;assert.equal(r.token,'pubupload_'+'b'.repeat(64));return {actorCatsCoUid:'7'};}},
    accept:async r=>{
      calls++;assert.deepEqual(r.rawBody,original);assert.equal(r.entryRequestId,input.entryId);
      const result=validatePublishRequest(r.rawBody.toString());assert.equal(result.body.validation.candidateHash,receipt.sourceSnapshotHash);
      return {accepted:true,created:calls===1,association:{taskId:'pubtask_12345678-1234-4123-8123-123456789abc',entryRequestId:input.entryId,
        candidateRevision:1,candidateHash:receipt.sourceSnapshotHash,requestHash:receipt.requestHash,authorityEpoch:1,
        eventId:'pubevent_12345678-1234-4123-8123-123456789abc',state:'delegated_pending',candidateAvailable:true}};
    }});
  const grant={issuer,audience,action:'candidate.upload',entryId:input.entryId,candidateRevision:1,authorityEpoch:1,binding,
    requestHash:receipt.requestHash,sourceSnapshotHash:receipt.sourceSnapshotHash,requestBytes:receipt.requestBytes,
    idempotencyKey:'pubcandidate_'+'c'.repeat(32),token:'pubupload_'+'b'.repeat(64),expiresAt:new Date(Date.now()+90000).toISOString()};
  const uploader=()=>new PublicationCandidateUploader({runtimeRoot:root,enabled:true,issuer,audience},
    {requestImpl:(url,o,cb)=>https.request(url,{...o,ca:tls.cert},cb)});
  const first=await uploader().upload(input,grant,()=>{});assert.equal(first.created,true);
  await fs.rm(source,{recursive:true});
  const second=await uploader().upload(input,grant,()=>{});assert.equal(second.created,false);assert.deepEqual(first.association,second.association);
  assert.equal(calls,2);assert.equal(checks,2);
  console.log(`[upload-contract] real capture/uploader and Cloud ${revision} HTTPS handler: initial/restart replay passed. Authority and DB are explicit test adapters; no live E2E.`);
}finally{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  await tls?.close();await fs.rm(root,{recursive:true,force:true});
}
