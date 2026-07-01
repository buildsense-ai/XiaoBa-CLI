// === 微信 Token 获取 ===
let weixinPollInterval;
let weixinPollAgentUid='';
async function getWeixinToken(){
  try{
    const r=await fetch(API+'/api/weixin/qrcode');
    const d=await r.json();
    if(!r.ok||d.error)throw new Error(d.error||'获取二维码失败');
    if(d.qrcode){
      weixinPollAgentUid=String(d.agent_uid||d.agent?.uid||'');
      const agentName=d.agent?.name||d.agent?.username||weixinPollAgentUid||'当前 Agent';
      const logsTitle='微信扫码授权';
      window.__catscoRenderLogsTitle?.(logsTitle);
      window.__catscoRenderLogsBody?.({kind:'weixin-qr',href:String(d.qrcode_img_content||''),agentName});
      window.__catscoSetGlobalModalOpen?.('logs', true);
      if(weixinPollInterval)clearInterval(weixinPollInterval);
      weixinPollInterval=setInterval(()=>checkWeixinStatus(d.qrcode),2000);
    }
  }catch(e){alert('获取二维码失败: '+e.message);}
}
async function checkWeixinStatus(qrcode){
  try{
    const agentParam=weixinPollAgentUid?'&agent_uid='+encodeURIComponent(weixinPollAgentUid):'';
    const r=await fetch(API+'/api/weixin/qrcode-status?qrcode='+encodeURIComponent(qrcode)+agentParam);
    const d=await r.json();
    if(!r.ok||d.error)throw new Error(d.error||'微信授权状态检查失败');
    if(d.status==='confirmed'&&d.token_saved){
      clearInterval(weixinPollInterval);
      const bound=d.binding?.agentName||d.binding?.agentUsername||d.binding?.agentUid||'当前 Agent';
      window.__catscoRenderLogsBody?.({kind:'weixin-success',message:'微信通道已绑定到 '+bound+'，Token 已保存到本地环境。'});
      await Promise.allSettled([fetchConfig(), fetchStatus(), fetchReadiness()]);
      setTimeout(()=>window.__catscoSetGlobalModalOpen?.('logs', false),2000);
    }else if(d.status==='expired'){
      clearInterval(weixinPollInterval);
      window.__catscoRenderLogsBody?.({kind:'weixin-expired'});
    }
  }catch(e){
    clearInterval(weixinPollInterval);
    window.__catscoRenderLogsBody?.({kind:'text',text:'微信授权失败：'+(e.message||String(e)),tone:'error'});
  }
}
