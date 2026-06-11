function parseCatsContent(content){
  if(!content)return null;
  if(typeof content==='object')return content;
  if(typeof content==='string'){
    try{
      const parsed=JSON.parse(content);
      if(parsed && typeof parsed==='object')return parsed;
    }catch(_e){}
  }
  return null;
}

function parseCatsRuntimePlanValue(value){
  const parsed=parseCatsContent(value);
  if(!parsed || typeof parsed!=='object')return null;
  const steps=Array.isArray(parsed.steps)?parsed.steps:null;
  if(!steps)return null;
  const looksLikePlan=steps.every(step=>
    step && typeof step==='object' &&
    typeof step.text==='string' &&
    (!step.status || ['pending','in_progress','completed'].includes(String(step.status)))
  );
  if(!looksLikePlan)return null;
  if(parsed.runtime_plan || parsed.revision!=null || parsed.updatedAt!=null || parsed.updated_at!=null)return parsed;
  return null;
}

function catsMessageKey(message){
  if(!message)return '';
  if(message.id!=null)return 'id:'+message.id;
  if(message.seq_id!=null)return 'seq:'+message.seq_id;
  const created=message.created_at||'';
  const from=message.from_uid||message.from||'';
  const content=typeof message.content==='string'?message.content:JSON.stringify(message.content||'');
  return 'fallback:'+catsStableHash([created,from,content].join('|'));
}

function isCatsMessageMine(message){
  const uid=String(catsState.user?.uid||'');
  const from=String(message?.from_uid || message?.from || '');
  return Boolean(uid && (from===uid || from===('usr'+uid)));
}

function mergeCatsMessages(existing,incoming){
  const map=new Map();
  (existing||[]).forEach(message=>{
    const key=catsMessageKey(message);
    if(key)map.set(key,message);
  });
  (incoming||[]).forEach(message=>{
    const key=catsMessageKey(message);
    if(key)map.set(key,message);
  });
  return [...map.values()].sort((a,b)=>{
    const ta=Date.parse(a.created_at||'')||0;
    const tb=Date.parse(b.created_at||'')||0;
    if(ta!==tb)return ta-tb;
    return Number(a.id||a.seq_id||0)-Number(b.id||b.seq_id||0);
  });
}

function normalizeMediaUrl(url){
  if(!url)return '';
  if(/^https?:\/\//i.test(url))return url;
  const base=(catsState.httpBaseUrl||CATS_DEFAULT_HTTP_BASE).replace(/\/+$/,'');
  return base+'/'+String(url).replace(/^\/+/,'');
}

function formatCatsFileSize(value){
  const bytes=Number(value||0);
  if(!bytes)return '';
  return formatBytes(bytes);
}

function buildRichCatsContentBlock(content){
  const rich=parseCatsContent(content);
  if(!rich || !rich.type)return null;
  const payload=rich.payload||rich;
  if(rich.type==='image'){
    const src=normalizeMediaUrl(payload.url||payload.thumbnail);
    const title=payload.name||payload.alt||'image';
    return src?{kind:'rich',richType:'image',src,title}:null;
  }
  if(rich.type==='file'){
    const url=normalizeMediaUrl(payload.url);
    const name=payload.name||'File';
    const meta=[formatCatsFileSize(payload.size), name.includes('.')?name.split('.').pop().toUpperCase():'FILE'].filter(Boolean).join(' · ');
    return {icon:'FILE',kind:'rich',meta,name,richType:'file',title:name,url};
  }
  if(rich.type==='link_preview'){
    const url=safeLinkUrl(payload.url);
    const title=payload.title||payload.url||'Link';
    const desc=payload.description||payload.site_name||'';
    return url?{desc,icon:'URL',kind:'rich',meta:desc,richType:'link_preview',title,url}:null;
  }
  if(rich.type==='card'){
    return {desc:payload.description||'',icon:'CARD',kind:'rich',meta:payload.description||'',richType:'card',title:payload.title||'Card'};
  }
  return null;
}

function markdownBodyBlock(text){
  const blocks=parseMarkdownBlocks(text);
  return blocks.length?{kind:'markdown',blocks}:null;
}

function catsWorkingSummary(block){
  if(!block)return '';
  if(block.input){
    if(typeof block.input==='string')return block.input;
    if(block.input.command)return block.input.command;
    if(block.input.file_path)return block.input.file_path;
    if(block.input.pattern)return block.input.pattern;
    try{return JSON.stringify(block.input).slice(0,160);}catch(_e){return '';}
  }
  return block.thinking||block.text||block.content||'';
}

function catsWorkingCode(value){
  if(value==null || value==='')return '';
  if(typeof value==='string')return value;
  try{return JSON.stringify(value,null,2);}catch(_e){return String(value);}
}

function catsWorkingBlockKey(block){
  return String(block?.id || block?.tool_use_id || block?.tool_id || block?.call_id || '');
}

function catsMessageType(message){
  const type=String(message?.type||'');
  const msgType=String(message?.msg_type||'');
  const metadata=message?.metadata||{};
  if(type==='runtime_plan' || msgType==='runtime_plan' || metadata.runtime_plan)return 'runtime_plan';
  if(!isCatsMessageMine(message) && parseCatsRuntimePlanValue(message?.content))return 'runtime_plan';
  if(type && type!=='text')return type;
  if(CATS_WORKING_TYPES.has(msgType))return msgType;
  return type || msgType || '';
}

function catsRuntimePlanSnapshot(message){
  if(catsMessageType(message)!=='runtime_plan')return null;
  return parseCatsRuntimePlanValue(message?.content || message?.metadata?.snapshot);
}

function catsRuntimePlanKey(message,snapshot){
  return String(message?.seq_id || message?.id || snapshot?.revision || message?.created_at || 'runtime-plan');
}

function setCatsRuntimePlanOpen(key,open){
  if(!key)return;
  catsRuntimePlanOpenState.set(String(key), Boolean(open));
}
window.setCatsRuntimePlanOpen=setCatsRuntimePlanOpen;

function isCatsRuntimePlanMessage(message){
  return Boolean(catsRuntimePlanSnapshot(message));
}

function isCatsRuntimePlanClearMessage(message){
  const snapshot=catsRuntimePlanSnapshot(message);
  return Boolean(snapshot && Array.isArray(snapshot.steps) && snapshot.steps.length===0);
}

function buildCatsRuntimePlanBodyBlock(message){
  const snapshot=catsRuntimePlanSnapshot(message);
  const steps=Array.isArray(snapshot?.steps)?snapshot.steps:[];
  if(!steps.length)return null;
  const key=catsRuntimePlanKey(message,snapshot);
  const allDone=steps.every(step=>step?.status==='completed');
  const open=catsRuntimePlanOpenState.has(key)?catsRuntimePlanOpenState.get(key):!allDone;
  const done=steps.filter(step=>step?.status==='completed').length;
  const statusLabels={pending:'待处理',in_progress:'进行中',completed:'已完成'};
  return {
    done,
    kind:'runtimePlan',
    open,
    planKey:key,
    steps:steps.map(step=>{
      const status=String(step?.status||'pending');
      const label=statusLabels[status]||status;
      return {label,status,text:String(step?.text||'')};
    }),
    total:steps.length,
  };
}

function isCatsWorkingTextMessage(message){
  const type=message?.type || message?.msg_type || '';
  const content=typeof message?.content==='string'?message.content.trim():'';
  return type==='text' && content.startsWith(CATS_WORKING_TEXT_PREFIX);
}

function catsWorkingTextContent(text){
  const value=String(text||'').trim();
  return value.startsWith(CATS_WORKING_TEXT_PREFIX)
    ? value.slice(CATS_WORKING_TEXT_PREFIX.length).trim()
    : value;
}

function catsContentBlocksFromMessage(message){
  const stored=Array.isArray(message?.content_blocks)?message.content_blocks:[];
  if(stored.length)return stored;
  const type=catsMessageType(message);
  if(type==='thinking'){
    return [{type:'thinking', thinking:extractCatsMessageText(message)}];
  }
  if(type==='tool_use'){
    return [{
      type:'tool_use',
      id:message.metadata?.id || message.metadata?.tool_call_id || message.metadata?.tool_use_id,
      name:extractCatsMessageText(message)||'Tool',
      input:message.metadata?.input,
      metadata:message.metadata||{},
    }];
  }
  if(type==='tool_result'){
    return [{
      type:'tool_result',
      tool_use_id:message.metadata?.tool_use_id || message.metadata?.id || message.metadata?.tool_call_id,
      content:extractCatsMessageText(message),
      is_error:Boolean(message.metadata?.is_error),
      metadata:message.metadata||{},
    }];
  }
  if(isCatsWorkingTextMessage(message)){
    return [{type:'assistant_text', text:catsWorkingTextContent(message.content)}];
  }
  return [];
}

function groupCatsWorkingBlocks(blocks){
  const groups=[];
  const tools=new Map();
  blocks.forEach(block=>{
    const type=block?.type||'';
    if(type==='text' || ['image','file','link_preview','card'].includes(type))return;
    if(type==='thinking'){
      groups.push({type:'thinking', block});
      return;
    }
    if(type==='assistant_text'){
      groups.push({type:'assistant_text', block});
      return;
    }
    if(type==='tool_use'){
      const group={type:'tool', tool:block, result:null};
      groups.push(group);
      const key=catsWorkingBlockKey(block);
      if(key)tools.set(key,group);
      return;
    }
    if(type==='tool_result'){
      const key=catsWorkingBlockKey(block);
      const group=key?tools.get(key):null;
      if(group && !group.result){
        group.result=block;
      }else{
        const fallback=groups.find(item=>item.type==='tool' && !item.result);
        if(fallback){
          fallback.result=block;
        }else{
          groups.push({type:'tool_result', result:block});
        }
      }
      return;
    }
  });
  return groups;
}

function isCatsWorkingMessage(message){
  const type=catsMessageType(message);
  if(CATS_WORKING_TYPES.has(type))return true;
  if(isCatsWorkingTextMessage(message))return true;
  const blocks=Array.isArray(message?.content_blocks)?message.content_blocks:[];
  return blocks.some(block => block && CATS_WORKING_TYPES.has(block.type));
}

function catsMessageComparableId(message){
  return String(message?.seq_id || message?.id || message?.created_at || '');
}

function truncateCatsWorkingText(value, limit=1200){
  const text=String(value||'');
  if(text.length<=limit)return {text, truncated:false};
  return {text:text.slice(0,limit).trimEnd()+'\n...', truncated:true};
}

function catsStableHash(value){
  const text=typeof value==='string'?value:JSON.stringify(value||'');
  let hash=0;
  for(let i=0;i<text.length;i++){
    hash=((hash<<5)-hash)+text.charCodeAt(i);
    hash|=0;
  }
  return Math.abs(hash).toString(36);
}

function catsWorkingDetailKey(groups){
  return catsStableHash((groups||[]).map(group=>{
    const block=group.tool||group.block||group.result||{};
    return [
      group.type,
      block.id,
      block.tool_use_id,
      block.call_id,
      block.name,
      block.metadata?.subagent_id,
      block.metadata?.display_name,
      catsWorkingSummary(block).slice(0,120),
    ].filter(Boolean).join('|');
  }).join('||'));
}

function updatePetFromCatsMessages(messages){
  const items=Array.isArray(messages)?messages:[];
  if(!items.length){
    catsWorkingActive=false;
    applyPetBaseline();
    return;
  }

  const uid=String(catsState.user?.uid||'');
  let lastUserIndex=-1;
  let lastBotTextIndex=-1;
  let lastWorkingIndex=-1;

  items.forEach((message,index)=>{
    const from=String(message.from_uid || message.from || '');
    const mine=from===uid || from===('usr'+uid);
    if(mine){
      lastUserIndex=index;
      return;
    }
    if(isCatsWorkingMessage(message)){
      lastWorkingIndex=index;
      return;
    }
    const text=extractCatsMessageText(message).trim();
    if(text) lastBotTextIndex=index;
  });

  const nextWorking=lastWorkingIndex > lastBotTextIndex;
  catsWorkingActive=nextWorking;
  if(nextWorking){
    setPetAutoBaseline('thinking');
    showPetBubble('CatsCo 正在处理');
  }else{
    applyPetBaseline();
  }

  const latest=items[items.length-1];
  const signature=catsMessageComparableId(latest);
  const from=String(latest.from_uid || latest.from || '');
  const latestMine=from===uid || from===('usr'+uid);
  if(signature && signature!==lastCatsMessageSignature){
    lastCatsMessageSignature=signature;
    if(!latestMine && !isCatsWorkingMessage(latest) && lastBotTextIndex >= lastUserIndex){
      pulsePetState('success','CatsCo 回复了',1800);
    }
  }
}

function buildCatsWorkingBodyBlock(blocks){
  if(!blocks.length)return null;
  const groups=groupCatsWorkingBlocks(blocks);
  if(!groups.length)return null;
  const detailKey=catsWorkingDetailKey(groups);
  let subAgentCount=0;
  const steps=groups.map(group=>{
    if(group.type==='tool'){
      const tool=group.tool||{};
      const result=group.result||{};
      const metadata=Object.assign({}, tool.metadata||{}, result.metadata||{});
      const toolId=String(tool.id||tool.tool_use_id||tool.call_id||result.tool_use_id||'');
      const inputKind=tool.input && typeof tool.input==='object' ? String(tool.input.kind||'') : '';
      const isSubAgent=metadata.kind==='subagent_event' || inputKind==='subagent' || toolId.startsWith('subagent:');
      if(isSubAgent)subAgentCount++;
      const displayName=metadata.display_name||metadata.displayName||metadata.subagent_name||tool.input?.display_name||tool.input?.name||'子agent';
      const agentType=metadata.agent_type||tool.input?.agent_type||tool.input?.type||'';
      const status=metadata.status||tool.input?.status||'';
      const title=isSubAgent ? displayName : 'Tool: '+(tool.name||tool.tool_name||'Tool');
      const metaParts=isSubAgent
        ? [agentType,status,metadata.step_count?metadata.step_count+' 步':''].filter(Boolean)
        : [];
      const inputSummary=isSubAgent
        ? (metadata.task||tool.input?.task||metadata.summary||catsWorkingSummary(tool))
        : catsWorkingSummary(tool);
      const input=truncateCatsWorkingText(catsWorkingCode(tool.input||tool.arguments));
      const output=truncateCatsWorkingText(catsWorkingCode(result.content||result.text||result.output||result.result));
      const codeBlocks=[];
      if(input.text){
        codeBlocks.push({
          note:input.truncated?'输入较长，已在 WORKING 中截断，完整内容请看日志。':'',
          text:input.text,
        });
      }
      if(output.text){
        codeBlocks.push({
          note:output.truncated?'输出较长，已在 WORKING 中截断，完整内容请看日志。':'',
          text:output.text,
        });
      }
      return {
        codeBlocks,
        summaryMeta:metaParts.join(' · '),
        title,
        titleMeta:inputSummary,
      };
    }
    const block=group.block||group.result||{};
    const type=group.type||block.type||'Working';
    const title=type==='thinking'?'Thinking':type==='assistant_text'?'Assistant':type==='tool_result'?'Tool Result':type;
    const text=type==='tool_result'
      ? truncateCatsWorkingText(catsWorkingCode(block.content||block.text||block.output||block.result))
      : truncateCatsWorkingText(catsWorkingSummary(block),900);
    const body=type==='tool_result'
      ? {kind:'code',text:text.text}
      : {kind:'markdown',blocks:parseMarkdownBlocks(text.text)};
    return {
      body,
      note:text.truncated?'内容较长，已在 WORKING 中截断，完整内容请看日志。':'',
      title,
    };
  });
  const countLabel=(groups.length===1?'1 step':(groups.length+' steps'))+(subAgentCount?' · '+subAgentCount+' subagent':'');
  return {countLabel,detailKey,kind:'working',steps};
}

function buildCatsMessageBodyBlocks(message){
  if(isCatsRuntimePlanMessage(message)){
    const block=buildCatsRuntimePlanBodyBlock(message);
    return block?[block]:[];
  }

  const blocks=Array.isArray(message?.content_blocks)?message.content_blocks:[];
  const textBlocks=[];
  const richBlocks=[];
  const workingBlocks=[];
  const messageType=message?.type||message?.msg_type||'';
  const messageIsWorking=isCatsWorkingMessage(message);
  for(const block of blocks){
    if(block.type==='text' || (block.type==='assistant_text' && !messageIsWorking)){
      textBlocks.push(block.text||block.content||'');
    }else if(block.type==='assistant_text' && messageIsWorking){
      workingBlocks.push(block);
    }else if(['image','file','link_preview','card'].includes(block.type)){
      richBlocks.push(block);
    }else if(block.type && CATS_WORKING_TYPES.has(block.type)){
      workingBlocks.push(block);
    }
  }

  const bodyBlocks=[];
  if(textBlocks.length){
    const block=markdownBodyBlock(textBlocks.join('\n\n'));
    if(block)bodyBlocks.push(block);
  }
  if(richBlocks.length){
    richBlocks.map(buildRichCatsContentBlock).filter(Boolean).forEach(block=>bodyBlocks.push(block));
  }
  if(!textBlocks.length && !richBlocks.length && !messageIsWorking){
    const richBlock=buildRichCatsContentBlock(message.content);
    if(richBlock){
      bodyBlocks.push(richBlock);
    }else{
      const text=extractCatsMessageText(message);
      const block=markdownBodyBlock(text);
      if(block)bodyBlocks.push(block);
    }
  }

  if(!workingBlocks.length && messageIsWorking){
    workingBlocks.push(...catsContentBlocksFromMessage(message));
  }
  const workingBlock=buildCatsWorkingBodyBlock(workingBlocks);
  if(workingBlock)bodyBlocks.push(workingBlock);
  return bodyBlocks;
}

function isCatsMessageScrollNearBottom(box){
  if(!box)return true;
  const distance=box.scrollHeight-box.scrollTop-box.clientHeight;
  return distance<=CATS_SCROLL_BOTTOM_THRESHOLD;
}

function catsMessagesBox(){
  return window.__catscoGetCatsMessagesBox?.() || null;
}

function updateCatsMessageScrollIntent(box=catsMessagesBox()){
  catsScrollPinnedToBottom=isCatsMessageScrollNearBottom(box);
}

function handleCatsMessagesScroll(box=catsMessagesBox()){
  updateCatsMessageScrollIntent(box);
  if(box && box.scrollTop<=CATS_SCROLL_TOP_THRESHOLD){
    loadOlderCatsMessages();
  }
}

function scrollCatsMessagesToBottom(box){
  if(!box)return;
  box.scrollTop=box.scrollHeight;
  catsScrollPinnedToBottom=true;
}

function groupCatsTimelineMessages(messages, uid){
  const groups=[];
  let currentWorking=null;
  let pendingRuntimePlan=null;
  let prevSender='';
  let prevTime=0;
  const flushWorking=()=>{
    if(currentWorking){
      groups.push(currentWorking);
      currentWorking=null;
    }
  };
  const flushRuntimePlan=()=>{
    if(pendingRuntimePlan){
      groups.push(pendingRuntimePlan);
      pendingRuntimePlan=null;
    }
  };
  (messages||[]).forEach(message=>{
    if(isCatsRuntimePlanClearMessage(message)){
      pendingRuntimePlan=null;
      return;
    }
    const from=String(message.from_uid || message.from || '');
    const created=message.created_at?new Date(message.created_at):null;
    const time=created && !Number.isNaN(created.getTime()) ? created.getTime() : Date.now();
    const consecutive=prevSender===from && time-prevTime < 5*60*1000;
    if(isCatsRuntimePlanMessage(message)){
      flushWorking();
      pendingRuntimePlan={type:'runtime_plan', message, from, isConsecutive:consecutive};
      prevSender=from;
      prevTime=time;
      return;
    }
    if(isCatsWorkingMessage(message)){
      if(!currentWorking){
        currentWorking={type:'working', messages:[], from, isConsecutive:consecutive};
      }
      currentWorking.messages.push(message);
      prevSender=from;
      prevTime=time;
      return;
    }
    flushRuntimePlan();
    flushWorking();
    groups.push({type:'text', message, from, isConsecutive:consecutive});
    prevSender=from;
    prevTime=time;
  });
  flushRuntimePlan();
  flushWorking();
  return groups;
}

function buildCatsWorkingMessagesBodyBlocks(messages){
  const blocks=[];
  (messages||[]).forEach(message=>{
    blocks.push(...catsContentBlocksFromMessage(message));
  });
  const block=buildCatsWorkingBodyBlock(blocks);
  return block?[block]:[];
}

function catsMessageShellView(message, bodyBlocks, options={}){
  const uid=String(catsState.user?.uid||'');
  const from=String(message.from_uid || message.from || '');
  const mine=from===uid || from===('usr'+uid);
  const cls=mine?'mine':'peer';
  const who=mine?'我':'CatsCo';
  const created=message.created_at?new Date(message.created_at):null;
  const time=created && !Number.isNaN(created.getTime()) ? created.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '';
  return {
    key:catsMessageKey(message) || String(message.created_at || Math.random()),
    mine,
    cls,
    who,
    time,
    bodyBlocks,
    working:Boolean(options.working),
    isConsecutive:Boolean(options.isConsecutive),
  };
}

function renderCatsMessages(messages, options={}){
  const box=catsMessagesBox();
  if(!box)return;
  const uid=String(catsState.user?.uid||'');
  const oldScrollTop=box.scrollTop;
  const oldScrollHeight=box.scrollHeight;
  const preserveViewport=Boolean(options.preserveViewport);
  const shouldStickToBottom=Boolean(options.forceBottom) || (!preserveViewport && (catsScrollPinnedToBottom || !box.scrollHeight || isCatsMessageScrollNearBottom(box)));
  if(!messages || !messages.length){
    window.__catscoRenderCatsMessages?.({empty:true,groups:[],historyState:''});
    return;
  }
  const groups=groupCatsTimelineMessages(messages, uid);
  const timelineGroups=groups.map((group,index)=>{
    if(group.type==='runtime_plan'){
      const block=buildCatsRuntimePlanBodyBlock(group.message);
      const view=catsMessageShellView(group.message, block?[block]:[], {isConsecutive:group.isConsecutive});
      return {...view,key:view.key+':'+index};
    }
    if(group.type==='working'){
      const first=group.messages[0]||{};
      const view=catsMessageShellView(first, buildCatsWorkingMessagesBodyBlocks(group.messages), {working:true, isConsecutive:group.isConsecutive});
      return {...view,key:view.key+':'+index};
    }
    const view=catsMessageShellView(group.message, buildCatsMessageBodyBlocks(group.message), {isConsecutive:group.isConsecutive});
    return {...view,key:view.key+':'+index};
  });
  const historyState=catsMessagesLoadingOlder
    ? 'loading'
    : (!catsMessagesHasOlder?'end':'');
  window.__catscoRenderCatsMessages?.({groups:timelineGroups,historyState});
  if(preserveViewport){
    const delta=options.prepended ? box.scrollHeight-oldScrollHeight : 0;
    box.scrollTop=Math.max(0, oldScrollTop+delta);
    catsScrollPinnedToBottom=isCatsMessageScrollNearBottom(box);
  }else if(shouldStickToBottom){
    scrollCatsMessagesToBottom(box);
  }
  updatePetFromCatsMessages(messages);
}

async function fetchCatsMessagesPage(offset, limit=CATS_MESSAGES_PAGE_SIZE, topicId=catsState.topicId){
  return parseCatsResponse(await fetch(API+'/api/cats/messages?topic='+encodeURIComponent(topicId)+'&limit='+encodeURIComponent(limit)+'&offset='+encodeURIComponent(offset)));
}

async function loadCatsMessages(showErrors=true, options={}){
  const ownerKey=catsMessageOwnerKey(catsState);
  if(!ownerKey){
    resetCatsMessageCache();
    showCatsMessagePlaceholder('登录 CatsCo 后查看当前账号消息');
    return;
  }
  if(catsMessagesOwnerKey!==ownerKey){
    resetCatsMessageCache(ownerKey);
    options=Object.assign({}, options, {reset:true, forceBottom:true});
  }
  if(!catsState.topicId)return;
  if(catsMessagesLoading)return;
  catsMessagesLoading=true;
  const requestOwnerKey=ownerKey;
  const requestTopicId=catsState.topicId;
  try{
    if(catsMessagesTopicId!==requestTopicId){
      catsMessagesTopicId=requestTopicId;
      catsMessagesCache=[];
      catsMessagesHasOlder=true;
      options=Object.assign({}, options, {reset:true, forceBottom:true});
    }
    const data=await fetchCatsMessagesPage(0, CATS_MESSAGES_PAGE_SIZE, requestTopicId);
    if(!isCatsMessageRequestCurrent(requestOwnerKey, requestTopicId))return;
    const incoming=data.messages||[];
    if(options.reset || !catsMessagesCache.length){
      catsMessagesCache=incoming;
      catsMessagesHasOlder=incoming.length>=CATS_MESSAGES_PAGE_SIZE;
    }else{
      catsMessagesCache=mergeCatsMessages(catsMessagesCache,incoming);
    }
    renderCatsMessages(catsMessagesCache, {
      forceBottom: Boolean(options.forceBottom),
      preserveViewport: Boolean(options.preserveViewport) || (!catsScrollPinnedToBottom && !options.forceBottom),
    });
    if(showErrors) pulsePetState('success','消息已刷新',1400);
  }catch(e){
    if(showErrors)setCatsAction('加载消息失败：'+e.message,true);
  }finally{
    catsMessagesLoading=false;
  }
}

async function loadOlderCatsMessages(){
  if(!catsState.topicId || catsMessagesLoadingOlder || !catsMessagesHasOlder || !catsMessagesCache.length)return;
  const requestOwnerKey=catsMessageOwnerKey(catsState);
  const requestTopicId=catsState.topicId;
  catsMessagesLoadingOlder=true;
  renderCatsMessages(catsMessagesCache, {preserveViewport:true});
  try{
    const data=await fetchCatsMessagesPage(catsMessagesCache.length, CATS_MESSAGES_PAGE_SIZE, requestTopicId);
    if(!isCatsMessageRequestCurrent(requestOwnerKey, requestTopicId)){
      catsMessagesLoadingOlder=false;
      return;
    }
    const incoming=data.messages||[];
    if(incoming.length<CATS_MESSAGES_PAGE_SIZE)catsMessagesHasOlder=false;
    if(incoming.length){
      catsMessagesCache=mergeCatsMessages(incoming,catsMessagesCache);
    }
    catsMessagesLoadingOlder=false;
    renderCatsMessages(catsMessagesCache, {preserveViewport:true, prepended:incoming.length>0});
  }catch(e){
    setCatsAction('加载更早消息失败：'+e.message,true);
    catsMessagesLoadingOlder=false;
    renderCatsMessages(catsMessagesCache, {preserveViewport:true});
  }
}
