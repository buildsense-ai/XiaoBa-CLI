import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { MondayMemoryUploader, nextMemoryScan, mondayMemoryConfig } from '../src/utils/monday-memory-uploader';

test('uses 03/15 Beijing regardless of host timezone and enables its independent keyless uploader by default', () => {
  assert.equal(new Date(nextMemoryScan(Date.parse('2026-11-17T02:00:00+08:00'))).toISOString(), '2026-11-16T19:00:00.000Z');
  assert.equal(new Date(nextMemoryScan(Date.parse('2026-11-17T03:00:00+08:00'))).toISOString(), '2026-11-17T07:00:00.000Z');
  assert.ok(mondayMemoryConfig('/tmp/test', {}));
  assert.equal(mondayMemoryConfig('/tmp/test', {XIAOBA_MEMORY_UPLOAD_ENABLED:'false'}), undefined);
  assert.ok(mondayMemoryConfig('/tmp/test', {CATSCO_LOG_UPLOAD_ENABLED:'false', MONDAY_MEMORY_ENABLED:'false'}));
});
test('uploads all history, survives lost ACK/restart, then transfers only appended complete lines with a renamed bot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monday-uploader-'));
  const source = path.join(root, 'logs/sessions/cli/2026-11-16/cli_session.jsonl');
  await fs.mkdir(path.dirname(source), {recursive:true});
  const old = JSON.stringify({entry_type:'turn',user:{text:'history'},assistant:{text:'reply',tool_calls:[]}})+'\n';
  await fs.writeFile(source, old);
  const streams = new Map<string, Buffer>(), requests: unknown[] = [], manifests: {lane: string}[] = [];
  let drop = true;
  const server = createServer(async (req,res) => {
    if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({dataset_id:'test-v1'}));return;}
    const chunks: Buffer[]=[]; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    assert.equal(req.headers.authorization,undefined);
    const body=JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/bots/365/ingest/manifests') { manifests.push(body); res.end('{}'); return; }
    const raw=Buffer.concat(body.records.map((r:{raw_base64:string})=>Buffer.from(r.raw_base64,'base64')));
    const before=streams.get(body.stream_id)??Buffer.alloc(0);
    if(body.records[0].offset===before.length)streams.set(body.stream_id,Buffer.concat([before,raw]));
    else assert.equal(before.subarray(body.records[0].offset,body.records[0].offset+raw.length).equals(raw),true);
    if(drop){drop=false;req.socket.destroy();return;}
    res.end(JSON.stringify({next_offset:body.records[0].offset+raw.length,sha256:createHash('sha256').update(raw).digest('hex')}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); assert.ok(address&&typeof address==='object');
  const config={root,endpoint:`http://127.0.0.1:${address.port}`,bot:()=>({uid:'365',name:'Saturday'})};
  let uploader=new MondayMemoryUploader(config);
  try {
    await uploader.cycle(Date.parse('2026-11-17T03:00:00+08:00'));
    assert.equal(JSON.parse(await fs.readFile(path.join(root,'data/monday-memory-upload/state.json'),'utf8')).files['sessions/cli/2026-11-16/cli_session.jsonl'].backfill.offset,0);
    await uploader.stop();
    uploader=new MondayMemoryUploader({...config,bot:()=>({uid:'365',name:'Saturday renamed'})});
    await uploader.cycle(Date.parse('2026-11-17T04:00:00+08:00'));
    assert.equal([...streams.values()].reduce((n,b)=>n+b.length,0),Buffer.byteLength(old));
    const added=JSON.stringify({entry_type:'turn',user:{text:'new'},assistant:{text:'new reply',tool_calls:[]}})+'\n';
    await fs.appendFile(source,added+'{"partial":');
    await uploader.cycle(Date.parse('2026-11-17T15:00:00+08:00'));
    assert.equal([...streams.values()].reduce((n,b)=>n+b.length,0),Buffer.byteLength(old+added));
    assert.ok(manifests.some(m=>m.lane==='backfill'));assert.ok(manifests.some(m=>m.lane==='incremental'));
    const original=await fs.readFile(source,'utf8');assert.equal(original,old+added+'{"partial":');
    const state=JSON.parse(await fs.readFile(path.join(root,'data/monday-memory-upload/state.json'),'utf8'));
    assert.equal(state.files['sessions/cli/2026-11-16/cli_session.jsonl'].baseline,Buffer.byteLength(old));
    assert.equal(JSON.stringify(state).includes('Saturday renamed'),false);
    assert.ok(requests.some(r=>typeof r==='object'&&r!==null&&'bot_name' in r&&r.bot_name==='Saturday renamed'));
    await uploader.cycle(Date.parse('2026-11-17T16:00:00+08:00'));
    assert.ok(requests.length>0);
  } finally {await uploader.stop();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(root,{recursive:true,force:true});}
});

test('isolates a blocked file and a rewritten file while continuing other files in the same session', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'monday-file-errors-'));
  const name='cli_shared.jsonl',first=path.join(root,'logs/sessions/cli/2026-11-15',name),second=path.join(root,'logs/sessions/cli/2026-11-16',name);
  await fs.mkdir(path.dirname(first),{recursive:true});await fs.mkdir(path.dirname(second),{recursive:true});
  await fs.writeFile(first,JSON.stringify({large:'x'.repeat(1024*1024+5)})+'\n');await fs.writeFile(second,'{"normal":true}\n');
  const received:string[]=[];
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({dataset_id:'test-v1'}));return;}
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const body=JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type','application/json');if(req.url?.endsWith('manifests')){res.end('{}');return;}
    if(req.url?.endsWith('fragments')){res.statusCode=413;res.end('{}');return;}
    received.push(body.records[0].origin.path);
    const raw=Buffer.concat(body.records.map((r:{raw_base64:string})=>Buffer.from(r.raw_base64,'base64')));
    res.end(JSON.stringify({next_offset:body.records[0].offset+raw.length,sha256:createHash('sha256').update(raw).digest('hex')}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address==='object');
  const uploader=new MondayMemoryUploader({root,endpoint:`http://127.0.0.1:${address.port}`,bot:()=>({uid:'365',name:'Saturday'})});
  try{
    await uploader.cycle(Date.parse('2026-11-17T03:00:00+08:00'));
    assert.ok(received.some(p=>p.includes('2026-11-16')));
    const statePath=path.join(root,'data/monday-memory-upload/state.json');
    let state=JSON.parse(await fs.readFile(statePath,'utf8'));
    assert.match(state.files['sessions/cli/2026-11-15/'+name].error,/HTTP 413/);
    assert.equal(state.files['sessions/cli/2026-11-15/'+name].backfill.offset,0);
    await fs.writeFile(first,'{}\n');await fs.appendFile(second,'{"incremental":true}\n');
    await uploader.cycle(Date.parse('2026-11-17T15:00:00+08:00'));
    state=JSON.parse(await fs.readFile(statePath,'utf8'));
    assert.match(state.discovery_errors['sessions/cli/2026-11-15/'+name].message,/source rewritten/);
    assert.equal(state.files['sessions/cli/2026-11-16/'+name].incremental.offset,(await fs.stat(second)).size);
  }finally{await uploader.stop();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(root,{recursive:true,force:true});}
});

test('resends a large original record after a lost fragment ACK and advances only after whole-record ACK',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'monday-fragments-'));
  const file=path.join(root,'logs/sessions/cli/2026-11-16/cli_large.jsonl');await fs.mkdir(path.dirname(file),{recursive:true});
  const raw=Buffer.from(JSON.stringify({entry_type:'turn',user:{text:'large'},assistant:{text:'x'.repeat(2*1024*1024),tool_calls:[]}})+'\n');await fs.writeFile(file,raw);
  let stored=Buffer.alloc(0),drop=true;const origins:unknown[]=[];
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({dataset_id:'test-v1'}));return;}
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const body=JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type','application/json');if(req.url?.endsWith('manifests')){res.end('{}');return;}
    assert.ok(req.url?.endsWith('fragments'));const bytes=Buffer.from(body.raw_base64,'base64');origins.push(body.origin);
    if(body.fragment_offset===stored.length)stored=Buffer.concat([stored,bytes]);else assert.ok(stored.subarray(body.fragment_offset,body.fragment_offset+bytes.length).equals(bytes));
    if(drop){drop=false;req.socket.destroy();return;}
    res.end(JSON.stringify({next_fragment_offset:stored.length,...(stored.length===raw.length?{next_offset:raw.length,sha256:createHash('sha256').update(stored).digest('hex')}:{})}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address==='object');
  const config={root,endpoint:`http://127.0.0.1:${address.port}`,bot:()=>({uid:'365',name:'Saturday'})};let uploader=new MondayMemoryUploader(config);
  try{
    await uploader.cycle();await uploader.stop();uploader=new MondayMemoryUploader(config);await uploader.cycle();
    assert.ok(stored.equals(raw));assert.ok(origins.every(o=>JSON.stringify(o)===JSON.stringify({path:'sessions/cli/2026-11-16/cli_large.jsonl',offset:0})));
    const state=JSON.parse(await fs.readFile(path.join(root,'data/monday-memory-upload/state.json'),'utf8'));assert.equal(state.files['sessions/cli/2026-11-16/cli_large.jsonl'].backfill.offset,raw.length);
  }finally{await uploader.stop();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(root,{recursive:true,force:true});}
});

test('rejects corrupt nested cursors and manifest paths on restart before any network request',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'monday-corrupt-'));
  const config={root,endpoint:'http://127.0.0.1:1',bot:()=>({uid:'365',name:'Saturday'})};
  const statePath=path.join(root,'data/monday-memory-upload/state.json');await fs.mkdir(path.dirname(statePath),{recursive:true});
  const file='sessions/cli/2026-11-16/cli_test.jsonl';
  const base={version:2,endpoint:config.endpoint,dataset:'test-v1',source_id:'bot',last_discovery:1,files:{[file]:{bot_uid:'365',generation:'uuid',baseline:0,backfill:{offset:0,hash:'0'.repeat(64)},incremental:{offset:-1,hash:'0'.repeat(64)}}},manifests:[]};
  try{
    for(const state of [base,{...base,files:{},manifests:[{bot_uid:'365',manifest_id:'scan',session_key:'cli/x',lane:'backfill',registered:true,files:[{path:'../../outside',stream_id:'s',start:0,end:1,base:0}]}]}]){
      await fs.writeFile(statePath,JSON.stringify(state));const uploader=new MondayMemoryUploader(config);
      try{await assert.rejects(uploader.cycle(),/invalid Monday memory state/);}finally{await uploader.stop();}
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('reads the current local bot name dynamically without configuring an upload key or dataset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monday-bot-config-'));
  const file = path.join(root, '.xiaoba', 'catsco.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, JSON.stringify({ version: 1, currentBot: { uid: '365', name: 'Saturday' } }));
    const config = mondayMemoryConfig(root, {});
    assert.ok(config);
    assert.deepEqual(config.bot(), { uid: '365', name: 'Saturday' });
    await fs.writeFile(file, JSON.stringify({ version: 1, currentBot: { uid: '365', name: 'Saturday renamed' } }));
    assert.deepEqual(config.bot(), { uid: '365', name: 'Saturday renamed' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('routes historical files by recorded bot uid and retains fallback attribution for older files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monday-bot-routing-'));
  const folder = path.join(root, 'logs/sessions/cli/2026-11-16');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'cli_other.jsonl'), JSON.stringify({ agent_identity: { agent_id: 'usr366' }, entry_type: 'runtime' }) + '\n');
  await fs.writeFile(path.join(folder, 'cli_old.jsonl'), JSON.stringify({ entry_type: 'runtime' }) + '\n');
  const seen: { url: string; body: { bot_name?: string } }[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ dataset_id: 'bot-routing' })); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ url: req.url || '', body });
    if (req.url?.endsWith('manifests')) { res.end('{}'); return; }
    const raw = Buffer.concat(body.records.map((record: { raw_base64: string }) => Buffer.from(record.raw_base64, 'base64')));
    res.end(JSON.stringify({ next_offset: raw.length, sha256: createHash('sha256').update(raw).digest('hex') }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const uploader = new MondayMemoryUploader({ root, endpoint: `http://127.0.0.1:${address.port}`, bot: () => ({ uid: '365', name: 'Saturday' }) });
  try {
    await uploader.cycle();
    assert.ok(seen.some(request => request.url === '/v1/bots/366/ingest/batches' && request.body.bot_name === undefined));
    assert.ok(seen.some(request => request.url === '/v1/bots/365/ingest/batches' && request.body.bot_name === 'Saturday'));
    const state = JSON.parse(await fs.readFile(path.join(root, 'data/monday-memory-upload/state.json'), 'utf8'));
    assert.equal(state.files['sessions/cli/2026-11-16/cli_other.jsonl'].bot_uid, '366');
    assert.equal(state.files['sessions/cli/2026-11-16/cli_old.jsonl'].bot_uid, '365');
  } finally { await uploader.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
});
