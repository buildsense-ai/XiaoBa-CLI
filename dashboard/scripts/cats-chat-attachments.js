function catsAttachmentKind(name, type){
  if(/^image\//i.test(String(type||'')))return 'IMG';
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(name||''))?'IMG':'FILE';
}

function catsAttachmentStatus(item){
  if(item.status==='sending')return '上传中';
  if(item.status==='sent')return '已发送';
  if(item.status==='error')return item.error||'附件授权无效';
  return '待发送';
}

function catsDesktopFilePickerAvailable(){
  return Boolean(window.catscoDesktop && typeof window.catscoDesktop.selectFiles==='function');
}

function renderCatsAttachments(){
  window.__catscoRenderCatsAttachments?.({
    items:catsAttachmentQueue.map(item=>({
      id:item.id,
      name:String(item.name||''),
      status:item.status||'queued',
      error:item.error||'',
      kind:catsAttachmentKind(item.name,item.type),
      meta:[formatBytes(item.size), catsAttachmentStatus(item)].filter(Boolean).join(' / '),
      removable:item.status!=='sending',
    })),
  });
}

function removeCatsAttachment(id){
  catsAttachmentQueue=catsAttachmentQueue.filter(item=>item.id!==id || item.status==='sending');
  renderCatsAttachments();
}

function normalizeCatsFileItem(file){
  const token=String(file?.token || file?.file_token || '').trim();
  const name=String(file?.name || '本地文件').trim() || '本地文件';
  const size=Number(file?.size || 0);
  const type=String(file?.type || '');
  const error=String(file?.error || '').trim();
  return {
    id: ++catsAttachmentSeq,
    name,
    size,
    type,
    token,
    status: token?'queued':'error',
    error: token?'':(error||'附件没有经过客户端文件选择器授权，请重新使用 + 按钮选择文件。'),
  };
}

function queueCatsFiles(files){
  const list=Array.from(files||[]).filter(Boolean);
  if(!list.length)return;
  catsAttachmentQueue.push(...list.map(normalizeCatsFileItem));
  renderCatsAttachments();
  const invalid=catsAttachmentQueue.filter(item=>!item.token);
  if(invalid.length)setCatsAction(invalid[0].error||'有附件没有客户端授权，请重新使用 + 按钮选择文件。', true);
  else pulsePetState('typing','已添加附件',1200);
}

async function chooseCatsFiles(){
  const stage=buildCatsChatStage();
  if(stage.key!=='ready'){
    renderCatsStatus();
    setCatsAction(stage.copy||'请先完成 CatsCo Chat 检查项',true);
    return;
  }

  if(!catsDesktopFilePickerAvailable()){
    setCatsAction(CATS_ATTACHMENT_BROWSER_MESSAGE, true);
    return;
  }

  try{
    const files=await window.catscoDesktop.selectFiles();
    queueCatsFiles(files);
  }catch(e){
    setCatsAction('打开文件选择失败：'+e.message,true);
  }
}

function autoResizeCatsMessageInput(source){
  window.__catscoResizeCatsComposerInput?.(source || undefined);
}

async function sendCatsMessage(){
  const content=String(window.__catscoGetCatsComposerDraft?.() || '').trim();
  const attachments=catsAttachmentQueue.filter(item=>item.status!=='sent');
  const invalid=attachments.filter(item=>!item.token);
  const sendable=attachments.filter(item=>item.token && item.status!=='sending');
  if(!content && !sendable.length)return;
  if(invalid.length){
    setCatsAction('有附件没有客户端授权，请移除后重新选择。',true);
    return;
  }
  const stage=buildCatsChatStage();
  if(stage.key!=='ready'){
    renderCatsStatus();
    setCatsAction(stage.copy||'请先完成 CatsCo Chat 检查项',true);
    return;
  }
  if(!catsState.topicId){setCatsAction('请先完成 CatsCo 连接和 agent 绑定',true);return;}
  window.__catscoRenderCatsComposer?.({sendDisabled:true,attachDisabled:true});
  pulsePetState('typing', sendable.length?'上传中...':'发送中...', 1400);
  try{
    sendable.forEach(item=>{item.status='sending';item.error='';});
    renderCatsAttachments();
    await parseCatsResponse(await fetch(API+'/api/cats/messages/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      topic_id:catsState.topicId,
      content,
      file_tokens:sendable.map(item=>item.token),
    })}));
    window.__catscoClearCatsComposerInput?.();
    autoResizeCatsMessageInput();
    sendable.forEach(item=>{item.status='sent';});
    catsAttachmentQueue=catsAttachmentQueue.filter(item=>item.status!=='sent');
    renderCatsAttachments();
    catsScrollPinnedToBottom=true;
    pulsePetState('success', '已发送', 1800);
    await loadCatsMessages(true, {forceBottom:true});
  }catch(e){
    sendable.forEach(item=>{
      if(item.status==='sending'){
        item.status='error';
        item.error=e.message;
      }
    });
    renderCatsAttachments();
    setCatsAction('发送失败：'+e.message,true);
  }finally{
    renderCatsStatus();
  }
}
