// === 微信 Token 获取 ===
let weixinPollInterval;
async function getWeixinToken(){
  try{
    const r=await fetch(API+'/api/weixin/qrcode');
    const d=await r.json();
    if(d.qrcode){
      const logsTitle='微信扫码登录';
      window.__catscoRenderLogsTitle?.(logsTitle);
      window.__catscoRenderLogsBody?.({kind:'weixin-qr',href:String(d.qrcode_img_content||'')});
      window.__catscoSetGlobalModalOpen?.('logs', true);
      if(weixinPollInterval)clearInterval(weixinPollInterval);
      weixinPollInterval=setInterval(()=>checkWeixinStatus(d.qrcode),2000);
    }
  }catch(e){alert('获取二维码失败: '+e.message);}
}
async function checkWeixinStatus(qrcode){
  try{
    const r=await fetch(API+'/api/weixin/qrcode-status?qrcode='+qrcode);
    const d=await r.json();
    if(d.status==='confirmed'&&d.bot_token){
      clearInterval(weixinPollInterval);
      window.__catscoSetServiceConfigDraft?.({name:'weixin',key:'WEIXIN_TOKEN',value:String(d.bot_token),dirty:true,saved:false});
      markServiceConfigDirty('weixin');
      window.__catscoRenderLogsBody?.({kind:'weixin-success'});
      setTimeout(()=>window.__catscoSetGlobalModalOpen?.('logs', false),2000);
    }else if(d.status==='expired'){
      clearInterval(weixinPollInterval);
      window.__catscoRenderLogsBody?.({kind:'weixin-expired'});
    }
  }catch(e){}
}
