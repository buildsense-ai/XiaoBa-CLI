// === Config with collapsible LLM groups ===
let configData={};
let dashboardSettingsSnapshot={};
let runtimeConfigSnapshot={};
let envConfigLoaded=false;
let envConfigLoading=false;
let customModelSettingsOpen=false;
let customModelAutoSaveTimer=null;
let customModelAutoSaveInFlight=false;
let customModelAutoSaveQueued=false;
let customModelAutoSaveLastSignature='';
let relayModelConfigSnapshot=null;
let relayModelConfigLoading=false;
let relayModelConfigRequestSeq=0;
let relayModelApplyInFlight=false;
let catsSetupInFlight=false;
const CUSTOM_MODEL_AUTO_SAVE_DELAY=900;
const RELAY_FALLBACK_MODELS=[
  {id:'minimax-m2.7',label:'MiniMax M2.7',model:'MiniMax-M2.7',provider:'anthropic',base_url:'https://relay.catsco.cc/anthropic',quota_class:'standard',context_window_tokens:204800,context_label:'204.8K',default:true},
  {id:'minimax-m3',label:'MiniMax M3',model:'MiniMax-M3',provider:'anthropic',base_url:'https://relay.catsco.cc/anthropic',quota_class:'multimodal',context_window_tokens:1000000,context_label:'1M'},
  {id:'deepseek-v4-flash',label:'DeepSeek V4 Flash',model:'deepseek-v4-flash',provider:'anthropic',base_url:'https://relay.catsco.cc/anthropic',quota_class:'flash-low',context_window_tokens:1000000,context_label:'1M'},
  {id:'glm-5.1',label:'GLM 5.1',model:'glm-5.1',provider:'anthropic',base_url:'https://relay.catsco.cc/anthropic',quota_class:'standard',context_window_tokens:200000,context_label:'200K'},
];
const serviceConfigGroups={
  catscompany:{
    title:'CatsCo 连接配置',
    hint:'通常由 CatsCo 登录和绑定流程写入。',
    keys:[
      {key:'CATSCO_SERVER_URL',label:'WebSocket 地址'},
      {key:'CATSCO_HTTP_BASE_URL',label:'API 地址'},
      {key:'CATSCO_API_KEY',label:'Agent 访问凭证',sensitive:true},
    ],
  },
  feishu:{
    title:'飞书配置',
    hint:'用于飞书 App 接入本地 agent。',
    keys:[
      {key:'FEISHU_APP_ID',label:'App ID'},
      {key:'FEISHU_APP_SECRET',label:'App Secret',sensitive:true},
      {key:'FEISHU_BOT_OPEN_ID',label:'Bot Open ID'},
      {key:'FEISHU_BOT_ALIASES',label:'唤醒别名'},
    ],
  },
  weixin:{
    title:'微信配置',
    hint:'用于微信入口接入本地 agent。',
    keys:[
      {key:'WEIXIN_TOKEN',label:'Token',sensitive:true,action:'weixinToken'},
    ],
  },
};
