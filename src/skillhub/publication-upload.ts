import * as https from 'node:https';
import type {IncomingMessage,ClientRequest} from 'node:http';
import {PublicationCaptureStore,type PublicationCaptureInput} from './publication-capture';
import {publicationCaptureEnabled} from './publication-capture';

export const PUBLICATION_UPLOAD = 'skillhub.publication.upload.v1' as const;
export function publicationUploadConfig() {
  return { issuer: process.env.XIAOBA_SKILLHUB_PUBLICATION_ISSUER?.trim() ?? '',
    audience: process.env.XIAOBA_SKILLHUB_PUBLICATION_CLOUD_AUDIENCE?.trim() ?? '' };
}
export function publicationUploadEnabled(): boolean {
  const c = publicationUploadConfig();
  return publicationCaptureEnabled() && /^(1|true)$/i.test(process.env.XIAOBA_SKILLHUB_PUBLICATION_UPLOAD_ENABLED?.trim() ?? '') &&
    origin(c.issuer) && origin(c.audience) && c.issuer !== c.audience;
}

const uploadPath='/api/skills/publication-delegations/candidates';
const maxReply=8192;
const hash=/^[a-f0-9]{64}$/;
const match=(v: unknown,re: RegExp): v is string=>typeof v==='string'&&v.match(re)?.[0]===v;
const exact=(v:any,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(v,k));
export class PublicationUploadError extends Error {
  readonly code:string;
  constructor(kind='unavailable'){
    super('Publication candidate upload could not complete. Retry only the same retained candidate with fresh authority.');
    this.name='PublicationUploadError';this.code='publication.upload_'+kind;
  }
}
const fail=(kind='invalid'):never=>{throw new PublicationUploadError(kind);};

export interface PublicationUploadGrant {
  issuer:string;audience:string;action:'candidate.upload';
  entryId:string;candidateRevision:1;authorityEpoch:number;
  binding:PublicationCaptureInput['binding'];
  requestHash:string;sourceSnapshotHash:string;requestBytes:number;
  idempotencyKey:string;token:string;expiresAt:string;
}
export interface PublicationUploadAssociation {
  taskId:string;entryRequestId:string;candidateRevision:1;candidateHash:string;
  requestHash:string;authorityEpoch:number;eventId:string;state:string;candidateAvailable:boolean;
}
export interface PublicationUploadResult {
  schemaVersion:1;accepted:true;created:boolean;association:PublicationUploadAssociation;
}
function origin(value:unknown):value is string {
  if(typeof value!=='string'||value.length>256)return false;
  const m=value.match(/^https:\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?$/);
  if(!m||m[1].length>253||m[1].split('.').some(l=>l.length>63||!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l)))return false;
  if(m[2]&&(String(Number(m[2]))!==m[2]||Number(m[2])<1||Number(m[2])>65535))return false;
  try{return new URL(value).hostname===m[1];}catch{return false;}
}
function validateGrant(g:PublicationUploadGrant,input:PublicationCaptureInput,issuer:string,audience:string){
  if(!exact(g,['issuer','audience','action','entryId','candidateRevision','authorityEpoch','binding','requestHash','sourceSnapshotHash','requestBytes','idempotencyKey','token','expiresAt'])||
    g.issuer!==issuer||g.audience!==audience||g.action!=='candidate.upload'||g.entryId!==input.entryId||g.candidateRevision!==1||
    !Number.isSafeInteger(g.authorityEpoch)||g.authorityEpoch<1||g.authorityEpoch>8||
    !exact(g.binding,['botUid','ownerUid','bodyId','installationId'])||
    Object.keys(g.binding).some(k=>g.binding[k as keyof typeof g.binding]!==input.binding[k as keyof typeof g.binding])||
    !match(g.requestHash,hash)||!match(g.sourceSnapshotHash,hash)||!Number.isSafeInteger(g.requestBytes)||g.requestBytes<1||g.requestBytes>32*1024*1024||
    !match(g.idempotencyKey,/^pubcandidate_[a-f0-9]{32}$/)||!match(g.token,/^pubupload_[a-f0-9]{64}$/)||
    !match(g.expiresAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/))fail();
  const expiry=Date.parse(g.expiresAt);
  if(!Number.isFinite(expiry)||new Date(expiry).toISOString()!==g.expiresAt||expiry<=Date.now()||expiry>Date.now()+120000)fail('inactive');
}
function singleHeader(res:IncomingMessage,name:string){
  const values=[];
  for(let i=0;i<res.rawHeaders.length;i+=2)if(res.rawHeaders[i].toLowerCase()===name)values.push(res.rawHeaders[i+1]);
  if(values.length>1)fail('protocol');return values[0];
}
function project(text:string,status:number,g:PublicationUploadGrant):PublicationUploadResult {
  // Reject duplicate JSON keys, including escaped spellings, without pulling
  // Cloud-only dependencies into the runtime. The narrow reply permits only
  // objects and primitives; arrays are never part of this contract.
  const seen=new Set<string>();let depth=0;
  const tokens=text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:]|[^\s{}\[\]:,]+/g)??[];
  const stack:Set<string>[]=[];
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i];
    if(token==='['||token===']')fail('protocol');
    if(token==='{'){if(++depth>3)fail('protocol');stack.push(new Set());}
    else if(token==='}'){depth--;stack.pop();}
    else if(token.startsWith('"')&&tokens[i+1]===':'){
      const k=JSON.parse(token);const keys=stack[stack.length-1]??seen;if(keys.has(k))fail('protocol');keys.add(k);
    }
  }
  const r=JSON.parse(text),a=r?.association;
  if(!exact(r,['schemaVersion','accepted','created','association'])||r.schemaVersion!==1||r.accepted!==true||typeof r.created!=='boolean'||
    r.created!==(status===201)||!exact(a,['taskId','entryRequestId','candidateRevision','candidateHash','requestHash','authorityEpoch','eventId','state','candidateAvailable'])||
    a.entryRequestId!==g.entryId||a.candidateRevision!==1||a.candidateHash!==g.sourceSnapshotHash||a.requestHash!==g.requestHash||
    !Number.isInteger(a.authorityEpoch)||a.authorityEpoch<1||a.authorityEpoch>g.authorityEpoch||
    !match(a.taskId,/^pubtask_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)||
    !match(a.eventId,/^pubevent_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)||
    !['delegated_pending','cancelled','committing','publish_queued','publish_failed','published'].includes(a.state)||typeof a.candidateAvailable!=='boolean'||
    (a.state==='cancelled'&&a.candidateAvailable))fail('protocol');
  return r;
}

// Internal uploader. Only the reserved authenticated CatsCo upload adapter
// supplies its byte-bound grant and synchronous live-route guard. No model tool,
// user entry point or retry scheduler invokes it.
export class PublicationCandidateUploader {
  #active=0;
  readonly #settings: {runtimeRoot:string;enabled?:boolean;issuer:string;audience:string};
  readonly #request: typeof https.request;
  readonly #timeoutMs:number;
  constructor(settings:{runtimeRoot:string;enabled?:boolean;issuer:string;audience:string},
    testDependencies:{requestImpl?:typeof https.request;timeoutMs?:number}={}){
    this.#settings={...settings};this.#request=testDependencies.requestImpl??https.request;this.#timeoutMs=testDependencies.timeoutMs??60000;
  }
  async upload(input:PublicationCaptureInput,grant:PublicationUploadGrant,checkAuthority:()=>void,signal?:AbortSignal):Promise<PublicationUploadResult>{
    if(!this.#settings.enabled)fail('disabled');
    if(!origin(this.#settings.issuer)||!origin(this.#settings.audience)||new URL(this.#settings.issuer).origin===new URL(this.#settings.audience).origin||
      !Number.isSafeInteger(this.#timeoutMs)||this.#timeoutMs<1||this.#timeoutMs>60000)fail('configuration');
    if(this.#active>=2)fail('busy');
    this.#active++;
    try{
      validateGrant(grant,input,this.#settings.issuer,this.#settings.audience);
      input={...input,binding:{...input.binding},source:{...input.source}};
      grant={...grant,binding:{...grant.binding}};
      const deadline=Math.min(Date.now()+this.#timeoutMs,Date.parse(grant.expiresAt));
      const check=()=>{
        if(signal?.aborted||Date.now()>=deadline)fail('inactive');
        if(typeof checkAuthority!=='function')fail();
        const returned:unknown=checkAuthority();
        if(returned!==undefined){
          if(returned instanceof Promise)void returned.catch(()=>{});
          fail();
        }
      };
      check();
      const candidate=await new PublicationCaptureStore({runtimeRoot:this.#settings.runtimeRoot,enabled:true}).readCandidate(input,check);
      const r=candidate.receipt;
      if(r.entryId!==grant.entryId||r.requestHash!==grant.requestHash||r.sourceSnapshotHash!==grant.sourceSnapshotHash||r.requestBytes!==grant.requestBytes)fail('conflict');
      check(); // readCandidate has released its workspace lock before network IO.
      return await this.send(candidate.bytes,grant,check,deadline,signal);
    }catch(e){if(e instanceof PublicationUploadError)throw e;throw new PublicationUploadError();}
    finally{this.#active--;}
  }
  private send(bytes:Buffer,g:PublicationUploadGrant,check:()=>void,deadline:number,signal?:AbortSignal):Promise<PublicationUploadResult>{
    return new Promise((resolve,reject)=>{
      let req:ClientRequest|undefined,res:IncomingMessage|undefined,result:PublicationUploadResult|undefined,failure:PublicationUploadError|undefined;
      let done=false;
      const finish=()=>{
        if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
        if(failure||!result)reject(failure??new PublicationUploadError());else resolve(result);
      };
      const stop=(kind='unavailable')=>{failure??=new PublicationUploadError(kind);res?.destroy();if(req)req.destroy();else finish();};
      const abort=()=>stop('inactive');
      const timer=setTimeout(()=>stop('timeout'),Math.max(1,deadline-Date.now()));
      signal?.addEventListener('abort',abort,{once:true});
      try{
        check();
        // Native HTTPS verifies certificates, never follows redirects or proxy
        // environment settings, and sends credentials only to this fixed path.
        req=this.#request(new URL(uploadPath,this.#settings.audience),{method:'POST',agent:false,rejectUnauthorized:true,maxHeaderSize:8192,
          headers:{Authorization:'Bearer '+g.token,'Content-Type':'application/json','Content-Length':bytes.length,
            'X-Publication-Entry':g.entryId,'X-Publication-Epoch':String(g.authorityEpoch),
            'X-Publication-Source-Hash':g.sourceSnapshotHash,'Idempotency-Key':g.idempotencyKey}},incoming=>{
          res=incoming;
          res.once('aborted',()=>stop());res.once('error',()=>stop());
          try{
            check();
            const status=res.statusCode??0;
            if(![200,201].includes(status)){
              stop(({400:'invalid',401:'inactive',403:'inactive',409:'conflict',413:'limit',422:'rejected',429:'busy'} as Record<number,string>)[status]??'unavailable');return;
            }
            const length=singleHeader(res,'content-length');
            if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(singleHeader(res,'content-type')??'')||singleHeader(res,'content-encoding')!==undefined||
              (length!==undefined&&(!/^[0-9]{1,5}$/.test(length)||Number(length)>maxReply)))fail('protocol');
            const chunks:Buffer[]=[];let count=0;
            res.on('data',(b:Buffer)=>{count+=b.length;if(count>maxReply)stop('protocol');else chunks.push(b);});
            res.once('end',()=>{
              try{check();if(!res?.complete||(length!==undefined&&Number(length)!==count))fail('protocol');
                result=project(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),status,g);}
              catch{stop('protocol');}
            });
          }catch{stop('protocol');}
        });
        req.once('error',()=>{failure??=new PublicationUploadError();});
        req.once('close',finish);
        check();req.end(bytes);
      }catch{stop();}
    });
  }
}
