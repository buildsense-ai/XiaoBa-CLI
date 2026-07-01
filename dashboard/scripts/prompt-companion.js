let promptCompanionProposal = null;
let promptCompanionSignals = null;
let promptCompanionAdvisor = null;
let promptCompanionAdvisorNotice = '';
let promptCompanionBusy = false;
let promptCompanionRequestSeq = 0;

function getPromptCompanionNote() {
  return String(window.__catscoGetPromptCompanionNote?.() || '').trim().slice(0, 600);
}

function renderPromptCompanionState(patch = {}) {
  window.__catscoRenderPromptCompanion?.({
    advisor: promptCompanionAdvisor,
    advisorNotice: promptCompanionAdvisorNotice,
    error: '',
    loading: false,
    proposal: promptCompanionProposal,
    signals: promptCompanionSignals,
    ...patch,
  });
}

function formatPromptCompanionAdvisorNotice(advisor, fallback) {
  if (!advisor || typeof advisor !== 'object') return fallback;
  const message = String(advisor.message || '').trim();
  const suggestion = String(advisor.suggestion || '').trim();
  let text = message || fallback;
  if (suggestion) text += '\nSuggested question: ' + suggestion;
  return text;
}

function buildPromptCompanionNoProposalCopy(signals) {
  const turns = Number(signals?.recent_session_turns || 0);
  const runtimeErrors = Number(signals?.recent_runtime_errors || 0);
  const runtimeWarnings = Number(signals?.recent_runtime_warnings || 0);
  const events = Number(signals?.recent_events || 0);
  const checked = 'Checked ' + turns + ' recent turns, ' + runtimeErrors + ' runtime errors, ' + runtimeWarnings + ' runtime warnings, and ' + events + ' companion events';
  if (runtimeErrors > 0 || runtimeWarnings > 0 || events > 0) {
    return checked + '. Runtime signals exist, but there is no safe prompt patch yet. Ask a more specific question below to help the advisor localize it.';
  }
  return checked + '. No stable prompt issue was found yet.';
}

async function parsePromptCompanionResponse(resp) {
  if (typeof parseSimpleResponse === 'function') return parseSimpleResponse(resp);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) throw new Error(data.error || ('HTTP ' + resp.status));
  return data;
}

async function fetchPromptCompanionProposal(manual = false) {
  if (promptCompanionBusy && !manual) return;
  promptCompanionBusy = true;
  const requestSeq = ++promptCompanionRequestSeq;
  try {
    if (manual) renderPromptCompanionState({ loading: true });
    const note = manual ? getPromptCompanionNote() : '';
    const res = manual
      ? await fetch(API + '/api/pet/prompt-proposal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note }),
        })
      : await fetch(API + '/api/pet/prompt-proposal');
    const data = await parsePromptCompanionResponse(res);
    if (requestSeq !== promptCompanionRequestSeq) return;
    const nextProposal = data.proposal || null;
    const advisor = data.advisor || null;
    promptCompanionSignals = data.signals || null;
    promptCompanionAdvisor = advisor;
    if (nextProposal) {
      promptCompanionProposal = nextProposal;
      promptCompanionAdvisorNotice = note ? formatPromptCompanionAdvisorNotice(advisor, 'A new previewable diff was generated from your note.') : '';
    } else if (note) {
      promptCompanionAdvisorNotice = promptCompanionProposal
        ? formatPromptCompanionAdvisorNotice(advisor, 'No new applicable diff was generated; kept current suggestion. Ask with a more specific direction to refine it.')
        : formatPromptCompanionAdvisorNotice(advisor, 'No applicable diff was generated. Ask with a more specific direction, or wait for more runtime signals.');
    } else {
      promptCompanionProposal = null;
      promptCompanionAdvisor = null;
      promptCompanionAdvisorNotice = '';
    }
    renderPromptCompanionState();
  } catch (error) {
    if (requestSeq === promptCompanionRequestSeq) renderPromptCompanionState({ error: error?.message || String(error), loading: false });
  } finally {
    if (requestSeq === promptCompanionRequestSeq) promptCompanionBusy = false;
  }
}

function openPromptCompanionPanel() {
  window.switchPage?.('companion');
  window.closeFloatingPetMenu?.();
}

async function previewPromptCompanionProposal() {
  const p = promptCompanionProposal;
  if (!p) return;
  window.closeFloatingPetMenu?.();
  if (typeof window.__catscoPreviewPromptCompanionProposal === 'function') {
    await window.__catscoPreviewPromptCompanionProposal(p);
    return;
  }
  window.switchPage?.('companion');
  alert('Preview is not available in this React shell yet. Review the proposal text, then apply or dismiss it.');
}

async function applyPromptCompanionProposal() {
  const p = promptCompanionProposal;
  if (!p) return;
  if (!confirm('Apply this prompt tuning suggestion? It will be hot-loaded from the next user message.')) return;
  try {
    const res = await fetch(API + '/api/pet/prompt-proposal/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id }),
    });
    const data = await parsePromptCompanionResponse(res);
    promptCompanionProposal = null;
    promptCompanionAdvisor = null;
    promptCompanionAdvisorNotice = '';
    promptCompanionSignals = data.proposal?.signals || promptCompanionSignals;
    window.__catscoClearPromptCompanionNote?.();
    if (typeof setPetState === 'function') setPetState('success', { message: 'Prompt suggestion applied. It will affect the next message.', holdMs: 2600 });
    renderPromptCompanionState();
    if (typeof getDashboardActivePage === 'function' && getDashboardActivePage() === 'prompts') {
      await window.refreshPromptWorkbench?.(p.path || data.proposal?.path || 'system-prompt.md');
    }
  } catch (error) {
    alert('Failed to apply prompt suggestion: ' + (error.message || String(error)));
  }
}

async function dismissPromptCompanionProposal() {
  const p = promptCompanionProposal;
  if (!p) return;
  try {
    const res = await fetch(API + '/api/pet/prompt-proposal/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id }),
    });
    await parsePromptCompanionResponse(res);
    promptCompanionProposal = null;
    promptCompanionAdvisor = null;
    promptCompanionAdvisorNotice = '';
    renderPromptCompanionState();
  } catch (error) {
    alert('Failed to dismiss prompt suggestion: ' + (error.message || String(error)));
  }
}

window.fetchPromptCompanionProposal = fetchPromptCompanionProposal;
window.openPromptCompanionPanel = openPromptCompanionPanel;
window.previewPromptCompanionProposal = previewPromptCompanionProposal;
window.applyPromptCompanionProposal = applyPromptCompanionProposal;
window.dismissPromptCompanionProposal = dismissPromptCompanionProposal;
