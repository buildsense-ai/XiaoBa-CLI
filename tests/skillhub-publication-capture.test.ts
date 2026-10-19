import { afterEach, beforeEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';
import { withBotSkillWorkspaceLock } from '../src/bot-skills/lock';
import { PublicationCaptureStore, type PublicationCaptureInput } from '../src/skillhub/publication-capture';
import { describePublicationSource, PublicationSourceError } from '../src/skillhub/publication-source';

let root: string, skills: string, source: string, spool: string;
const binding = { botUid:'42', ownerUid:'7', bodyId:'body-42', installationId:'install-42' };
const check = () => {};
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
beforeEach(() => {
  root=fs.mkdtempSync(path.join(os.tmpdir(),'publication-capture-'));
  skills=path.join(root,'skills');source=path.join(skills,'demo');spool=path.join(root,'data','skillhub-publications');
  fs.mkdirSync(source,{recursive:true});fs.writeFileSync(path.join(source,'SKILL.md'),'---\nname: demo\ndescription: demo\n---\n# Demo');
  new BotSkillWorkspaceService(root,skills).activate('42');
  createCatsCoLocalConfigService({runtimeRoot:root}).save({version:1,
    currentBot:{uid:'42',apiKey:'test',boundByUserUid:'7'},account:{uid:'7',username:'owner',token:'test'},
    device:{bodyId:binding.bodyId,installationId:binding.installationId,deviceId:'legacy'}});
});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
const store = () => new PublicationCaptureStore({runtimeRoot:root,enabled:true});
function input(): PublicationCaptureInput {return {entryId:'pubentry_'+'a'.repeat(32),binding:{...binding},source:describePublicationSource(skills,source,binding)};}
function code(value: string){return (e:any)=>{assert.equal(e.code,value);assert.ok(!e.message.includes(root));assert.ok(!e.message.includes('private-secret'));return true;};}

test('default off, explicit authority checks, no hidden transport or source mutation',async()=>{
  const before=fs.readFileSync(path.join(source,'SKILL.md'));const in_=input();
  await assert.rejects(new PublicationCaptureStore({runtimeRoot:root}).capture(in_,check),code('publication.runtime_unsupported'));
  await assert.rejects(store().capture(in_,()=>{throw Error('private-secret '+root);}),code('publication.runtime_unavailable'));
  await assert.rejects(store().capture(in_,async()=>{}),code('publication.capture_invalid'));
  assert.ok(!fs.existsSync(spool));
  const receipt=await store().capture(in_,check);
  assert.deepEqual(Object.keys(receipt).sort(),['candidateRevision','entryId','requestBytes','requestHash','schemaVersion','sourceSnapshotHash']);
  assert.deepEqual(fs.readFileSync(path.join(source,'SKILL.md')),before);
  assert.deepEqual(fs.readdirSync(source),['SKILL.md']);
  const bytes=await store().readRequest(in_,check);assert.equal(hash(bytes),receipt.requestHash);assert.equal(bytes.length,receipt.requestBytes);
  assert.ok(!JSON.stringify(receipt).includes(root));
});

test('frozen raw binary and invalid metadata survive restart and source removal',async()=>{
  const malformed='---js\nthrow new Error("never execute")\n---\nprivate-secret';
  fs.writeFileSync(path.join(source,'SKILL.md'),malformed);
  fs.writeFileSync(path.join(source,'bytes.bin'),Buffer.from([0,255,128,13,10]));
  fs.mkdirSync(path.join(source,'.venv'));fs.writeFileSync(path.join(source,'.venv','excluded'),'not packaged');
  const in_=input();const receipt=await store().capture(in_,check);const before=await store().readRequest(in_,check);
  const files=JSON.parse(before.toString()).source.files;
  assert.deepEqual(files.map((f:any)=>f.path),['SKILL.md','bytes.bin']);
  assert.equal(Buffer.from(files[0].contentBase64,'base64').toString(),malformed);
  assert.deepEqual(Buffer.from(files[1].contentBase64,'base64'),Buffer.from([0,255,128,13,10]));
  fs.rmSync(source,{recursive:true});
  assert.deepEqual(await store().capture(in_,check),receipt);assert.deepEqual(await store().readRequest(in_,check),before);
  assert.equal(fs.readdirSync(spool).length,1);
});

test('entry reuse cannot replace source or principal and changed sources do not freeze',async()=>{
  const in_=input();fs.appendFileSync(path.join(source,'SKILL.md'),'changed');
  await assert.rejects(store().capture(in_,check),code('publication.source_changed'));
  assert.deepEqual(fs.readdirSync(spool),[]);
  const fresh=input();await store().capture(fresh,check);
  fs.appendFileSync(path.join(source,'SKILL.md'),'again');
  await assert.rejects(store().capture(input(),check),code('publication.capture_conflict'));
  const other={...fresh,binding:{...binding,ownerUid:'8'}};
  await assert.rejects(store().readRequest(other,check),code('publication.capture_conflict'));
  const config=createCatsCoLocalConfigService({runtimeRoot:root});const saved=config.load();
  config.save({...saved,currentBot:{...saved.currentBot!,boundByUserUid:'8'}});
  await assert.rejects(store().readRequest(fresh,check),code('publication.capture_conflict'));
});

test('concurrent capture serializes and freezes one exact request',async()=>{
  const in_=input();const results=await Promise.all([store().capture(in_,check),store().capture(in_,check),store().capture(in_,check)]);
  assert.deepEqual(results,[results[0],results[0],results[0]]);assert.equal(fs.readdirSync(spool).length,1);
});

test('input is copied before waiting and active binding is checked after the lock',async()=>{
  const in_=input();let release!:()=>void;let entered!:()=>void;
  const ready=new Promise<void>(r=>entered=r);const hold=new Promise<void>(r=>release=r);
  const locked=withBotSkillWorkspaceLock(root,async()=>{entered();await hold;});await ready;
  const pending=store().capture(in_,check);in_.source.workspace_generation='b'.repeat(64);release();await locked;
  const result=await pending;assert.equal(result.entryId,in_.entryId);
  const config=createCatsCoLocalConfigService({runtimeRoot:root});const saved=config.load();
  let calls=0;
  await assert.rejects(store().readRequest(input(),()=>{if(++calls===2)config.save({...saved,currentBot:{...saved.currentBot!,boundByUserUid:'8'}});}),code('publication.capture_conflict'));
});

test('torn or edited durable bytes are not silently recaptured',async()=>{
  const in_=input();await store().capture(in_,check);const file=path.join(spool,in_.entryId+'.json');
  const original=fs.readFileSync(file,'utf8');const saved=JSON.parse(original);
  saved.requestBody=saved.requestBody.replace('SKILL.md','other.md');fs.writeFileSync(file,JSON.stringify(saved));
  await assert.rejects(store().readRequest(in_,check),code('publication.capture_unsafe'));
  fs.writeFileSync(file,'{');await assert.rejects(store().capture(in_,check),code('publication.runtime_unavailable'));
  assert.equal(fs.readFileSync(file,'utf8'),'{');
});

test('source links, hardlinks and private store links fail closed',async(t)=>{
  const in_=input();const outside=path.join(root,'outside');fs.writeFileSync(outside,'private-secret');
  fs.linkSync(outside,path.join(source,'linked'));
  await assert.rejects(store().capture(in_,check),code('publication.source_unsafe'));fs.unlinkSync(path.join(source,'linked'));
  const fresh=input();await store().capture(fresh,check);const file=path.join(spool,fresh.entryId+'.json');
  fs.linkSync(file,path.join(root,'second-link'));
  await assert.rejects(store().readRequest(fresh,check),code('publication.capture_unsafe'));fs.unlinkSync(path.join(root,'second-link'));
  if(process.platform==='win32'){t.diagnostic('POSIX symlink/mode assertions run in mandatory Linux CI');return;}
  fs.chmodSync(file,0o644);await assert.rejects(store().readRequest(fresh,check),code('publication.capture_unsafe'));fs.chmodSync(file,0o600);
  const parked=spool+'-parked';fs.renameSync(spool,parked);fs.symlinkSync(parked,spool,'dir');
  await assert.rejects(store().readRequest(fresh,check),code('publication.capture_unsafe'));
});

test('bounded file count, bytes, paths and retained pending quota',async()=>{
  for(let n=0;n<500;n++)fs.writeFileSync(path.join(source,`f${n}`),'');
  await assert.rejects(store().capture(input(),check),code('publication.capture_limit'));
  for(let n=0;n<500;n++)fs.unlinkSync(path.join(source,`f${n}`));
  fs.writeFileSync(path.join(source,'huge'),Buffer.alloc(5*1024*1024+1));
  await assert.rejects(store().capture({...inputWithoutDescribe()},check),code('publication.source_unsafe'));
  fs.unlinkSync(path.join(source,'huge'));
  fs.writeFileSync(path.join(source,'a'.repeat(181)),'');
  await assert.rejects(store().capture(input(),check),code('publication.capture_unsafe'));fs.unlinkSync(path.join(source,'a'.repeat(181)));
  for(let n=0;n<32;n++)fs.writeFileSync(path.join(spool,'.pending-'+n.toString(16).padStart(32,'0')),'retained',{mode:0o600});
  await assert.rejects(store().capture(input(),check),code('publication.capture_limit'));
  assert.equal(fs.readdirSync(spool).length,32,'never auto-delete retained evidence');
});
function inputWithoutDescribe():PublicationCaptureInput {return {entryId:'pubentry_'+'a'.repeat(32),binding:{...binding},source:{local_skill_id:'pubsrc-'+hash('demo').slice(0,48),workspace_generation:'b'.repeat(64)}};}

test('mid-capture changes or lost authority leave no committed candidate',async()=>{
  const in_=input();let checks=0;
  await assert.rejects(store().capture(in_,()=>{if(++checks===6)throw new PublicationSourceError('publication.runtime_unavailable');}),code('publication.runtime_unavailable'));
  if(fs.existsSync(spool))assert.deepEqual(fs.readdirSync(spool),[]);
});

test('Cloud v1 canonical candidate hash golden vector, not workspace generation',async()=>{
  fs.writeFileSync(path.join(source,'SKILL.md'),'hello');const in_=input();const receipt=await store().capture(in_,check);
  // Object keys are byte-sorted: domain,files,manifest; file keys path,sha256,size.
  const canonical='{"domain":"skillhub-publish-candidate-v1","files":[{"path":"SKILL.md","sha256":"'+hash('hello')+'","size":5}],"manifest":{}}';
  assert.equal(receipt.sourceSnapshotHash,hash(canonical));assert.notEqual(receipt.sourceSnapshotHash,in_.source.workspace_generation);
});

test('write interruption before and after rename recovers without changing bytes',async(t)=>{
  const in_=input();const native=require('fs');const rename=native.renameSync;
  const mocked=t.mock.method(native,'renameSync',(...args:any[])=>{
    if(String(args[0]).includes('.pending-'))throw Error('private-secret storage failure');
    return rename(...args);
  });
  await assert.rejects(store().capture(in_,check),code('publication.runtime_unavailable'));
  assert.deepEqual(fs.readdirSync(spool),[]);mocked.mock.restore();
  const moved=t.mock.method(native,'renameSync',(...args:any[])=>{
    const result=rename(...args);
    if(String(args[0]).includes('.pending-'))throw Error('uncertain rename completion');
    return result;
  });
  await assert.rejects(store().capture(in_,check),code('publication.runtime_unavailable'));
  moved.mock.restore();
  assert.deepEqual(fs.readdirSync(spool),[in_.entryId+'.json']);
  const receipt=await store().capture(in_,check);
  assert.equal(receipt.requestHash,hash(await store().readRequest(in_,check)));
});

test('aggregate disk quota includes interrupted captures without allocating their bytes',async()=>{
  const in_=input();await store().capture(in_,check);
  for(let n=0;n<8;n++){
    const f=path.join(spool,'.pending-'+n.toString(16).padStart(32,'0'));
    const fd=fs.openSync(f,'wx',0o600);try{fs.ftruncateSync(fd,32*1024*1024);}finally{fs.closeSync(fd);}
  }
  await assert.rejects(store().capture({...in_,entryId:'pubentry_'+'b'.repeat(32)},check),code('publication.capture_limit'));
  assert.equal(fs.readdirSync(spool).length,9);
  assert.equal((await store().capture(in_,check)).entryId,in_.entryId,'quota cannot hide already frozen evidence');
});
