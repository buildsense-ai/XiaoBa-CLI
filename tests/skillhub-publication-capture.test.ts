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

test('strict input shape rejects coercion and extra identity fields before filesystem work',async()=>{
  const good=input();
  for(const invalid of [{...good,entryId:[good.entryId]},{...good,entryId:1},{...good,token:'not authority'},
    {...good,binding:{...binding,ownerUid:7}},{...good,source:{...good.source,path:source}}]){
    await assert.rejects(store().capture(invalid as any,check),code('publication.capture_invalid'));
  }
  assert.ok(!fs.existsSync(spool));
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

test('binding JSON property order does not invalidate the existing probe generation',async()=>{
  const in_=input();const reordered={...in_,binding:{installationId:binding.installationId,bodyId:binding.bodyId,ownerUid:binding.ownerUid,botUid:binding.botUid}};
  const receipt=await store().capture(reordered,check);
  assert.deepEqual(await store().capture(in_,check),receipt);
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

test('repair preparation returns the exact frozen bytes without parsing or changing the Skill',async()=>{
  const malformed='---js\nthrow new Error("private-secret must never execute")\n---\n# Original';
  fs.writeFileSync(path.join(source,'SKILL.md'),malformed);
  fs.writeFileSync(path.join(source,'bytes.bin'),Buffer.from([255,0,128,13,10]));
  const in_=input();const receipt=await store().capture(in_,check);
  const original=await store().readRequest(in_,check);
  const evidence=fs.readFileSync(path.join(spool,in_.entryId+'.json'));
  const candidate=await store().readRepairCandidate(in_,receipt,check);
  assert.deepEqual(candidate,{receipt,bytes:original});
  assert.deepEqual(fs.readFileSync(path.join(spool,in_.entryId+'.json')),evidence);
  assert.equal(fs.readFileSync(path.join(source,'SKILL.md'),'utf8'),malformed);
  assert.deepEqual(fs.readdirSync(source).sort(),['SKILL.md','bytes.bin']);
  assert.deepEqual(fs.readdirSync(spool),[in_.entryId+'.json']);
  // A returned buffer is not a reference to durable evidence.
  candidate.bytes.fill(0);
  assert.deepEqual((await store().readRepairCandidate(in_,receipt,check)).bytes,original);
});

test('repair preparation requires the exact trusted receipt before any source read',async()=>{
  const in_=input();const receipt=await store().capture(in_,check);
  const file=path.join(spool,in_.entryId+'.json');const original=fs.readFileSync(file);
  for(const field of ['sourceSnapshotHash','requestHash','requestBytes'] as const){
    const wrong={...receipt,[field]:field==='requestBytes'?receipt.requestBytes+1:'f'.repeat(64)};
    await assert.rejects(store().readRepairCandidate(in_,wrong,check),code('publication.repair_capture_mismatch'));
  }
  for(const wrong of [null,{}, {...receipt,entryId:'pubentry_'+'b'.repeat(32)},
    {...receipt,candidateRevision:2},{...receipt,schemaVersion:2},{...receipt,requestBytes:'1'},
    {...receipt,requestBytes:0},{...receipt,requestBytes:32*1024*1024+1},
    {...receipt,requestHash:'invalid'},{...receipt,sourceSnapshotHash:'F'.repeat(64)},
    {...receipt,approval:true}]){
    await assert.rejects(store().readRepairCandidate(in_,wrong as any,check),code('publication.repair_invalid'));
  }
  assert.deepEqual(fs.readFileSync(file),original);
});

test('repair preparation never captures a missing or deleted snapshot',async()=>{
  const in_=input();
  const receipt={schemaVersion:1 as const,entryId:in_.entryId,candidateRevision:1 as const,
    sourceSnapshotHash:'a'.repeat(64),requestHash:'b'.repeat(64),requestBytes:1};
  await assert.rejects(store().readRepairCandidate(in_,receipt,check),code('publication.repair_capture_missing'));
  assert.deepEqual(fs.readdirSync(spool),[]);
  const captured=await store().capture(in_,check);
  fs.unlinkSync(path.join(spool,in_.entryId+'.json'));
  await assert.rejects(store().readRepairCandidate(in_,captured,check),code('publication.repair_capture_missing'));
  assert.deepEqual(fs.readdirSync(spool),[]);
});

test('repair preparation rejects changed live text or binary while upload replay retains original bytes',async()=>{
  fs.writeFileSync(path.join(source,'bytes.bin'),Buffer.from([0,1,255]));
  const in_=input();const receipt=await store().capture(in_,check);
  const original=await store().readRequest(in_,check);
  fs.appendFileSync(path.join(source,'SKILL.md'),'changed');
  await assert.rejects(store().readRepairCandidate(in_,receipt,check),code('publication.source_changed'));
  assert.deepEqual(await store().readRequest(in_,check),original);
  // A newer descriptor for the same name/entry cannot select new content.
  await assert.rejects(store().readRepairCandidate(input(),receipt,check),code('publication.capture_conflict'));
  fs.writeFileSync(path.join(source,'SKILL.md'),'---\nname: demo\ndescription: demo\n---\n# Demo');
  fs.writeFileSync(path.join(source,'bytes.bin'),Buffer.from([0,2,255]));
  await assert.rejects(store().readRepairCandidate(in_,receipt,check),code('publication.source_changed'));
});

test('repair preparation does not choose a same-named Skill after source removal',async()=>{
  const in_=input();const receipt=await store().capture(in_,check);
  const original=await store().readRequest(in_,check);
  const elsewhere=path.join(skills,'other');fs.mkdirSync(elsewhere);
  fs.copyFileSync(path.join(source,'SKILL.md'),path.join(elsewhere,'SKILL.md'));
  fs.rmSync(source,{recursive:true});
  await assert.rejects(store().readRepairCandidate(in_,receipt,check),code('publication.source_missing'));
  assert.deepEqual(await store().readRequest(in_,check),original);
  fs.renameSync(elsewhere,source);
  await assert.rejects(store().readRepairCandidate(in_,receipt,check),code('publication.source_changed'));
});

test('repair preparation retains default-off and synchronous authority boundaries',async()=>{
  const in_=input();const receipt=await store().capture(in_,check);
  await assert.rejects(new PublicationCaptureStore({runtimeRoot:root}).readRepairCandidate(in_,receipt,check),code('publication.runtime_unsupported'));
  await assert.rejects(store().readRepairCandidate(in_,receipt,async()=>{}),code('publication.capture_invalid'));
  await assert.rejects(store().readRepairCandidate(in_,receipt,()=>{throw Error('private-secret '+root);}),code('publication.runtime_unavailable'));
  let checks=0;
  await assert.rejects(store().readRepairCandidate(in_,receipt,()=>{if(++checks===6)throw new PublicationSourceError('publication.runtime_unavailable');}),code('publication.runtime_unavailable'));
  assert.equal(checks,6);
});

test('repair preparation rechecks current Bot owner, body, installation and workspace',async()=>{
  const in_=input();const receipt=await store().capture(in_,check);
  const config=createCatsCoLocalConfigService({runtimeRoot:root});const saved=config.load();
  const changes=[
    {...saved,currentBot:{...saved.currentBot!,uid:'43'}},
    {...saved,currentBot:{...saved.currentBot!,boundByUserUid:'8'}},
    {...saved,device:{...saved.device!,bodyId:'other-body'}},
    {...saved,device:{...saved.device!,installationId:'other-installation'}},
  ];
  for(const changed of changes){
    config.save(changed);
    await assert.rejects(store().readRepairCandidate(in_,receipt,check),code('publication.capture_conflict'));
    config.save(saved);
  }
  new BotSkillWorkspaceService(root,skills).activate('43');
  await assert.rejects(store().readRepairCandidate(in_,receipt,check),code('publication.runtime_unavailable'));
});

test('repair preparation copies its source and receipt before waiting for the workspace lock',async()=>{
  const in_=input();const originalInput=structuredClone(in_);const receipt=await store().capture(in_,check);
  const originalReceipt={...receipt};
  let release!:()=>void;let entered!:()=>void;
  const ready=new Promise<void>(r=>entered=r);const hold=new Promise<void>(r=>release=r);
  const locked=withBotSkillWorkspaceLock(root,async()=>{entered();await hold;});await ready;
  const pending=store().readRepairCandidate(in_,receipt,check);
  in_.source.workspace_generation='f'.repeat(64);in_.binding.ownerUid='8';receipt.requestHash='f'.repeat(64);
  release();await locked;
  assert.deepEqual((await pending).receipt,originalReceipt);
  assert.deepEqual((await store().readRepairCandidate(originalInput,originalReceipt,check)).receipt,originalReceipt);
});

test('repair preparation checks source and authority after waiting for the workspace lock',async()=>{
  const in_=input();const receipt=await store().capture(in_,check);
  for(const change of ['source','authority']){
    let release!:()=>void;let entered!:()=>void;
    const ready=new Promise<void>(r=>entered=r);const hold=new Promise<void>(r=>release=r);
    const locked=withBotSkillWorkspaceLock(root,async()=>{entered();await hold;});await ready;
    let authorized=true;
    const pending=store().readRepairCandidate(in_,receipt,()=>{if(!authorized)throw new PublicationSourceError('publication.runtime_unavailable');});
    if(change==='source')fs.appendFileSync(path.join(source,'SKILL.md'),'changed under lock');
    else authorized=false;
    release();await locked;
    await assert.rejects(pending,code(change==='source'?'publication.source_changed':'publication.runtime_unavailable'));
  }
});

test('repair preparation rejects retained evidence corruption and never replaces it',async()=>{
  const in_=input();const receipt=await store().capture(in_,check);
  const file=path.join(spool,in_.entryId+'.json');const original=fs.readFileSync(file,'utf8');
  for(const value of ['{',JSON.stringify({...JSON.parse(original),receipt:{...receipt,requestHash:'f'.repeat(64)}})]){
    fs.writeFileSync(file,value);
    await assert.rejects(store().readRepairCandidate(in_,receipt,check));
    assert.equal(fs.readFileSync(file,'utf8'),value);
  }
});

test('repair preparation rejects new source hardlinks and store hardlinks',async()=>{
  const in_=input();const receipt=await store().capture(in_,check);
  const outside=path.join(root,'outside');fs.writeFileSync(outside,'private-secret');
  fs.linkSync(outside,path.join(source,'linked'));
  await assert.rejects(store().readRepairCandidate(in_,receipt,check),code('publication.source_unsafe'));
  fs.unlinkSync(path.join(source,'linked'));
  const file=path.join(spool,in_.entryId+'.json');
  fs.linkSync(file,path.join(root,'linked-evidence'));
  await assert.rejects(store().readRepairCandidate(in_,receipt,check),code('publication.capture_unsafe'));
});

test('repair preparation preserves binding normalization and fresh check after source inspection',async(t)=>{
  const in_=input();const receipt=await store().capture(in_,check);
  const reordered={...in_,binding:{installationId:binding.installationId,bodyId:binding.bodyId,ownerUid:binding.ownerUid,botUid:binding.botUid}};
  assert.deepEqual((await store().readRepairCandidate(reordered,receipt,check)).receipt,receipt);
  const native=require('fs');const read=native.readSync;
  const config=createCatsCoLocalConfigService({runtimeRoot:root});const saved=config.load();
  let changed=false;
  t.mock.method(native,'readSync',(...args:any[])=>{
    const result=read(...args);
    // Source inspection uses 64 KiB buffers; mutate binding after live IO.
    if(!changed && args[1]?.length===64*1024){changed=true;config.save({...saved,currentBot:{...saved.currentBot!,boundByUserUid:'8'}});}
    return result;
  });
  await assert.rejects(store().readRepairCandidate(in_,receipt,check),code('publication.capture_conflict'));
  assert.equal(changed,true);
});
