// Init
loadDashboardFontScale();
preloadPetFrames();renderPetProfile();renderPetProcess();restoreFloatingPetPosition();setPetState('idle');
fetchConfig();fetchStatus();fetchSkills();fetchSkillHubStatus();fetchDashboardSettings();fetchUpdateStatus(true);fetchCatsStatus();fetchPetStatus();fetchPetTimeline();fetchPetProgress();fetchPromptCompanionProposal();
if((getDashboardActivePage() || 'chat') === 'chat' && !catsPollTimer) catsPollTimer = setInterval(fetchCatsStatus, 5000);
setInterval(fetchStatus,5000);setInterval(fetchSkills,30000);setInterval(()=>fetchUpdateStatus(true),5000);setInterval(()=>{fetchPetStatus();fetchPetTimeline();fetchPetProgress();},2500);setInterval(()=>fetchPromptCompanionProposal(),30000);
