// === CatsCo Chat ===
let catsBotSelectorPayload = { state:'loading' };
let catsBotSelectorBusyBotUid = '';

function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function setCatsAction(text, isError){
  window.__catscoRenderCatsActionStatus?.({text:text||'',isError:Boolean(isError)});
  if (text) pulsePetState(isError ? 'error' : 'thinking', isError ? '连接异常' : text, isError ? 2600 : 1200);
}

function unlockCatsAuthFields(focusAccount=false){
  window.__catscoRenderCatsAuthButtons?.({authDisabled:false,registerDisabled:false,codeDisabled:false});
  if(focusAccount){
    setTimeout(()=>window.__catscoFocusCatsAccount?.(), 0);
  }
}

function setCatsAuthMode(mode){
  catsAuthMode=mode;
  window.__catscoRenderCatsAuthPanel?.({
    loginCopy:catsAuthHelpText(),
    mode,
    visible:!isCatsLoggedIn(),
  });
  unlockCatsAuthFields(mode==='login');
  setCatsAction('');
  updateCatsLayoutState();
}

function setCatsConnectCollapsed(collapsed, manual=false){
  catsConnectCollapsed=Boolean(collapsed);
  if(manual) catsConnectManualOverride=true;
  updateCatsLayoutState();
}

function toggleCatsConnectPanel(){
  setCatsConnectCollapsed(!catsConnectCollapsed, true);
}

async function parseCatsResponse(resp){
  const data=await resp.json().catch(()=>({}));
  if(!resp.ok){
    const error=new Error(data.error || ('HTTP '+resp.status));
    error.status=resp.status;
    error.data=data;
    error.action=data.action;
    throw error;
  }
  return data;
}

async function parseSimpleResponse(resp){
  const data=await resp.json().catch(()=>({}));
  if(!resp.ok) throw new Error((data.error && data.error.message) || data.message || data.error || ('HTTP '+resp.status));
  return data;
}

function getCatsEndpointFields(){
  const draft=window.__catscoGetCatsEndpointDraft?.()||{};
  return {
    httpBaseUrl: String(draft.httpBaseUrl||'').trim() || CATS_DEFAULT_HTTP_BASE,
    serverUrl: String(draft.serverUrl||'').trim() || CATS_DEFAULT_WS_URL,
  };
}

function getReadinessSection(id){
  return (appReadinessSnapshot.sections||[]).find(section=>section.id===id)||null;
}

function firstReadinessProblem(section){
  const checks=(section&&section.checks)||[];
  const active=checks.find(check=>check.status==='fail'&&check.severity==='blocker')
    || checks.find(check=>check.status!=='pass');
  return active?.message || section?.summary || '';
}

function isCatsLoggedIn(){
  return Boolean(catsState.connected && catsState.user && catsState.user.uid);
}

function isCatsBodyReady(bodyStatus){
  const state=String(bodyStatus?.state||'').toLowerCase();
  if(state==='conflict'||state==='auth_error')return false;
  if(bodyStatus?.active===true)return true;
  return state==='active'||state==='online';
}

function catsAuthHelpText(){
  if(catsState.authStatus==='invalid')return catsState.authError||'本地登录态已失效，请重新登录。';
  if(catsState.authStatus==='unchecked'&&catsState.authError)return catsState.authError;
  return '使用 CatsCo webapp（CatsCompany）同一账号登录。';
}

function buildCatsChatStage(){
  const connected=isCatsLoggedIn();
  const configured=Boolean(catsState.configured && catsState.botUid);
  const running=connected && configured && catsState.service?.status==='running' && isCatsBodyReady(catsState.bodyStatus||{});
  const topicReady=connected && configured && Boolean(catsState.topicId);
  const modelSection=getReadinessSection('model');
  const catscoSection=getReadinessSection('catsco');
  if(!connected){
    return {
      key:'needs-auth',
      status:'blocked',
      badge:'login',
      title:'登录 CatsCo',
      copy:catsAuthHelpText(),
      action:'auth',
      actionLabel:'登录或注册',
      inputPlaceholder:'先登录 CatsCo',
    };
  }
  if(!appReadinessLoaded || !modelSection || !catscoSection){
    return {
      key:'needs-readiness',
      status:'blocked',
      badge:'checking',
      title:'正在读取启动状态',
      copy:appReadinessError||'正在检查模型和连接状态。',
      action:'settings',
      actionLabel:'打开设置',
      inputPlaceholder:'等待启动状态检查',
    };
  }
  const modelBlocked=modelSection?.status==='blocked';
  if(modelBlocked){
    return {
      key:'needs-model',
      status:'blocked',
      badge:'blocked',
      title:'先完成模型来源',
      copy:firstReadinessProblem(modelSection)||'请选择可用模型来源。',
      action:'settings',
      actionLabel:'打开设置',
      inputPlaceholder:'先完成模型来源设置',
    };
  }
  const bodyStatus=catsState.bodyStatus||{};
  if(bodyStatus.state==='conflict'){
    return {
      key:'body-conflict',
      status:'blocked',
      badge:'conflict',
      title:'另一个设备正在运行这个 agent',
      copy:'CatsCo 平台显示这个机器人当前已由另一个 body 连接。请停止那边的进程，或重新选择/创建当前设备自己的 agent。',
      action:'bot-selector',
      actionLabel:'选择机器人',
      inputPlaceholder:'等待当前设备成为 active body',
    };
  }
  if(bodyStatus.state==='auth_error'){
    return {
      key:'body-auth-error',
      status:'blocked',
      badge:'blocked',
      title:'当前账号不能管理这个 agent',
      copy:bodyStatus.error||'CatsCo 平台拒绝查询这个 bot 的 body 状态。请确认当前账号和绑定的 agent 是否匹配。',
      action:'bot-selector',
      actionLabel:'重新选择',
      inputPlaceholder:'先重新选择或绑定 CatsCo agent',
    };
  }
  if(catscoSection.status==='blocked'){
    return {
      key:'needs-catsco-readiness',
      status:'blocked',
      badge:'blocked',
      title:'完善 CatsCo 连接',
      copy:firstReadinessProblem(catscoSection)||'连接检查未通过。',
      action:'bot-selector',
      actionLabel:'选择机器人',
      inputPlaceholder:'先完成 CatsCo 连接检查',
    };
  }
  if(!configured){
    return {
      key:'needs-binding',
      status:'blocked',
      badge:'bind',
      title:'绑定 CatsCo agent',
      copy:'登录已完成，需要绑定本地 agent。',
      action:'bot-selector',
      actionLabel:'选择机器人',
      inputPlaceholder:'先绑定 CatsCo agent',
    };
  }
  if(!running){
    return {
      key:'needs-connector',
      status:'warning',
      badge:'start',
      title:'启动 CatsCompany connector',
      copy:'已绑定，启动后接收网页消息。',
      action:'setup',
      actionLabel:'自动启动中',
      inputPlaceholder:'先启动 CatsCompany connector',
    };
  }
  if(!topicReady){
    return {
      key:'needs-topic',
      status:'blocked',
      badge:'topic',
      title:'准备 Chat 会话',
      copy:'正在准备可对话会话。',
      action:'setup',
      actionLabel:'重新检查',
      inputPlaceholder:'先准备 Chat 会话',
    };
  }
  return {
    key:'ready',
    status:'ready',
    badge:'ready',
    title:'可以直接对话',
    copy:'已连接网页会话，本地 agent 会回复。',
    action:'refresh',
    actionLabel:'刷新消息',
    inputPlaceholder:'输入消息，Enter 发送，Shift+Enter 换行',
  };
}

function catsAutoStartReason(stage){
  if(!isCatsLoggedIn())return '';
  const service=catsState.service||{};
  const bodyStatus=catsState.bodyStatus||{};
  if(bodyStatus.state==='conflict'||bodyStatus.state==='auth_error')return '';
  if(!catsState.bodyConfigured || !catsState.botUid || !catsState.configured)return 'binding';
  if(service.status!=='running')return 'connector';
  if(stage?.key==='needs-topic' || !catsState.topicId)return 'topic';
  return '';
}

function catsAutoStartReadinessSafe(reason){
  if(!reason || !appReadinessLoaded)return false;
  const modelSection=getReadinessSection('model');
  if(modelSection?.status==='blocked')return false;
  const catscoSection=getReadinessSection('catsco');
  const allowedCatscoBlockers=new Set(['catsco.binding','catsco.topic','catsco.connector']);
  return !(catscoSection?.checks||[]).some(check=>
    check.status==='fail' &&
    check.severity==='blocker' &&
    !allowedCatscoBlockers.has(check.id)
  );
}

function catsAutoStartKey(reason, stage){
  const userUid=String(catsState.user?.uid||'').trim();
  const botUid=String(catsState.botUid||catsState.bot?.uid||'auto').trim()||'auto';
  const serviceStatus=String(catsState.service?.status||'missing');
  return [
    userUid,
    botUid,
    reason,
    stage?.key||'',
    serviceStatus,
    activeStartupSource(),
    relayModelIdForSetup()||'',
  ].join('|');
}

function maybeAutoStartCats(stage){
  if(getDashboardActivePage()!=='chat')return;
  if(catsAutoStartInFlight || relayActionBusy() || catsStatusMutationInFlight)return;
  const reason=catsAutoStartReason(stage);
  if(!catsAutoStartReadinessSafe(reason))return;
  const key=catsAutoStartKey(reason, stage);
  const now=Date.now();
  if(key && catsAutoStartAttemptKey===key && now-catsAutoStartAttemptAt<60000)return;
  catsAutoStartAttemptKey=key;
  catsAutoStartAttemptAt=now;
  setCatsAutoStartBusy(true);
  const message=reason==='binding'
    ? '正在自动选择机器人并启动 CatsCompany connector...'
    : '正在自动启动 CatsCompany connector...';
  setCatsAction(message);
  setTimeout(async()=>{
    try{
      await setupCatsBot({forceLegacySetup:true, automatic:true});
    }catch(e){
      setCatsAction('自动启动失败：'+formatDashboardApiError(e,'/api/cats/setup'), true);
    }finally{
      setCatsAutoStartBusy(false);
    }
  },0);
}

function renderCatsChecklist(stage){
  const service=catsState.service||{};
  const user=catsState.user||{};
  const connected=isCatsLoggedIn();
  if(!connected){
    window.__catscoRenderCatsChecklist?.({connected:false,steps:[]});
    return;
  }
  const configured=Boolean(catsState.configured);
  const bodyReady=isCatsBodyReady(catsState.bodyStatus||{});
  const running=service.status==='running'&&bodyReady;
  const topicReady=connected && configured && Boolean(catsState.topicId);
  const accountMeta=connected
    ? (user.display_name||user.username||'已登录')
    : (catsState.authStatus==='invalid'?'登录失效':'未登录');
  const modelSection=getReadinessSection('model');
  const modelStatus=modelSection
    ? (modelSection.status==='blocked'?'fail':modelSection.status==='warning'?'warning':'pass')
    : 'fail';
  const steps=[
    {label:'模型来源', status:modelStatus, meta:modelSection?firstReadinessProblem(modelSection)||modelSection.summary:'等待 readiness'},
    {label:'CatsCo 账号', status:connected?'pass':'fail', meta:accountMeta},
    {label:'Agent 绑定', status:configured?'pass':'fail', meta:configured&&catsState.botUid?((catsState.bot?.name||catsState.botName||'uid '+catsState.botUid)):'未绑定'},
    {label:'CatsCompany connector', status:running?'pass':(configured?'warning':'fail'), meta:running?'运行中':(service.status==='running'?'等待 body online':'未运行')},
    {label:'Chat 会话', status:topicReady?'pass':'fail', meta:topicReady?'已就绪':'等待 topic'},
  ];
  const visibleSteps=steps.filter(step=>step.status==='fail'||step.status==='warning');
  window.__catscoRenderCatsChecklist?.({connected:true,steps:visibleSteps});
}

function updateCatsChatGate(stage){
  const connected=isCatsLoggedIn();
  const connectedCardOwnsAction=connected && (stage.action==='setup' || stage.action==='refresh');
  catsNextAction=stage.action;
  window.__catscoRenderCatsGate?.({
    actionLabel:stage.actionLabel||'查看',
    badge:stage.badge,
    compact:connectedCardOwnsAction,
    copy:stage.copy,
    showAction:!(stage.action==='none'||connectedCardOwnsAction),
    stateClass:readinessStatusClass(stage.status),
    status:stage.status,
    title:stage.title,
  });
  window.__catscoRenderCatsConnectionMeta?.({
    detailsSummary:stage.key==='ready'?'ready':'needs attention',
    diagnosticsVisible:isCatsLoggedIn(),
    topicLabel:catsState.topicId?('Topic: '+catsState.topicId):'尚未绑定会话',
  });
  const locked=stage.key!=='ready';
  const desktopPickerReady=catsDesktopFilePickerAvailable();
  window.__catscoRenderCatsComposer?.({
    attachDisabled:locked || !desktopPickerReady,
    attachNoteHidden:locked || desktopPickerReady,
    attachNoteText:CATS_ATTACHMENT_BROWSER_MESSAGE,
    attachTitle:desktopPickerReady?'添加本地文件':CATS_ATTACHMENT_BROWSER_MESSAGE,
    inputDisabled:locked,
    inputPlaceholder:stage.inputPlaceholder||'等待 CatsCo Chat 检查完成',
    locked,
    sendDisabled:locked,
  });
  autoResizeCatsMessageInput();
}

function runCatsNextAction(){
  if(catsNextAction==='settings')return switchPage('services');
  if(catsNextAction==='setup')return setupCatsBot();
  if(catsNextAction==='bot-selector')return showBotSelector();
  if(catsNextAction==='refresh')return loadCatsMessages(true);
  if(catsNextAction==='auth'){
    window.__catscoFocusCatsAccount?.();
    return;
  }
  window.__catscoSetCatsConnectionDetailsOpen?.(true);
}

function catsMessageOwnerKey(state){
  const uid=String(state?.user?.uid||'').trim();
  const topic=String(state?.topicId||'').trim();
  return uid && topic ? uid+'|'+topic : '';
}

function catsAccountOwnerKey(state){
  return String(state?.user?.uid||'').trim();
}

function isCatsMessageRequestCurrent(ownerKey, topicId){
  return ownerKey
    && ownerKey===catsMessageOwnerKey(catsState)
    && String(topicId||'')===String(catsState.topicId||'');
}

function resetCatsMessageCache(ownerKey=''){
  catsMessagesCache=[];
  catsMessagesHasOlder=true;
  catsMessagesLoading=false;
  catsMessagesLoadingOlder=false;
  catsMessagesTopicId='';
  catsMessagesOwnerKey=ownerKey;
  catsScrollPinnedToBottom=true;
}

function showCatsMessagePlaceholder(text){
  window.__catscoRenderCatsMessages?.({empty:true,emptyText:String(text||'')});
  catsWorkingActive=false;
  applyPetBaseline();
}

function invalidateCatsStatusRequests(){
  catsStatusGeneration+=1;
  return catsStatusGeneration;
}

function setCatsStatusMutationBusy(busy){
  catsStatusMutationInFlight=Boolean(busy);
}

async function fetchCatsStatus(options={}){
  const priority=Boolean(options.priority);
  if(catsStatusMutationInFlight && !priority)return;
  const requestGeneration=catsStatusGeneration;
  try{
    const previousOwnerKey=catsMessagesOwnerKey;
    const data=await parseCatsResponse(await fetch(API+'/api/cats/status'));
    if(requestGeneration!==catsStatusGeneration || (catsStatusMutationInFlight && !priority))return;
    catsState=data||{};
    const nextOwnerKey=catsMessageOwnerKey(catsState);
    if(!nextOwnerKey){
      resetCatsMessageCache();
      showCatsMessagePlaceholder('登录 CatsCo 后查看当前账号消息');
    }else if(previousOwnerKey && previousOwnerKey!==nextOwnerKey){
      resetCatsMessageCache(nextOwnerKey);
      showCatsMessagePlaceholder('正在加载当前账号消息...');
    }else if(!previousOwnerKey){
      catsMessagesOwnerKey=nextOwnerKey;
    }
    renderCatsStatus();
    if((dashboardSettingsSnapshot.fields||[]).length && !shouldDeferModelSourceRender())renderModelSource(dashboardSettingsSnapshot);
    if(isCatsLoggedIn() && !relayModelConfigSnapshot)fetchRelayModelConfig();
    if(catsState.topicId) loadCatsMessages(false);
  }catch(e){
    if(requestGeneration!==catsStatusGeneration || (catsStatusMutationInFlight && !priority))return;
    const statusError='状态加载失败：'+(e.message||String(e));
    window.__catscoRenderCatsStatusList?.({errorText:statusError});
  }
}

function updateCatsLayoutState(stage){
  const connected=isCatsLoggedIn();
  const configured=Boolean(catsState.configured);
  const chatStage=stage||buildCatsChatStage();
  const ready=chatStage.key==='ready';
  const needsSetup=connected && (chatStage.action==='setup'||chatStage.action==='bot-selector');
  if(!ready){
    catsConnectCollapsed=false;
    catsConnectManualOverride=false;
  }else if(!catsConnectManualOverride){
    catsConnectCollapsed=true;
  }
  window.__catscoRenderCatsLayout?.({
    shellCollapsed:ready && catsConnectCollapsed,
    connectNeedsAuth:!connected,
    connectNeedsSetup:needsSetup || (connected && !configured),
    connectExpanded:!connected || needsSetup || (connected && !configured),
  });
  window.__catscoRenderCatsConnectToggle?.({
    collapsed:catsConnectCollapsed,
    title:catsConnectCollapsed?'展开连接面板':'收起连接面板',
    visible:ready,
  });
}

function renderCatsStatus(){
  const service=catsState.service||{};
  const user=catsState.user||{};
  const running=service.status==='running';
  const connected=isCatsLoggedIn();
  const configured=Boolean(catsState.configured);
  const stage=buildCatsChatStage();
  const bodyStatus=catsState.bodyStatus||{};
  const botLabel=catsState.bot?.name||catsState.botName||catsState.bot?.username||catsState.botUid||'未命名 agent';
  const accountMetaText=connected
    ? (user.display_name||user.username||'已登录')
    : (catsState.authStatus==='invalid'?'登录失效':'未登录');
  window.__catscoRenderCatsStatusList?.({rows:[
    {label:'账号',value:accountMetaText},
    {label:'CatsCo Agent',value:String(botLabel)},
    {label:'Body',value:String(bodyStatus.state||'unknown')},
    {label:'Topic',value:catsState.topicId?String(catsState.topicId):'未绑定'},
    {label:'CatsCompany connector',value:running?'运行中':'未运行',tone:running?'green':'orange'},
  ]});

  const endpointDraft=window.__catscoGetCatsEndpointDraft?.()||{};
  window.__catscoSetCatsEndpointDraft?.({
    httpBaseUrl:endpointDraft.httpBaseUrl || catsState.httpBaseUrl || CATS_DEFAULT_HTTP_BASE,
    serverUrl:endpointDraft.serverUrl || catsState.serverUrl || CATS_DEFAULT_WS_URL,
  });
  window.__catscoRenderCatsAuthPanel?.({
    loginCopy:catsAuthHelpText(),
    mode:catsAuthMode,
    visible:!connected,
  });
  if(!connected)unlockCatsAuthFields(false);
  const connectedCopy=configured
    ? (running?'可以直接开始对话。':'已绑定 agent，正在自动启动或检查 CatsCompany connector。')
    : '请选择或创建当前设备自己的 agent。';
  const showSetup=false;
  const setupLabel=!configured?'选择机器人':'重新检查';
  window.__catscoRenderCatsConnectedCard?.({
    copy:connectedCopy,
    setupDisabled:relayActionBusy(),
    setupLabel,
    showSetup,
    visible:connected,
  });
  renderCatsRelayModelPanel();
  renderCatsChecklist(stage);
  updateCatsChatGate(stage);
  updateCatsLayoutState(stage);
  maybeAutoStartCats(stage);
}

function renderBotSelectorListState(payload) {
  catsBotSelectorPayload = payload || { state:'loading' };
  window.__catscoRenderBotSelectorList?.({ ...catsBotSelectorPayload, busyBotUid: catsBotSelectorBusyBotUid });
}

function setBotSelectorBusyState(state = {}) {
  if (Object.prototype.hasOwnProperty.call(state, 'createBusy')) {
    window.__catscoSetBotSelectorCreateBusy?.(Boolean(state.createBusy));
  }
  if (Object.prototype.hasOwnProperty.call(state, 'busyBotUid')) {
    catsBotSelectorBusyBotUid = String(state.busyBotUid || '');
    window.__catscoRenderBotSelectorList?.({ ...catsBotSelectorPayload, busyBotUid: catsBotSelectorBusyBotUid });
  }
}

async function showBotSelector() {
  window.__catscoSetBotSelectorOpen?.(true);
  renderBotSelectorListState({ state:'loading' });

  try {
    const data = await parseCatsResponse(await fetch(API + '/api/cats/bots'));
    if (!data.bots?.length) {
      renderBotSelectorListState({
        state:'empty',
        message:'No bots available. You can create a new CatsCo agent for this device.',
      });
      return;
    }
    renderBotSelectorListState({ state:'ready', bots:data.bots || [] });
  } catch (e) {
    renderBotSelectorListState({ state:'error', message:'Load failed: ' + (e.message || String(e)) });
  }
}

function catsDefaultDeviceName() {
  const platform = String(navigator.platform || '').trim();
  return platform || '当前设备';
}

async function createCatsBotAndBind(button) {
  const defaultName = `CatsCo (${catsDefaultDeviceName()})`;
  const botDisplayName = prompt('为当前设备创建一个新的 CatsCo agent：', defaultName);
  if (botDisplayName === null) return;
  setBotSelectorBusyState({ createBusy:true });
  setCatsAction('正在创建新的 CatsCo agent...');

  try {
    const created = await parseCatsResponse(await fetch(API + '/api/cats/create-bot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...getCatsEndpointFields(),
        deviceName: catsDefaultDeviceName(),
        botDisplayName: String(botDisplayName || defaultName).trim() || defaultName,
      }),
    }));
    await bindCatsBot(created.bot?.uid, created.bot?.display_name || botDisplayName || defaultName, button, {
      confirm: false,
    });
  } catch (e) {
    setCatsAction('创建失败: ' + e.message, true);
  } finally {
    setBotSelectorBusyState({ createBusy:false });
  }
}

async function bindCatsBot(botUid, botName, button, options) {
  const name = botName || '未命名机器人';
  if (!botUid) {
    setCatsAction('绑定失败：缺少 bot uid', true);
    return;
  }
  if (options?.confirm !== false && !confirm(`确定把当前设备上的 agent 绑定到 "${name}" 吗？`)) return;

  setBotSelectorBusyState({ busyBotUid:botUid });
  const setupRelayModel=shouldSetupRelayOnCatsSetup();
  setCatsAction(setupRelayModel?`正在确认中转模型、绑定 ${name} 并启动 connector...`:`正在绑定 ${name} 并按当前自定义模型启动 connector...`);

  try {
    const data = await parseCatsResponse(await fetch(API + '/api/cats/bind-bot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...getCatsEndpointFields(),
        botUid,
        setupRelayModel,
        relayModelId:setupRelayModel ? (relayModelIdForSetup()||undefined) : undefined,
        rotateRelayKey:Boolean(options?.rotateRelayKey),
      }),
    }));
    pendingStartupSource='';
    pendingRelayModelId='';
    catsState = {
      ...catsState,
      ...data,
      connected: true,
      configured: true,
      botUid: data.bot?.uid || botUid,
      botName: data.bot?.display_name || name,
      topicId: data.topicId,
      user: data.user || catsState.user,
      service: data.service,
    };
    closeBotSelector();
    await fetchStatus();
    await fetchCatsStatus({priority:true});
    renderCatsStatus();
    const warningText=catsSetupWarningText(data);
    const readyMessage=data.message || `已绑定 ${name}。可以直接开始对话。`;
    setCatsAction(warningText?readyMessage+' 但有提示：'+warningText:readyMessage);
    pulsePetState('success', '已绑定', 1800);
    await loadCatsMessages(true, { reset: true, forceBottom: true });
  } catch (e) {
    if(e.status===409 && e.action==='rotate_required'){
      const ok=confirm('你的 CatsCo 中转 Key 已存在，但当前无法读取明文。要重新生成并写入 CatsCo 桌面端吗？旧 Key 会立即失效。');
      if(ok){
        await bindCatsBot(botUid, botName, button, {...options, confirm:false, rotateRelayKey:true});
        return;
      }
      setCatsAction('已取消。你也可以在 CatsCompany 中转站页面复制现有配置后手动填写。', true);
    }else{
      setCatsAction('绑定失败: ' + formatDashboardApiError(e,'/api/cats/bind-bot'), true);
    }
  } finally {
    setBotSelectorBusyState({ busyBotUid:'' });
  }
}

function closeBotSelector() {
  window.__catscoSetBotSelectorOpen?.(false);
}

async function handleCatsSetupAction() {
  if (!isCatsLoggedIn()) {
    setCatsAction('请先登录 CatsCo。', true);
    return;
  }
  const service = catsState.service || {};
  if (!catsState.configured || !catsState.botUid) {
    return showBotSelector();
  }
  const bodyStatus = catsState.bodyStatus || {};
  if (bodyStatus.state === 'conflict') {
    setCatsAction('当前 agent 正在另一台设备运行。请停止那边的进程，或重新选择/创建当前设备自己的 agent。', true);
    return showBotSelector();
  }
  if (bodyStatus.state === 'auth_error') {
    setCatsAction(bodyStatus.error || '当前账号不能管理这个 agent，请重新选择或绑定。', true);
    return showBotSelector();
  }
  if (service.status === 'running') {
    await fetchCatsStatus();
    setCatsAction('CatsCompany connector 已在运行。');
    return;
  }
  return bindCatsBot(catsState.botUid, catsState.botName || catsState.bot?.name || catsState.botUid, null, { confirm: false });
}

async function sendCatsCode(){
  const authDraft=window.__catscoGetCatsAuthDraft?.()||{};
  const email=String(authDraft.email||'').trim();
  if(!email){setCatsAction('请输入邮箱地址',true);return;}
  window.__catscoRenderCatsAuthButtons?.({codeDisabled:true,codeLabel:'发送中...'});
  try{
    await parseCatsResponse(await fetch(API+'/api/cats/auth/send-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...getCatsEndpointFields(),email})}));
    setCatsAction('验证码已发送，请检查邮箱。');
    pulsePetState('success', '验证码已发送', 1800);
  }catch(e){
    setCatsAction('发送验证码失败：'+e.message,true);
  }finally{
    window.__catscoRenderCatsAuthButtons?.({codeDisabled:false,codeLabel:'发送验证码'});
  }
}

async function submitCatsAuth(){
  window.__catscoRenderCatsAuthButtons?.(catsAuthMode==='login'?{authDisabled:true}:{registerDisabled:true});
  setCatsAction(catsAuthMode==='login'?'正在登录...':'正在注册...');
  try{
    const endpoint=getCatsEndpointFields();
    const authDraft=window.__catscoGetCatsAuthDraft?.()||{};
    if(catsAuthMode==='login'){
      const account=String(authDraft.account||'').trim();
      const password=String(authDraft.password||'');
      await parseCatsResponse(await fetch(API+'/api/cats/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...endpoint,account,password})}));
    }else{
      const email=String(authDraft.email||'').trim();
      const username=String(authDraft.username||'').trim();
      const password=String(authDraft.registerPassword||'');
      const code=String(authDraft.code||'').trim();
      await parseCatsResponse(await fetch(API+'/api/cats/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...endpoint,email,username,password,code})}));
    }
    window.__catscoSetCatsAuthDraft?.({password:'',registerPassword:''});
    invalidateRelayModelConfigRequests();
    invalidateCatsStatusRequests();
    setCatsAction('登录态已保存。请选择要绑定的 CatsCo agent。');
    await fetchCatsStatus();
    pulsePetState('success', '已登录', 1800);
  }catch(e){
    setCatsAction('连接失败：'+e.message,true);
  }finally{
    window.__catscoRenderCatsAuthButtons?.(catsAuthMode==='login'?{authDisabled:false}:{registerDisabled:false});
  }
}

async function setupCatsBot(options={}){
  if(!options.forceLegacySetup){
    return handleCatsSetupAction();
  }
  if(catsSetupInFlight){
    setCatsAction('正在配置 CatsCo 连接，请稍候...');
    return;
  }
  if(relayModelApplyInFlight){
    setCatsAction('模型切换正在进行，请稍候...');
    return;
  }
  setCatsSetupBusy(true);
  setCatsStatusMutationBusy(true);
  invalidateCatsStatusRequests();
  let retrying=false;
  const automatic=options.automatic===true;
  if(!(dashboardSettingsSnapshot.fields||[]).length){
    await fetchDashboardSettings();
  }
  const setupRelayModel=shouldSetupRelayOnCatsSetup();
  setCatsAction(setupRelayModel?'正在确认中转模型、绑定 agent 并启动 connector...':'正在绑定 agent 并按当前自定义模型启动 connector...');
  try{
    const data=await parseCatsResponse(await fetch(API+'/api/cats/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      ...getCatsEndpointFields(),
      setupRelayModel,
      relayModelId:setupRelayModel ? (relayModelIdForSetup()||undefined) : undefined,
      rotateRelayKey:Boolean(options.rotateRelayKey),
    })}));
    pendingStartupSource='';
    pendingRelayModelId='';
    catsState={...catsState,...data, connected:true, configured:true, botUid:data.bot?.uid||data.botUid, topicId:data.topicId, user:data.user, service:data.service};
    await fetchStatus();
    await fetchCatsStatus({priority:true});
    renderCatsStatus();
    const stage=buildCatsChatStage();
    const warningText=catsSetupWarningText(data);
    if(stage.key==='ready'){
      const readyMessage=data.connectorRestarted?'已重启 connector，可以直接开始对话。':'已连接。可以直接开始对话。';
      setCatsAction(warningText?readyMessage+' 但有提示：'+warningText:readyMessage);
      pulsePetState('success', '已连接', 2200);
      await loadCatsMessages(true, {reset:true, forceBottom:true});
    }else{
      const stageMessage=stage.copy||'已保存配置，请按当前检查项继续。';
      setCatsAction(warningText?stageMessage+' 提示：'+warningText:stageMessage, stage.status==='blocked');
    }
  }catch(e){
    if(e.status===409 && e.action==='rotate_required'){
      if(automatic){
        setCatsAction('自动启动需要重新生成 CatsCo 中转 Key。请在 CatsCo 中转站撤销删除当前 Key，然后回到 Dashboard 重新选择模型，系统会自动创建并写入新的 Key。', true);
        return;
      }
      const ok=confirm('你的 CatsCo 中转 Key 已存在，但当前无法读取明文。要重新生成并写入 CatsCo 桌面端吗？旧 Key 会立即失效。');
      if(ok){
        retrying=true;
        setCatsSetupBusy(false);
        setCatsStatusMutationBusy(false);
        return setupCatsBot({forceLegacySetup:true, rotateRelayKey:true});
      }
      setCatsAction('已取消。你也可以在 CatsCompany 中转站页面复制现有配置后手动填写。', true);
    }else{
      setCatsAction('绑定失败：'+formatDashboardApiError(e,'/api/cats/setup'),true);
    }
  }finally{
    if(!retrying){
      setCatsStatusMutationBusy(false);
      setCatsSetupBusy(false);
    }
  }
}

async function resetCatsAuth(){
  if(!confirm('是否切换 CatsCo 账号？这会清除本地保存的登录态，但不会删除 CatsCo 账号或 agent。'))return;
  try{
    setCatsStatusMutationBusy(true);
    invalidateCatsStatusRequests();
    invalidateRelayModelConfigRequests();
    await parseCatsResponse(await fetch(API+'/api/cats/auth/logout',{method:'POST'}));
    catsState={};
    catsWorkingActive=false;
    resetCatsMessageCache();
    lastCatsMessageSignature='';
    catsScrollPinnedToBottom=true;
    window.__catscoSetCatsAuthDraft?.({account:'',password:''});
    window.__catscoRenderCatsMessages?.({empty:true,emptyText:'连接 CatsCo 后开始对话'});
    setCatsAuthMode('login');
    renderCatsStatus();
    await fetchCatsStatus({priority:true});
    setCatsAuthMode('login');
    unlockCatsAuthFields(true);
    applyPetBaseline();
    setCatsAction('已清除本地登录态。');
  }catch(e){
    setCatsAction('切换账号失败：'+e.message,true);
  }finally{
    setCatsStatusMutationBusy(false);
  }
}
