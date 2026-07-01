const CUSTOM_MODEL_CONTEXT_WINDOW_OPTIONS=[
  {value:'128000',label:'128K',hint:'安全默认'},
  {value:'200000',label:'200K',hint:'常见中长上下文'},
  {value:'256000',label:'256K',hint:'长文档'},
  {value:'512000',label:'512K',hint:'超长文档'},
  {value:'1000000',label:'1M',hint:'百万上下文'},
];

async function refreshSettingsPage(){
  await Promise.all([fetchDashboardSettings(), fetchReadiness(), fetchConfig()]);
}

function openCustomModelSettings(){
  customModelSettingsOpen=true;
  syncCustomModelToggleButton();
  window.__catscoScrollCustomModelSettings?.('start');
}

function toggleCustomModelSettings(){
  customModelSettingsOpen=!customModelSettingsOpen;
  syncCustomModelToggleButton();
  if(customModelSettingsOpen){
    window.__catscoScrollCustomModelSettings?.('nearest');
  }
}

function syncCustomModelToggleButton(){
  window.__catscoRenderCustomModelToggle?.({open:customModelSettingsOpen});
}

function handleCustomModelToggle(open){
  customModelSettingsOpen=Boolean(open);
  syncCustomModelToggleButton();
}

async function fetchDashboardSettings(){
  try{
    const r=await fetch(API+'/api/settings');
    const data=await r.json();
    if(!r.ok||data.error)throw new Error(data.error||'settings 加载失败');
    dashboardSettingsSnapshot=data;
    if(!shouldDeferModelSourceRender()) renderModelSource(data);
    fetchRelayModelConfig();
  }catch(e){
    window.__catscoRenderModelSource?.({fieldsAvailable:false});
  }
}

function settingField(id){
  return (dashboardSettingsSnapshot.fields||[]).find(field=>field.id===id)||{};
}

function settingValue(id){
  return settingField(id).value||'';
}

function shouldDeferModelSourceRender(){
  if(getDashboardActivePage() !== 'services')return false;
  return customModelSettingsOpen || Boolean(window.__catscoCustomModelHasFocus?.());
}

function invalidateRelayModelConfigRequests(){
  relayModelConfigRequestSeq+=1;
  relayModelConfigSnapshot=null;
  relayModelConfigLoading=false;
}

function isRelayModelConfigRequestCurrent(requestGeneration, requestSeq, requestAccountKey){
  return requestGeneration===catsStatusGeneration
    && requestSeq===relayModelConfigRequestSeq
    && requestAccountKey
    && requestAccountKey===catsAccountOwnerKey(catsState)
    && isCatsLoggedIn();
}

async function fetchRelayModelConfig(){
  if(!isCatsLoggedIn())return;
  const requestGeneration=catsStatusGeneration;
  const requestAccountKey=catsAccountOwnerKey(catsState);
  const requestSeq=++relayModelConfigRequestSeq;
  relayModelConfigLoading=true;
  try{
    const r=await fetch(API+'/api/cats/relay/model-config');
    const data=await r.json().catch(()=>({}));
    if(!r.ok||data.error)throw new Error(data.error||'中转模型目录加载失败');
    if(!isRelayModelConfigRequestCurrent(requestGeneration, requestSeq, requestAccountKey))return;
    relayModelConfigSnapshot=data;
    if((dashboardSettingsSnapshot.fields||[]).length && !shouldDeferModelSourceRender())renderModelSource(dashboardSettingsSnapshot);
    if(getDashboardActivePage() === 'chat')renderCatsStatus();
  }catch(_e){
    if(isRelayModelConfigRequestCurrent(requestGeneration, requestSeq, requestAccountKey))relayModelConfigSnapshot=null;
  }finally{
    if(requestSeq===relayModelConfigRequestSeq)relayModelConfigLoading=false;
  }
}

function relayModelCatalog(){
  if(Array.isArray(relayModelConfigSnapshot?.models)){
    return relayModelConfigSnapshot.models.filter(model=>model && model.enabled!==false && model.model);
  }
  return RELAY_FALLBACK_MODELS;
}

function formatModelContextLabel(tokens, fallback){
  if(fallback)return fallback;
  const n=Number(tokens||0);
  if(!Number.isFinite(n)||n<=0)return '安全默认';
  if(n>=1000000){
    const v=n/1000000;
    return (Number.isInteger(v)?String(v):v.toFixed(1))+'M';
  }
  if(n>=1000){
    const v=n/1000;
    return (Number.isInteger(v)?String(v):v.toFixed(1))+'K';
  }
  return String(n);
}

function customModelContextWindowOptions(){
  const field=settingField('model.contextWindowTokens');
  const options=Array.isArray(field.options) ? field.options : [];
  const normalized=options.map(value=>String(value||'').trim()).filter(Boolean);
  return normalized.length?normalized:CUSTOM_MODEL_CONTEXT_WINDOW_OPTIONS.map(option=>option.value);
}

function customModelContextWindowValue(rawValue){
  const raw=String(rawValue || customStartupProfile().contextWindowTokens || settingValue('model.contextWindowTokens') || '128000');
  return customModelContextWindowOptions().includes(raw)?raw:'128000';
}

function customModelContextWindowLabel(){
  return formatModelContextLabel(Number(customModelContextWindowValue()));
}

function modelStartupSnapshot(){
  return dashboardSettingsSnapshot?.modelStartup || {};
}

function customStartupProfile(){
  return modelStartupSnapshot().custom || {};
}

function relayStartupProfile(){
  return modelStartupSnapshot().relay || {};
}

function isCustomStartupConfigured(){
  const custom=customStartupProfile();
  const provider=custom.provider || settingValue('model.provider');
  return Boolean(custom.configured || (provider && settingValue('model.apiBase') && settingValue('model.model') && settingField('model.apiKey').present));
}

function activeStartupSource(){
  if(pendingStartupSource==='relay')return 'relay';
  if(pendingStartupSource==='custom' && isCustomStartupConfigured())return 'custom';
  const startup=modelStartupSnapshot();
  if(startup.source==='relay' && (relayStartupProfile().configured || relayModelConfigSnapshot?.configured))return 'relay';
  if(startup.source==='custom' && isCustomStartupConfigured())return 'custom';
  if(relayModelConfigSnapshot?.configured)return 'relay';
  if(isCustomStartupConfigured())return 'custom';
  return '';
}

function selectedRelayModelId(){
  if(pendingStartupSource==='relay' && pendingRelayModelId)return pendingRelayModelId;
  const configuredModel=relayModelConfigSnapshot?.configured ? relayModelConfigSnapshot?.selectedModel : null;
  if(configuredModel?.id)return configuredModel.id;
  const relayModel=relayStartupProfile().model;
  const currentModel=(relayModel || (isCatsRelayModelGateway(settingValue('model.apiBase'))?settingValue('model.model'):'') || '').toLowerCase();
  const models=relayModelCatalog();
  const matched=currentModel?models.find(model=>String(model.model||'').toLowerCase()===currentModel):null;
  return (matched||models.find(model=>model.default)||models[0]||{}).id||'';
}

function renderCatsRelayModelPanel(){
  const catsConnected=isCatsLoggedIn();
  const models=relayModelCatalog();
  const source=activeStartupSource();
  const relayActiveId=source==='relay'?selectedRelayModelId():'';
  const selectedRelayId=selectedRelayModelId();
  const activeModel=source==='relay'
    ? (models.find(model=>String(model.id||model.model||'')===selectedRelayId)||null)
    : null;
  const service=catsState.service||{};
  const configured=Boolean(catsState.configured);
  const activationCopy=service.status==='running'
    ? '切换后自动重启。'
    : configured
      ? '切换后会尝试直接启动。'
      : catsConnected?'先选模型，再检查启动。':'先选模型，登录后自动接入。';
  const relayChoices=models.map(model=>{
    const id=String(model.id||model.model||'');
    const quota=model.quota_class==='flash-low'?'低额度 Flash':model.quota_class==='multimodal'?'多模态':'标准额度';
    const sdkLabel=model.sdk_label || (String(model.provider||model.protocol||'').toLowerCase().includes('openai')?'OpenAI SDK':'Anthropic SDK');
    const contextLabel=formatModelContextLabel(model.context_window_tokens, model.context_label);
    return {
      id,
      active:id===relayActiveId,
      disabled:relayActionBusy(),
      label:String(model.label||model.model||id),
      modelName:String(model.model||id),
      meta:quota+' · 上下文 '+contextLabel+' · '+sdkLabel,
    };
  });
  const custom=customStartupProfile();
  const customConfigured=isCustomStartupConfigured();
  const customProvider=custom.provider || settingValue('model.provider') || 'anthropic';
  const customModel=custom.model || settingValue('model.model') || '未配置';
  const customContextLabel=customModelContextWindowLabel();
  const customMeta=customConfigured
    ? '自定义配置 · 上下文 '+customContextLabel+' · '+(customProvider==='openai'?'OpenAI SDK':'Anthropic SDK')
    : '去设置填写 endpoint / key';
  window.__catscoRenderCatsRelayModelPanel?.({
    activationCopy,
    customChoice:{
      active:source==='custom',
      configured:customConfigured,
      disabled:relayActionBusy(),
      modelName:String(customModel),
      meta:customMeta,
    },
    models:relayChoices,
    tagLabel:source==='custom'?'自定义':activeModel?String(activeModel.model||activeModel.label||'已选择'):'可用',
    tagTone:source==='custom'||activeModel?'green':'warm',
  });
}

function captureCustomModelDraft(){
  const focus=window.__catscoGetCustomModelFocusSnapshot?.()||{};
  const draft=window.__catscoGetCustomModelDraft?.()||{};
  return {
    open: customModelSettingsOpen,
    activeId: focus.activeId || '',
    selectionStart: focus.selectionStart ?? null,
    selectionEnd: focus.selectionEnd ?? null,
    provider: draft.provider,
    apiBase: draft.apiBase,
    model: draft.model,
    contextWindowTokens: draft.contextWindowTokens,
    secret: draft.secret,
    clearSecret: draft.clearSecret,
  };
}

function restoreCustomModelDraft(draft){
  customModelSettingsOpen=Boolean(draft?.open || customModelSettingsOpen);

  if(draft && draft.open){
    window.__catscoSetCustomModelDraft?.({
      provider:draft.provider,
      apiBase:draft.apiBase,
      model:draft.model,
      contextWindowTokens:draft.contextWindowTokens,
      secret:draft.secret,
      clearSecret:Boolean(draft.clearSecret),
      dirty:true,
    });
  }

  if(draft?.activeId)window.__catscoRestoreCustomModelFocus?.({
    activeId:draft.activeId,
    selectionEnd:draft.selectionEnd,
    selectionStart:draft.selectionStart,
  });
}

function renderModelSource(snapshot){
  const fields=(snapshot&&snapshot.fields)||[];
  if(!fields.length){
    window.__catscoRenderModelSource?.({fieldsAvailable:false});
    return;
  }
  const keyField=settingField('model.apiKey');
  const credentialMeta=keyField.present
    ? '已配置访问凭证'
    : '未配置访问凭证';
  const apiBaseValue=settingValue('model.apiBase');
  const hideInternalGateway=isInternalModelGateway(apiBaseValue);
  const apiBaseDisplayValue=hideInternalGateway?'':apiBaseValue;
  const apiBasePlaceholder=hideInternalGateway?'已配置 CatsCo 内部兼容网关（隐藏）':'https://example.com/v1/messages';
  const contextWindowOptions=customModelContextWindowOptions();
  const contextWindowValue=customModelContextWindowValue();
  const draft=captureCustomModelDraft();

  window.__catscoRenderModelSource?.({
    fieldsAvailable:true,
    credentialMeta,
    keyPresent:Boolean(keyField.present),
    apiBaseDisplayValue,
    apiBasePlaceholder,
    hideInternalGateway,
    providerValue:settingValue('model.provider')||'anthropic',
    modelValue:settingValue('model.model'),
    contextWindowOptions,
    contextWindowValue,
    customModelSettingsOpen,
  });
  restoreCustomModelDraft(draft);
}

function isInternalModelGateway(value){
  try{
    const host=new URL(value).hostname.toLowerCase();
    const legacyHost=['buildsense','asia'].join('.');
    return host===legacyHost||host.endsWith('.'+legacyHost);
  }catch(_e){
    return false;
  }
}

function isCatsRelayModelGateway(value){
  try{
    return new URL(value).hostname.toLowerCase()==='relay.catsco.cc';
  }catch(_e){
    return String(value||'').toLowerCase().includes('relay.catsco.cc');
  }
}

function isRelayStartupActive(){
  return activeStartupSource()==='relay';
}

function hasCustomStartupModel(){
  return isCustomStartupConfigured();
}

function shouldSetupRelayOnCatsSetup(){
  if(pendingStartupSource==='relay')return true;
  if(pendingStartupSource==='custom' && hasCustomStartupModel())return false;
  return isRelayStartupActive() || !hasCustomStartupModel();
}

function relayModelIdForSetup(){
  if(pendingStartupSource==='relay' && pendingRelayModelId)return pendingRelayModelId;
  return selectedRelayModelId();
}

function setModelSourceStatus(message, tone){
  window.__catscoRenderModelSourceStatus?.({message,tone});
}

function setRelayModelApplyStatus(message, tone, source='settings'){
  if(source==='chat')setCatsAction(message, tone==='error');
}

function catsSetupWarningText(data){
  const warnings=[];
  if(Array.isArray(data?.warnings))warnings.push(...data.warnings.map(item=>String(item||'').trim()).filter(Boolean));
  const relay=data?.relayModelSetup;
  if(relay && (relay.skipped || relay.ok===false))warnings.push(String(relay.reason||'中转模型未自动启用').trim());
  return warnings.filter(Boolean).join('；');
}

function buildCustomModelSettingsPayload(){
  const draft=window.__catscoGetCustomModelDraft?.()||{};
  const secret=String(draft.secret||'');
  const clearSecret=Boolean(draft.clearSecret);
  if(secret && clearSecret){
    throw new Error('不能同时替换和清除访问凭证。');
  }
  const secretUpdate=clearSecret
    ? {action:'clear'}
    : secret
      ? {action:'replace',value:secret}
      : {action:'keep'};
  const hiddenInternal=isInternalModelGateway(settingValue('model.apiBase'));
  const apiBaseValue=String(draft.apiBase||'').trim() || (hiddenInternal?settingValue('model.apiBase'):'');
  const contextWindowTokens=customModelContextWindowValue(draft.contextWindowTokens);
  return {
    secretUpdate,
    payload:{
      settings:{
        'model.provider':String(draft.provider||'anthropic'),
        'model.apiBase':apiBaseValue,
        'model.model':String(draft.model||'').trim(),
        'model.contextWindowTokens':contextWindowTokens,
        'model.apiKey':secretUpdate,
      }
    }
  };
}

function customModelPayloadSignature(payload){
  const settings=payload.settings||{};
  const secret=settings['model.apiKey']||{action:'keep'};
  return JSON.stringify({
    provider:settings['model.provider'],
    apiBase:settings['model.apiBase'],
    model:settings['model.model'],
    contextWindowTokens:settings['model.contextWindowTokens'],
    secretAction:secret.action,
  });
}

function enableCatsRelayModelFromButton(button, options={}){
  const context=button?.dataset?.relayModelContext || 'settings';
  if(!isCatsLoggedIn() && context==='chat'){
    pendingStartupSource='relay';
    pendingRelayModelId=button?.dataset?.relayModelId || selectedRelayModelId();
    renderCatsStatus();
    setCatsAction('已选择 CatsCo 中转模型，登录后会自动接入。');
    return;
  }
  return enableCatsRelayModel(button?.dataset?.relayModelId || selectedRelayModelId(), {
    activateConnector:true,
    source:context,
    ...options,
  });
}

function enableCustomStartupModelFromButton(button, options={}){
  const context=button?.dataset?.customStartupContext || 'chat';
  if(!isCustomStartupConfigured()){
    return enableRelayFallbackForIncompleteCustom({
      source:context,
      ...options,
    });
  }
  if(!isCatsLoggedIn() && isCustomStartupConfigured()){
    pendingStartupSource='custom';
    pendingRelayModelId='';
    renderCatsStatus();
    setCatsAction('已选择自定义模型，登录后会按当前自定义配置启动。');
    return;
  }
  return enableCustomStartupModel({
    activateConnector:true,
    source:context,
    ...options,
  });
}

function enableRelayFallbackForIncompleteCustom(options={}){
  const source=options.source||'chat';
  const selectedModelId=selectedRelayModelId();
  if(!isCatsLoggedIn()){
    pendingStartupSource='relay';
    pendingRelayModelId=selectedModelId;
    renderCatsStatus();
    setRelayModelApplyStatus('自定义模型未填写，已改用 CatsCo 中转模型；登录后会自动接入。','muted',source);
    return;
  }
  setRelayModelApplyStatus('自定义模型未填写，正在改用 CatsCo 中转模型...','muted',source);
  return enableCatsRelayModel(selectedModelId,{
    activateConnector:options.activateConnector!==false,
    source,
    ...options,
  });
}

function openCustomModelFromChat(){
  switchPage('services');
  setTimeout(()=>openCustomModelSettings(), 80);
}

function relayActionBusy(){
  return relayModelApplyInFlight || catsSetupInFlight || catsAutoStartInFlight;
}

function refreshRelayActionControls(){
  renderCatsRelayModelPanel();
  if(getDashboardActivePage()==='chat')renderCatsStatus();
}

function setRelayModelApplyBusy(busy){
  relayModelApplyInFlight=Boolean(busy);
  refreshRelayActionControls();
}

function setCatsSetupBusy(busy){
  catsSetupInFlight=Boolean(busy);
  refreshRelayActionControls();
}

function setCatsAutoStartBusy(busy){
  catsAutoStartInFlight=Boolean(busy);
  refreshRelayActionControls();
}

async function refreshCatsChatAfterMutation(options={}){
  await fetchDashboardSettings();
  await fetchStatus();
  await fetchCatsStatus({priority:true});
  await fetchReadiness();
  renderCatsStatus();
  const stage=buildCatsChatStage();
  if(stage.key==='ready' && options.focusInput!==false){
    setTimeout(()=>window.__catscoFocusCatsMessageInput?.(), 0);
  }
  return stage;
}

async function enableCatsRelayModel(modelId, options={}){
  const source=options.source||'settings';
  if(!isCatsLoggedIn()){
    switchPage('chat');
    return;
  }
  if(relayActionBusy()){
    setRelayModelApplyStatus(catsSetupInFlight?'正在配置 CatsCo 连接，请稍候...':'模型切换正在进行，请稍候...','muted',source);
    return;
  }
  const selectedModelId=modelId||selectedRelayModelId();
  const selectedModel=relayModelCatalog().find(model=>String(model.id||model.model||'')===selectedModelId)||relayModelCatalog()[0]||{};
  if(!selectedModel.id&&!selectedModel.model){
    setRelayModelApplyStatus('启用失败：CatsCo 中转暂未提供可用模型。','error',source);
    return;
  }
  const label=selectedModel.label||selectedModel.model||selectedModelId;
  let retrying=false;
  try{
    pendingStartupSource='relay';
    pendingRelayModelId=selectedModelId;
    setRelayModelApplyBusy(true);
    setCatsStatusMutationBusy(true);
    invalidateCatsStatusRequests();
    setRelayModelApplyStatus('正在启用 CatsCo 中转模型（'+label+'）...','muted',source);
    const r=await fetch(API+'/api/cats/relay/model-config/apply',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        modelId:selectedModelId,
        rotateExisting:Boolean(options.rotateExisting),
        activateConnector:options.activateConnector!==false,
      })
    });
    const data=await r.json().catch(()=>({}));
    if(r.status===409&&data.action==='rotate_required'){
      const ok=confirm('你的 CatsCo 中转 Key 已存在，但当前无法读取明文。要重新生成并写入 CatsCo 桌面端吗？旧 Key 会立即失效。');
      if(ok){
        retrying=true;
        setRelayModelApplyBusy(false);
        setCatsStatusMutationBusy(false);
        return enableCatsRelayModel(selectedModelId,{...options,rotateExisting:true});
      }
      setRelayModelApplyStatus('已取消。你也可以在 CatsCompany 中转站页面复制现有配置后手动填写。','muted',source);
      return;
    }
    if(!r.ok||data.error)throw new Error(data.error||data.message||('HTTP '+r.status));
    if(data.selectedModel || Array.isArray(data.models)){
      relayModelConfigSnapshot={
        ...(relayModelConfigSnapshot||{}),
        ...data,
        configured:true,
        selectedModel:data.selectedModel || relayModelConfigSnapshot?.selectedModel,
        models:Array.isArray(data.models)?data.models:relayModelConfigSnapshot?.models,
      };
    }
    pendingStartupSource='';
    pendingRelayModelId='';
    await refreshCatsChatAfterMutation({focusInput:source==='chat'});
    const successMessage=data.message||('已启用 CatsCo 中转模型：'+(data.selectedModel?.label||label));
    setRelayModelApplyStatus(successMessage,'success',source);
    setModelSourceStatus(data.connectorRestarted||data.connectorStarted?'已写入并已请求 connector 使用新配置。':'已写入 CatsCo 中转模型配置。','success');
  }catch(e){
    setRelayModelApplyStatus('启用失败：'+formatDashboardApiError(e,'/api/cats/relay/model-config/apply'),'error',source);
  }finally{
    if(!retrying){
      setCatsStatusMutationBusy(false);
      setRelayModelApplyBusy(false);
    }
  }
}

async function enableCustomStartupModel(options={}){
  const source=options.source||'chat';
  if(!isCustomStartupConfigured()){
    return enableRelayFallbackForIncompleteCustom(options);
  }
  if(!isCatsLoggedIn()){
    pendingStartupSource='custom';
    pendingRelayModelId='';
    renderCatsStatus();
    setCatsAction('已选择自定义模型，登录后会按当前自定义配置启动。');
    return;
  }
  if(relayActionBusy()){
    setRelayModelApplyStatus(catsSetupInFlight?'正在配置 CatsCo 连接，请稍候...':'模型切换正在进行，请稍候...','muted',source);
    return;
  }
  try{
    pendingStartupSource='custom';
    pendingRelayModelId='';
    setRelayModelApplyBusy(true);
    setCatsStatusMutationBusy(true);
    invalidateCatsStatusRequests();
    setRelayModelApplyStatus('正在切换为自定义模型...','muted',source);
    const r=await fetch(API+'/api/model-source/custom/apply',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        activateConnector:options.activateConnector!==false,
      })
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok||data.error)throw new Error(data.error||'切换自定义模型失败');
    pendingStartupSource='';
    pendingRelayModelId='';
    await refreshCatsChatAfterMutation({focusInput:source==='chat'});
    const message=data.message||('已切换为自定义模型：'+(data.model||''));
    setRelayModelApplyStatus(message,'success',source);
    setModelSourceStatus(data.connectorRestarted||data.connectorStarted?'已请求 connector 使用自定义模型。':'已切换为自定义模型启动。','success');
  }catch(e){
    setRelayModelApplyStatus('切换失败：'+formatDashboardApiError(e,'/api/model-source/custom/apply'),'error',source);
  }finally{
    setCatsStatusMutationBusy(false);
    setRelayModelApplyBusy(false);
  }
}

function scheduleCustomModelAutoSave(){
    clearTimeout(customModelAutoSaveTimer);
    setModelSourceStatus('改动待自动保存...', 'muted');
    customModelAutoSaveTimer=setTimeout(()=>saveCustomModelSettings({auto:true}),CUSTOM_MODEL_AUTO_SAVE_DELAY);
}

async function saveCustomModelSettings(options){
  const auto=Boolean(options&&options.auto);
  let built;
  try{
    built=buildCustomModelSettingsPayload();
  }catch(e){
    setModelSourceStatus(e.message||String(e),'error');
    return;
  }
  const payload=built.payload;
  const secretUpdate=built.secretUpdate;
  const apiBaseValue=payload.settings['model.apiBase'];
  const modelValue=payload.settings['model.model'];
  if(auto && (!apiBaseValue || !modelValue)){
    setModelSourceStatus('等待补全模型地址和模型名称后自动保存。','muted');
    return;
  }
  const signature=customModelPayloadSignature(payload);
  if(auto && signature===customModelAutoSaveLastSignature && secretUpdate.action==='keep'){
    setModelSourceStatus('已保存。新 session 或下一次启动 connector 后生效。','success');
    return;
  }
  if(auto && customModelAutoSaveInFlight){
    customModelAutoSaveQueued=true;
    return;
  }
  const sensitive=secretUpdate.action!=='keep';
  const message=sensitive
    ? '保存并启用自定义模型？访问凭证会写入本地 .env，仅用于本机 runtime。若 CatsCo agent 正在运行，会请求重启以使用新配置。'
    : '保存并启用自定义模型？若 CatsCo agent 正在运行，会请求重启以使用新配置。';
  if(!auto && !confirm(message))return;
  try{
    customModelAutoSaveInFlight=true;
    setModelSourceStatus(auto?'自动保存中...':'保存中...','muted');
    const requestPayload={...payload,restartConnector:!auto};
    const r=await fetch(API+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(requestPayload)});
    const d=await r.json();
    if(!r.ok||d.error)throw new Error(d.error||'保存失败');
    customModelAutoSaveLastSignature=signature;
    const appliedMessage=!auto&&d.connectorRestarted
      ? '已保存，并已请求重启 CatsCo agent 使用新配置。'
      : (auto?'已自动保存自定义配置。':'已保存自定义配置。')+'配置完整时会切换为自定义启动。';
    setModelSourceStatus(appliedMessage,'success');
    window.__catscoSetCustomModelDraft?.({dirty:false});
    if(secretUpdate.action==='replace'){
      window.__catscoSetCustomModelDraft?.({secret:'',secretPlaceholder:'已更新，留空表示保持现有凭证',dirty:false});
    }
    if(secretUpdate.action==='clear')window.__catscoSetCustomModelDraft?.({clearSecret:false,dirty:false});
    window.__catscoSetModelSourceSaved?.(true);
    setTimeout(()=>window.__catscoSetModelSourceSaved?.(false),2000);
    if(!auto){
      setModelSourceStatus('已保存，正在刷新启动状态...','muted');
      await Promise.all([fetchDashboardSettings(),fetchStatus(),fetchReadiness(),fetchCatsStatus()]);
      setModelSourceStatus(d.connectorRestarted?'已保存，并已请求重启 CatsCo agent 使用自定义模型。':'已保存自定义配置。配置完整时会切换为自定义启动。','success');
    }
  }catch(e){
    setModelSourceStatus('保存失败：'+formatDashboardApiError(e,'/api/settings'),'error');
  }finally{
    customModelAutoSaveInFlight=false;
    if(customModelAutoSaveQueued){
      customModelAutoSaveQueued=false;
      scheduleCustomModelSaveSoon();
    }
  }
}

function scheduleCustomModelSaveSoon(){
  clearTimeout(customModelAutoSaveTimer);
  customModelAutoSaveTimer=setTimeout(()=>saveCustomModelSettings({auto:true}),250);
}
