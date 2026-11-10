import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { OpenAppTool } from '../src/tools/open-app-tool';
import { CatsCompanyBot } from '../src/catscompany';
import { CatsClient, CatsSendError } from '../src/catscompany/client';
import { MessageSender } from '../src/catscompany/message-sender';
import { ToolManager } from '../src/tools/tool-manager';
import { DEFAULT_TOOL_NAMES } from '../src/tools/default-tool-names';
import type { ChannelCallbacks, ToolExecutionContext } from '../src/types/tool';

type Wire = { topic_id: string; client_msg_id: string; content: string; metadata: Record<string, unknown> };
type BotFixture = { sender: MessageSender; bot: { listOwnApps: () => Promise<{ id: string }[]> }; buildChannel(topic: string): ChannelCallbacks & {hasOutbound: boolean} };
function fixture(fail = false) {
  const wires: Wire[] = [];
  const client = { sendStructuredMessage: async (body: Wire) => { wires.push(structuredClone(body)); if (fail) throw new CatsSendError('timeout', 'timeout', undefined, {clientMsgID: body.client_msg_id, retryableWithHttp: true}); return 1; } };
  const bot = Object.create(CatsCompanyBot.prototype) as BotFixture;
  bot.sender = new MessageSender(client as unknown as CatsClient, 'https://example.test', 'test');
  bot.bot = { listOwnApps: async () => [{id: 'board'}] };
  const channel = bot.buildChannel('p2p_7_9');
  const context: ToolExecutionContext = {workingDirectory: process.cwd(), conversationHistory: [], surface: 'catscompany', sessionId: 'session', channel};
  return {wires, bot, channel, context};
}
const init = {app_id: 'board', action: 'initialize', request_id: 'request_1234', parameters: {data_path:'/data/sample', server:'compute-1'}};
function app(body: Wire): Record<string, unknown> { return body.metadata.app_open as Record<string, unknown>; }

test('real tool -> callback -> MessageSender -> WS preserves v1 and never claims app success', async () => {
 const f=fixture(); const result=await new OpenAppTool().execute({app_id:'board'},f.context);
 assert.equal(result.ok,true); assert.equal(f.wires.length,1); assert.equal(app(f.wires[0]).contract_version,'catsco.app-open.v1');
 assert.equal(app(f.wires[0]).agent_uid,undefined); assert.doesNotMatch(f.wires[0].content,/已为你打开/);
});
test('v2 binds actual current topic and initializes without run',async()=>{
 const f=fixture(); const before=Date.now(); await new OpenAppTool().execute(init,f.context);
 const a=app(f.wires[0]); assert.equal(a.contract_version,'catsco.app-open.v2');
 const h=a.handoff as Record<string,unknown>; assert.equal(h.topic_id,'p2p_7_9'); assert.equal(h.action,'initialize'); assert.equal(h.user_requested_run,false); assert.deepEqual(h.parameters,init.parameters); assert.ok(Number(h.expires_at)>=before+59000 && Number(h.expires_at)<=Date.now()+60000);
});
test('HTTP fallback retains app_open and same transport identity',async()=>{
 const f=fixture(true); const original=globalThis.fetch; const http:Wire[]=[];
 globalThis.fetch=async (_url,options)=>{http.push(JSON.parse(String(options?.body)) as Wire);return new Response(JSON.stringify({seq_id:2}),{status:200});};
 try {await new OpenAppTool().execute(init,f.context); assert.equal(http.length,1);assert.deepEqual(http[0].metadata,f.wires[0].metadata);assert.equal(http[0].client_msg_id,f.wires[0].client_msg_id);} finally {globalThis.fetch=original;}
});
test('segmentation emits app_open once, preserves other metadata; empty structured reply fails',async()=>{
 const f=fixture(); await f.bot.sender.reply('p2p_7_9','x'.repeat(9000),{app_open:{contract_version:'catsco.app-open.v1',app_id:'board'},tag:'keep'});
 assert.ok(f.wires.length>1);assert.equal(f.wires.filter(x=>x.metadata.app_open).length,1);assert.ok(f.wires.every(x=>x.metadata.tag==='keep'));
 await assert.rejects(()=>f.bot.sender.reply('p2p_7_9',' ',{app_open:{}}));
});
test('metadata callback refuses cross-topic and marks outbound only after successful send',async()=>{
 const f=fixture(); await assert.rejects(()=>f.channel.replyWithMetadata!('p2p_other','hello',{app_open:{}})); assert.equal(f.wires.length,0);assert.equal(f.channel.hasOutbound,false);
 const bad=fixture();bad.bot.sender.reply=async()=>{throw new Error('rejected');}; await assert.rejects(()=>new OpenAppTool().execute(init,bad.context));assert.equal(bad.channel.hasOutbound,false);
});
test('unsupported, aborted and stale contexts refuse before send',async()=>{
 const f=fixture();delete f.context.channel!.replyWithMetadata;assert.equal((await new OpenAppTool().execute(init,f.context)).ok,false);
 const aborted=fixture();aborted.context.abortSignal=AbortSignal.abort();assert.equal((await new OpenAppTool().execute(init,aborted.context)).ok,false);assert.equal(aborted.wires.length,0);
 const stale=fixture();stale.context.executionScope={source:'catscompany',sessionKey:'old',topicId:'p2p_wrong',topicType:'p2p',identityTrust:'server_canonical',isTrusted:true} as NonNullable<ToolExecutionContext['executionScope']>;
 assert.equal((await new OpenAppTool().execute(init,stale.context)).ok,false);assert.equal(stale.wires.length,0);
});
test('run requires literal true; initialize never sets run and unknown top-level instructions fail',async()=>{
 for(const flag of [undefined,false,'true',1]) {const f=fixture();await assert.rejects(()=>new OpenAppTool().execute({...init,action:'run',user_requested_run:flag},f.context));assert.equal(f.wires.length,0);}
 const f=fixture();await new OpenAppTool().execute({...init,action:'run',user_requested_run:true},f.context);assert.equal((app(f.wires[0]).handoff as Record<string,unknown>).user_requested_run,true);
 for(const extra of [{topic_id:'spoof'},{agent_uid:999},{url:'https://bad'},{user_requested_run:true}]){await assert.rejects(()=>new OpenAppTool().execute({...init,...extra},fixture().context));}
});
test('parameter boundaries, Go escaping, Unicode scalars and nonfinite values',async()=>{
 for(const parameters of [{password:'x'},{private_key:'x'},{command:'x'},{x:'https://bad'},{x:'Bearer abc'},{x:'-----BEGIN KEY'},{x:'a\nb'},{x:'\u007f'},{x:'\ud800'},{x:null},{x:{}},{x:[]},{x:Infinity},{x:NaN},{x:'😀'.repeat(513)},Object.fromEntries(Array.from({length:17},(_,i)=>['k'+i,1])),{a:'<'.repeat(512),b:'>'.repeat(512)}]) {
  await assert.rejects(()=>new OpenAppTool().execute({...init,parameters},fixture().context));
 }
 const f=fixture();await new OpenAppTool().execute({...init,parameters:{x:'😀'.repeat(512),n:1e-7,b:true}},f.context);assert.equal(f.wires.length,1);
 for(const request_id of ['short','x'.repeat(81),'中文request'])await assert.rejects(()=>new OpenAppTool().execute({...init,request_id},fixture().context));
});
test('stable request IDs deduplicate concurrent calls and reject payload changes even after ambiguous send',async()=>{
 const f=fixture();const tool=new OpenAppTool();await Promise.all([tool.execute(init,f.context),tool.execute(init,f.context)]);assert.equal(f.wires.length,1);
 await assert.rejects(()=>tool.execute({...init,parameters:{x:'different'}},f.context));
 const b=fixture();b.bot.sender.reply=async()=>{throw new Error('unknown outcome');};const t=new OpenAppTool();await assert.rejects(()=>t.execute(init,b.context));await assert.rejects(()=>t.execute(init,b.context),/unknown|未知|重复/);
});
test('catalog action uses narrow channel query; rejects unknown app IDs before emission',async()=>{
 const f=fixture();const result=await new OpenAppTool().execute({action:'list'},f.context);assert.equal(result.ok,true);assert.equal(f.wires.length,0);assert.match(JSON.stringify(result),/board/);
 await assert.rejects(()=>new OpenAppTool().execute({...init,app_id:'invented'},f.context));assert.equal(f.wires.length,0);
});
test('catalog client uses only authenticated fixed read endpoint and projects no URLs or credentials',async()=>{
 const client=new CatsClient({serverUrl:'wss://example.test/ws',httpBaseUrl:'https://example.test',apiKey:'test-only'});
 const original=globalThis.fetch;let called=0;
 globalThis.fetch=async(url,options)=>{called++;assert.equal(String(url),'https://example.test/api/artifacts/apps');assert.equal(options?.method,undefined);assert.equal(options?.redirect,'error');return new Response(JSON.stringify({apps:[{id:'board',title:'Board',url:'https://ignored.test',token:'never-return'}]}));};
 try {assert.deepEqual(await client.listOwnApps(),[{id:'board',title:'Board'}]);assert.equal(called,1);}finally{globalThis.fetch=original;}
});
test('catalog failure and HTTP rejection do not report success',async()=>{
 const f=fixture();f.bot.bot.listOwnApps=async()=>{throw new Error('catalog unavailable');};await assert.rejects(()=>new OpenAppTool().execute(init,f.context));assert.equal(f.wires.length,0);assert.equal(f.channel.hasOutbound,false);
 const bad=fixture(true);const original=globalThis.fetch;globalThis.fetch=async()=>new Response('{}',{status:403});
 try{await assert.rejects(()=>new OpenAppTool().execute(init,bad.context));assert.equal(bad.channel.hasOutbound,false);}finally{globalThis.fetch=original;}
});
test('pending catalog lookups recheck cancellation and topic before send',async()=>{
 for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.context.channel!.chatId='changed';},(f:ReturnType<typeof fixture>)=>{f.context.abortSignal=AbortSignal.abort();}]){
  const f=fixture();let release!:(v:{id:string}[])=>void;f.bot.bot.listOwnApps=()=>new Promise(resolve=>{release=resolve;});const pending=new OpenAppTool().execute(init,f.context);mutate(f);release([{id:'board'}]);await assert.rejects(()=>pending);assert.equal(f.wires.length,0);
 }
});
test('additional parameter and serialized-byte boundary cases',async()=>{
 for(const key of ['passwd','token','secret','credential','privatekey','authorization','cookie','script','bad-key','A','a'.repeat(49)])await assert.rejects(()=>new OpenAppTool().execute({...init,parameters:{[key]:'x'}},fixture().context));
 for(const x of ['http://host','ssh://host','sftp://host','a\u0000b'])await assert.rejects(()=>new OpenAppTool().execute({...init,parameters:{x}},fixture().context));
 const exact={a:'<'.repeat(512),b:'<'.repeat(168)+'x'.repeat(2)};assert.equal(Buffer.byteLength(JSON.stringify(exact).replace(/</g,'\\u003c')),4097);await assert.rejects(()=>new OpenAppTool().execute({...init,parameters:exact},fixture().context));
 const valid={a:'<'.repeat(512),b:'<'.repeat(168)+'x'};const f=fixture();await new OpenAppTool().execute({...init,parameters:valid},f.context);assert.equal(f.wires.length,1);
});
test('preflight recovery reuses the same identity while null parameters and zero acknowledgments fail',async()=>{
 const f=fixture();const t=new OpenAppTool();f.bot.bot.listOwnApps=async()=>{throw new Error('temporarily unavailable');};await assert.rejects(()=>t.execute(init,f.context));f.bot.bot.listOwnApps=async()=>[{id:'board'}];await t.execute(init,f.context);assert.equal(f.wires.length,1);
 await assert.rejects(()=>new OpenAppTool().execute({...init,parameters:null},fixture().context));
 const b=fixture();b.bot.sender.sendText=async()=>0;await assert.rejects(()=>new OpenAppTool().execute(init,b.context));assert.equal(b.channel.hasOutbound,false);
});
test('open_app remains registered and visible by default',()=>{
 assert.ok(DEFAULT_TOOL_NAMES.includes('open_app')); const m=new ToolManager(process.cwd());assert.ok(m.getTool('open_app'));assert.ok(m.getToolDefinitions().some(d=>d.name==='open_app'));
});

for (const action of ['list', 'initialize'] as const) {
 for (const mutation of ['untrusted', 'abort', 'scope topic'] as const) {
  test(`pending catalog ${action} refuses live ${mutation} without returning directory or sending`, async () => {
   const f = fixture();
   f.context.executionScope = {source:'catscompany', sessionKey:'session', topicId:'p2p_7_9', topicType:'p2p', identityTrust:'server_canonical', isTrusted:true} as NonNullable<ToolExecutionContext['executionScope']>;
   const controller = new AbortController();
   f.context.abortSignal = controller.signal;
   let release!: (apps: {id:string}[]) => void;
   f.bot.bot.listOwnApps = () => new Promise(resolve => { release = resolve; });
   const pending = new OpenAppTool().execute(action === 'list' ? {action} : init, f.context);
   if (mutation === 'untrusted') f.context.executionScope.identityTrust = 'untrusted';
   else if (mutation === 'abort') controller.abort();
   else f.context.executionScope.topicId = 'p2p_changed';
   release([{id:'board'}]);
   let returned: unknown;
   await assert.rejects(async () => { returned = await pending; }, /执行上下文已陈旧/);
   assert.equal(returned, undefined);
   assert.equal(f.wires.length, 0);
   assert.equal(f.channel.hasOutbound, false);
  });
 }
}
