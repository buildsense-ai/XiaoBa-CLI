import {test,before,after,beforeEach,afterEach} from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as https from 'node:https';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createCatsCoLocalConfigService} from '../src/catscompany/local-config';
import {BotSkillWorkspaceService} from '../src/bot-skills/workspace';
import {PublicationCaptureStore,type PublicationCaptureInput} from '../src/skillhub/publication-capture';
import {describePublicationSource} from '../src/skillhub/publication-source';
import {PublicationCandidateUploader,type PublicationUploadGrant} from '../src/skillhub/publication-upload';

let certRoot:string,tls:{key:Buffer;cert:Buffer},root:string,input:PublicationCaptureInput,grant:PublicationUploadGrant;
let store:PublicationCaptureStore,server:https.Server,origin:string,requests:any[],respond:(req:any,res:any,bytes:Buffer)=>void;
const check=()=>{};
before(()=>{
  certRoot=fs.mkdtempSync(path.join(os.tmpdir(),'publication-upload-tls-'));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=localhost',
    '-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-keyout',path.join(certRoot,'key.pem'),'-out',path.join(certRoot,'cert.pem')],{stdio:'pipe',timeout:15000});
  tls={key:fs.readFileSync(path.join(certRoot,'key.pem')),cert:fs.readFileSync(path.join(certRoot,'cert.pem'))};
});
after(()=>fs.rmSync(certRoot,{recursive:true,force:true}));
beforeEach(async()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'publication-upload-'));
  const skills=path.join(root,'skills'),source=path.join(skills,'demo');fs.mkdirSync(source,{recursive:true});
  fs.writeFileSync(path.join(source,'SKILL.md'),'---\nname: upload-test\ndescription: fixture\n---\nPrivate source');
  fs.writeFileSync(path.join(source,'binary.bin'),Buffer.from([0,255,128,13,10]));
  new BotSkillWorkspaceService(root,skills).activate('42');
  const binding={botUid:'42',ownerUid:'7',bodyId:'body-42',installationId:'install-42'};
  createCatsCoLocalConfigService({runtimeRoot:root}).save({version:1,currentBot:{uid:'42',apiKey:'test',boundByUserUid:'7'},
    account:{uid:'7',username:'fixture',token:'test'},device:{bodyId:binding.bodyId,installationId:binding.installationId}});
  input={entryId:'pubentry_'+'a'.repeat(32),binding,source:describePublicationSource(skills,source,binding)};
  store=new PublicationCaptureStore({runtimeRoot:root,enabled:true});const receipt=await store.capture(input,check);
  requests=[];
  server=https.createServer(tls,(req,res)=>{
    const chunks:Buffer[]=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{
      const bytes=Buffer.concat(chunks);requests.push({url:req.url,headers:req.headers,bytes});respond(req,res,bytes);
    });
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`https://127.0.0.1:${(server.address() as any).port}`;
  grant={issuer:'https://cats.example',audience:origin,action:'candidate.upload',entryId:input.entryId,candidateRevision:1,authorityEpoch:1,
    binding:{...binding},requestHash:receipt.requestHash,sourceSnapshotHash:receipt.sourceSnapshotHash,requestBytes:receipt.requestBytes,
    idempotencyKey:'pubcandidate_'+'b'.repeat(32),token:'pubupload_'+'c'.repeat(64),expiresAt:new Date(Date.now()+90000).toISOString()};
  respond=(_req,res)=>{res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify(reply()));};
});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});});
function reply(){return {schemaVersion:1,accepted:true,created:true,association:{taskId:'pubtask_12345678-1234-4123-8123-123456789abc',
  entryRequestId:input.entryId,candidateRevision:1,candidateHash:grant.sourceSnapshotHash,requestHash:grant.requestHash,authorityEpoch:1,
  eventId:'pubevent_12345678-1234-4123-8123-123456789abc',state:'delegated_pending',candidateAvailable:true}};}
function uploader(extra:any={},deps:any={}){
  return new PublicationCandidateUploader({runtimeRoot:root,enabled:true,issuer:'https://cats.example',audience:origin,...extra},
    {requestImpl:((url:any,options:any,callback:any)=>https.request(url,{...options,ca:tls.cert},callback)) as typeof https.request,...deps});
}
function code(expected?:string){return (e:any)=>{assert.equal(e.name,'PublicationUploadError');if(expected)assert.equal(e.code,'publication.upload_'+expected);
  assert.ok(!String(e).includes(root));assert.ok(!String(e).includes(grant.token));assert.equal(e.cause,undefined);return true;};}

test('uploader uses frozen private bytes, pinned HTTPS path, exact scope headers; no source reread or mutation',async()=>{
  const frozen=await store.readRequest(input,check);
  fs.rmSync(path.join(root,'skills','demo'),{recursive:true});
  const result=await uploader().upload(input,grant,check);
  assert.deepEqual(result,reply());assert.equal(requests.length,1);assert.deepEqual(requests[0].bytes,frozen);
  assert.equal(requests[0].url,'/api/skills/publication-delegations/candidates');
  assert.equal(requests[0].headers.authorization,'Bearer '+grant.token);assert.equal(requests[0].headers['idempotency-key'],grant.idempotencyKey);
  assert.equal(requests[0].headers.cookie,undefined);assert.equal(requests[0].headers['x-publication-entry'],input.entryId);
  assert.ok(!JSON.stringify(result).includes(grant.token));
});
test('default off, canonical config, malformed grants, wrong identity and digest never send',async()=>{
  await assert.rejects(uploader({enabled:false}).upload(input,grant,check),code('disabled'));
  for(const audience of ['http://bad','https://example.com/path','https://u:p@example.com','https://EXAMPLE.com','https://cats.example'])
    await assert.rejects(uploader({audience}).upload(input,grant,check),code('configuration'));
  for(const patch of [{token:123},{authorityEpoch:0},{authorityEpoch:9},{url:origin},{action:'commit'},
    {binding:{...grant.binding,ownerUid:'8'}},{requestHash:'f'.repeat(64)},{sourceSnapshotHash:'f'.repeat(64)},
    {requestBytes:grant.requestBytes+1},{expiresAt:new Date(0).toISOString()},{expiresAt:new Date(Date.now()+180000).toISOString()}])
    await assert.rejects(uploader().upload(input,{...grant,...patch} as any,check),code());
  assert.equal(requests.length,0);
});
test('missing/tampered capture and lost live binding do not recapture or upload',async()=>{
  const local=createCatsCoLocalConfigService({runtimeRoot:root}),saved=local.load();
  local.save({...saved,currentBot:{...saved.currentBot!,boundByUserUid:'8'}});
  await assert.rejects(uploader().upload(input,grant,check),code());local.save(saved);
  const file=path.join(root,'data','skillhub-publications',input.entryId+'.json');fs.writeFileSync(file,'broken',{mode:0o600});
  await assert.rejects(uploader().upload(input,grant,check),code());fs.unlinkSync(file);
  await assert.rejects(uploader().upload(input,grant,check),code());assert.equal(requests.length,0);assert.ok(!fs.existsSync(file));
});
test('authority guard is mandatory synchronous, abort/expiry stop work; errors never retain secrets',async()=>{
  for(const guard of [undefined,()=>{throw Error(grant.token+root);},async()=>{throw Error(grant.token);}])
    await assert.rejects(uploader().upload(input,grant,guard as any),code());
  const c=new AbortController();c.abort();await assert.rejects(uploader().upload(input,grant,check,c.signal),code('inactive'));
  assert.equal(requests.length,0);
});
test('trusted CA required; redirects do not forward token, no automatic retry, static HTTP failures',async()=>{
  await assert.rejects(uploader({}, {requestImpl:https.request}).upload(input,grant,check),code());assert.equal(requests.length,0);
  for(const [status,kind] of [[302,'unavailable'],[400,'invalid'],[401,'inactive'],[403,'inactive'],[409,'conflict'],[413,'limit'],[422,'rejected'],[429,'busy'],[503,'unavailable']] as const){
    const before=requests.length;respond=(_req,res)=>{res.writeHead(status,{Location:'https://not-contacted.invalid','Content-Type':'application/json'});res.end(grant.token);};
    await assert.rejects(uploader().upload(input,grant,check),code(kind));assert.equal(requests.length,before+1);
  }
});
test('exact replay after dropped response sends same bytes/key; cancelled replay is not success publication',async()=>{
  respond=(_req,res)=>res.destroy();await assert.rejects(uploader().upload(input,grant,check),code());
  const expected={...reply(),created:false,association:{...reply().association,state:'cancelled',candidateAvailable:false}};
  respond=(_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(expected));};
  const renewed={...grant,authorityEpoch:2,token:'pubupload_'+'d'.repeat(64)};
  assert.deepEqual(await uploader().upload(input,renewed,check),expected);
  assert.equal(requests.length,2);assert.deepEqual(requests[0].bytes,requests[1].bytes);
  assert.equal(requests[0].headers['idempotency-key'],requests[1].headers['idempotency-key']);
});
test('bounded strict response rejects mismatches, duplicate escaped keys, unknown fields and invalid UTF-8',async()=>{
  const base=reply();
  const invalid=[{...base,secret:grant.token},{...base,accepted:false},{...base,created:false},
    {...base,association:{...base.association,entryRequestId:'pubentry_'+'f'.repeat(32)}},
    {...base,association:{...base.association,authorityEpoch:2}},
    {...base,association:{...base.association,state:'cancelled'}},
    JSON.stringify(base).replace('"schemaVersion":1','"schemaVersion":0,"schema\\u0056ersion":1'),
    JSON.stringify(base).replace('"candidateRevision":1','"candidateRevision":0,"candidateRevision":1'),
    Buffer.from([255]),'x'.repeat(8193)];
  for(const item of invalid){
    respond=(_req,res)=>{res.writeHead(201,{'Content-Type':'application/json'});res.end(Buffer.isBuffer(item)||typeof item==='string'?item:JSON.stringify(item));};
    await assert.rejects(uploader().upload(input,grant,check),code('protocol'));
  }
  for(const headers of [{'Content-Type':'text/html'},{'Content-Type':'application/json','Content-Encoding':'gzip'},{'Content-Type':'application/json','Content-Length':'8193'}]){
    respond=(_req,res)=>{res.writeHead(201,headers);res.end('{}');};await assert.rejects(uploader().upload(input,grant,check),code('protocol'));
  }
});
test('timeout, abort and two-slot admission cover stalled response without workspace lock',async()=>{
  respond=()=>{};
  const client=uploader({}, {timeoutMs:5000}),a=client.upload(input,grant,check),b=client.upload(input,grant,check);
  const settled=Promise.allSettled([a,b]);
  await assert.rejects(client.upload(input,grant,check),code('busy'));
  // Candidate reads succeed while HTTP is pending: no workspace lock held.
  assert.deepEqual(await store.readRequest(input,check),(await store.readCandidate(input,check)).bytes);
  for(const r of await settled){assert.equal(r.status,'rejected');if(r.status==='rejected')code('timeout')(r.reason);}
  const c=new AbortController();const pending=client.upload(input,grant,check,c.signal);await delay(15);c.abort();
  await assert.rejects(pending,code('inactive'));
});
test('caller mutation during private read cannot change bytes, credential, route or source',async()=>{
  const g={...grant,binding:{...grant.binding}},i={...input,binding:{...input.binding},source:{...input.source}};
  const pending=uploader().upload(i,g,check);g.token='pubupload_'+'f'.repeat(64);g.binding.ownerUid='8';i.source.local_skill_id='pubsrc-'+'f'.repeat(48);
  await pending;assert.equal(requests[0].headers.authorization,'Bearer '+grant.token);
});
