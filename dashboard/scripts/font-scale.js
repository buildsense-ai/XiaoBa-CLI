function normalizeDashboardFontScale(value){
  const numeric=Number(value);
  const safe=Number.isFinite(numeric)?numeric:DASHBOARD_FONT_SCALE_DEFAULT;
  const stepped=Math.round(safe/DASHBOARD_FONT_SCALE_STEP)*DASHBOARD_FONT_SCALE_STEP;
  return Math.min(DASHBOARD_FONT_SCALE_MAX, Math.max(DASHBOARD_FONT_SCALE_MIN, stepped));
}

let dashboardFontScaleValue = DASHBOARD_FONT_SCALE_DEFAULT;

function dashboardFontScaleLimit(){
  if(window.matchMedia('(max-width: 640px)').matches)return 120;
  if(window.matchMedia('(max-width: 900px)').matches)return 135;
  return DASHBOARD_FONT_SCALE_MAX;
}

function applyDashboardFontScale(value, persist=true){
  const scale=normalizeDashboardFontScale(value);
  const effectiveScale=Math.min(scale, dashboardFontScaleLimit());
  dashboardFontScaleValue=scale;
  window.__catscoSetDashboardUiZoom?.(effectiveScale / 100);
  if(persist){
    try{localStorage.setItem(DASHBOARD_FONT_SCALE_KEY, String(scale));}catch(_e){}
  }
  return scale;
}

function loadDashboardFontScale(){
  let stored='';
  try{stored=localStorage.getItem(DASHBOARD_FONT_SCALE_KEY)||'';}catch(_e){}
  return applyDashboardFontScale(stored||DASHBOARD_FONT_SCALE_DEFAULT, false);
}

function stepDashboardFontScale(direction){
  const current=normalizeDashboardFontScale(dashboardFontScaleValue);
  return applyDashboardFontScale(current + direction * DASHBOARD_FONT_SCALE_STEP, true);
}

function handleDashboardFontScaleShortcut(event){
  if(!event.ctrlKey || event.altKey || event.metaKey)return;
  const key=event.key;
  if(key==='+' || key==='=' || key==='Add'){
    event.preventDefault();
    stepDashboardFontScale(1);
    return;
  }
  if(key==='-' || key==='_' || key==='Subtract'){
    event.preventDefault();
    stepDashboardFontScale(-1);
    return;
  }
  if(key==='0' || key===')'){
    event.preventDefault();
    applyDashboardFontScale(DASHBOARD_FONT_SCALE_DEFAULT, true);
  }
}

function refreshDashboardFontScaleForViewport(){
  applyDashboardFontScale(dashboardFontScaleValue, false);
}
