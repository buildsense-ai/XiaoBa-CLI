import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { MondayMemoryUploader, nextMemoryScan, mondayMemoryConfig } from '../src/utils/monday-memory-uploader';

test('uses 03/15 Beijing regardless of host timezone and is opt-in', () => {
  assert.equal(new Date(nextMemoryScan(Date.parse('2026-11-17T02:00:00+08:00'))).toISOString(), '2026-11-16T19:00:00.000Z');
  assert.equal(new Date(nextMemoryScan(Date.parse('2026-11-17T03:00:00+08:00'))).toISOString(), '2026-11-17T07:00:00.000Z');
  assert.equal(mondayMemoryConfig('/tmp/test', {}), undefined);
});
test('uploads all history, survives lost ACK/restart, then transfers only appended complete lines with rotated key', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monday-uploader-'));
  const source = path.join(root, 'logs/sessions/cli/2026-11-16/cli_session.jsonl');
  await fs.mkdir(path.dirname(source), {recursive:true});
  const old = JSON.stringify({entry_type:'turn',user:{text:'history'},assistant:{text:'reply',tool_calls:[]}})+'\n';
  await fs.writeFile(source, old);
  const streams = new Map<string, Buffer>(), requests: unknown[] = [], manifests: {lane: string}[] = [];
  let drop = true;
  const server = createServer(async (req,res) => {
    const chunks: Buffer[]=[]; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/ingest/manifests') { manifests.push(body); res.end('{}'); return; }
    const raw=Buffer.concat(body.records.map((r:{raw_base64:string})=>Buffer.from(r.raw_base64,'base64')));
    const before=streams.get(body.stream_id)??Buffer.alloc(0);
    if(body.records[0].offset===before.length)streams.set(body.stream_id,Buffer.concat([before,raw]));
    else assert.equal(before.subarray(body.records[0].offset,body.records[0].offset+raw.length).equals(raw),true);
    if(drop){drop=false;req.socket.destroy();return;}
    res.end(JSON.stringify({next_offset:body.records[0].offset+raw.length,sha256:createHash('sha256').update(raw).digest('hex')}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); assert.ok(address&&typeof address==='object');
  const config={root,endpoint:`http://127.0.0.1:${address.port}`,key:'first',dataset:'clean-v1'};
  let uploader=new MondayMemoryUploader(config);
  try {
    await uploader.cycle(Date.parse('2026-11-17T03:00:00+08:00'));
    assert.equal(JSON.parse(await fs.readFile(path.join(root,'data/monday-memory-state.json'),'utf8')).files['sessions/cli/2026-11-16/cli_session.jsonl'].backfill.offset,0);
    await uploader.stop();
    uploader=new MondayMemoryUploader({...config,key:'rotated'});
    await uploader.cycle(Date.parse('2026-11-17T04:00:00+08:00'));
    assert.equal([...streams.values()].reduce((n,b)=>n+b.length,0),Buffer.byteLength(old));
    const added=JSON.stringify({entry_type:'turn',user:{text:'new'},assistant:{text:'new reply',tool_calls:[]}})+'\n';
    await fs.appendFile(source,added+'{"partial":');
    await uploader.cycle(Date.parse('2026-11-17T15:00:00+08:00'));
    assert.equal([...streams.values()].reduce((n,b)=>n+b.length,0),Buffer.byteLength(old+added));
    assert.ok(manifests.some(m=>m.lane==='backfill'));assert.ok(manifests.some(m=>m.lane==='incremental'));
    const original=await fs.readFile(source,'utf8');assert.equal(original,old+added+'{"partial":');
    const state=JSON.parse(await fs.readFile(path.join(root,'data/monday-memory-state.json'),'utf8'));
    assert.equal(state.files['sessions/cli/2026-11-16/cli_session.jsonl'].baseline,Buffer.byteLength(old));
    assert.equal(JSON.stringify(state).includes('rotated'),false);
    await uploader.cycle(Date.parse('2026-11-17T16:00:00+08:00'));
    assert.ok(requests.length>0);
  } finally {await uploader.stop();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(root,{recursive:true,force:true});}
});
