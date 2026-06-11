async function fetchConfig(){
  if(envConfigLoading)return;
  envConfigLoading=true;
  try{
    const r=await fetch(API+'/api/config');
    configData=await r.json();
    envConfigLoaded=true;
    if(appStatusSnapshot && Array.isArray(appStatusSnapshot.services) && !shouldDeferServiceRender())renderServices(appStatusSnapshot.services);
  }catch(e){
    envConfigLoaded=false;
  }finally{
    envConfigLoading=false;
  }
}
