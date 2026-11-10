const $ = id => document.getElementById(id);
let state;
let tab = 'publik';
let working = false;
const dollars = micros => `$${(micros / 1e6).toFixed(2)}`;
let render = function (next) {
  state = next;
  $('project').textContent = state.workspace || 'Your laptop. Your projects.';
  $('connected').textContent = state.provider === 'own' ? 'Your API connected' : state.provider === 'publik' ? 'Publik connected' : 'Get started';
  $('disclosure').textContent = state.disclosure;
  $('consent-panel').hidden = state.provider === 'publik';
  $('wallet-panel').hidden = state.provider !== 'publik';
  $('switch-publik').hidden = state.provider !== 'own';
  $('token-note').hidden = state.tokenReady || state.provider === 'publik';
  $('connect').disabled = !state.tokenReady || !$('consent').checked || working;
  $('open-project').disabled = state.provider === 'needs_consent' || state.busy || working;
  $('open-project').firstChild.textContent = state.busy ? 'Starting coding engine… ' : 'Choose a project folder ';
  $('tier-label').hidden = state.provider === 'own';
  $('running-actions').hidden = !state.running;
  $('balance').textContent = state.balanceHeader ? `${state.balanceHeader} of Publik balance` : state.balanceMicros === null ? 'Refresh to check balance' : `${dollars(state.balanceMicros)}${state.balanceMicros === 0 && !state.linked ? ' · link this computer' : ' of Publik balance'}`;
  $('cost').textContent = state.cost || '';
  $('link-account').firstChild.textContent = state.linked ? 'Add a plan or pack ' : 'Link this computer & pick a plan ';
  $('payment').hidden = !state.payment;
  $('payment-message').textContent = state.payment?.message || '';
  $('payment-link').hidden = !state.payment?.url;
  $('notice').hidden = !state.notice;
  $('notice').textContent = state.notice || '';
  if (state.own) { $('base-url').value = state.own.baseURL; $('own-model').value = state.own.model; }
};
async function act(action) {
  if (working) return;
  working = true; $('error').hidden = true; if (state) render(state);
  try { const next = await action(); if (next?.provider) render(next); }
  catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
  finally { working = false; if (state) render(state); }
}
function selectTab(value) {
  tab = value;
  $('publik-panel').hidden = tab !== 'publik'; $('own-panel').hidden = tab !== 'own';
  for (const name of ['publik', 'own']) { $(name + '-tab').classList.toggle('active', name === tab); $(name + '-tab').setAttribute('aria-pressed', String(name === tab)); }
}
$('publik-tab').onclick = () => selectTab('publik');
$('own-tab').onclick = () => selectTab('own');
$('consent').onchange = () => render(state);
$('connect').onclick = () => act(() => window.publik.provision($('consent').checked));
$('refresh').onclick = () => act(() => window.publik.refresh());
$('link-account').onclick = () => act(() => window.publik.openLink(state.accountLink ? 'account' : 'dashboard'));
$('payment-link').onclick = () => act(() => window.publik.openLink('payment'));
$('switch-publik').onclick = () => act(() => window.publik.usePublik());
$('own-panel').onsubmit = event => { event.preventDefault(); void act(async () => { const result = await window.publik.saveOwn({ baseURL: $('base-url').value, apiKey: $('api-key').value, model: $('own-model').value, remember: $('remember').checked }); $('api-key').value = ''; return result; }); };
$('open-project').onclick = () => act(() => window.publik.launch($('tier').value));
$('account').onclick = $('brand').onclick = () => act(() => window.publik.home());
$('resume').onclick = () => act(() => window.publik.resume());
$('stop').onclick = () => act(() => window.publik.stop());
$('source').onclick = () => act(() => window.publik.openLink('source'));
window.publik.onState(next => render(next));
window.publik.onHome(() => { $('home').hidden = false; $('workspace').hidden = true; });
window.publik.onWorkspace(() => { $('home').hidden = true; $('workspace').hidden = false; $('input').focus(); });
void act(async () => { const initial = await window.publik.state(); if (initial.provider === 'own') selectTab('own'); return initial; });

// ---- Workspace: transcript, tool cards, approvals, composer ----
const log = $('log');
let streaming = false;
let currentText = null;
const toolCards = new Map();
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const scroll = () => { log.scrollTop = log.scrollHeight; };
const short = (value, n = 80) => { const t = String(value ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function setStreaming(on) { streaming = on; $('abort').hidden = !on; $('send').disabled = on && false; $('workspace').classList.toggle('busy', on); }
function addMessage(role, text) {
  $('empty').hidden = true;
  const m = el('div', `msg ${role}`); const body = el('div', 'body', text); m.append(body); log.append(m); scroll(); return body;
}
function toolTitle(tool, input) {
  const i = input || {};
  if (tool === 'read') return ['Read', i.path];
  if (tool === 'edit') return ['Edit', i.path];
  if (tool === 'write') return ['Write', i.path];
  if (tool === 'bash') return ['Run', i.command];
  if (tool === 'ls') return ['List', i.path || '.'];
  if (tool === 'find' || tool === 'grep') return [tool === 'grep' ? 'Search' : 'Find', i.pattern];
  return [tool, JSON.stringify(i)];
}
function diffView(tool, input) {
  const box = el('div', 'diff');
  const line = (cls, text) => box.append(el('div', `ln ${cls}`, text));
  if (tool === 'edit') for (const e of input?.edits || []) {
    for (const l of String(e.oldText).split('\n')) line('del', '- ' + l);
    for (const l of String(e.newText).split('\n')) line('add', '+ ' + l);
    box.append(el('div', 'ln sep', '⋯'));
  } else if (tool === 'write') {
    const lines = String(input?.content ?? '').split('\n');
    for (const l of lines.slice(0, 200)) line('add', '+ ' + l);
    if (lines.length > 200) line('sep', `… ${lines.length - 200} more lines`);
  } else if (tool === 'bash') line('cmd', '$ ' + (input?.command ?? ''));
  else line('cmd', JSON.stringify(input, null, 2));
  return box;
}
function toolCard(id, tool, input) {
  $('empty').hidden = true; currentText = null;
  let card = toolCards.get(id);
  if (card) return card;
  const [verb, target] = toolTitle(tool, input);
  card = el('details', `tool ${tool}`);
  const sum = el('summary'); sum.append(el('span', 'verb', verb), el('code', 'target', short(target, 90)), el('span', 'state', '…'));
  card.append(sum);
  if (['edit', 'write', 'bash'].includes(tool)) card.append(diffView(tool, input));
  log.append(card); toolCards.set(id, card); scroll();
  return card;
}
function approval(event) {
  const card = toolCard(event.id, event.tool, event.input);
  card.open = true; card.classList.add('asking');
  const bar = el('div', 'approve');
  const label = { edit: 'Apply this edit?', write: 'Write this file?', bash: 'Run this command?' }[event.tool] || `Allow ${event.tool}?`;
  const always = el('label', 'check'); const box = el('input'); box.type = 'checkbox'; always.append(box, document.createTextNode(` Allow ${event.tool} for this session`));
  const yes = el('button', 'primary dark small', 'Allow'); const no = el('button', 'quiet danger', 'Decline');
  const done = ok => { bar.remove(); card.classList.remove('asking'); card.querySelector('.state').textContent = ok ? 'allowed' : 'declined'; void window.publik.approve(event.id, ok, box.checked); };
  yes.onclick = () => done(true); no.onclick = () => done(false);
  bar.append(el('span', 'q', label), always, no, yes);
  card.append(bar); scroll(); yes.focus();
}
window.publik.onEngine(event => {
  switch (event.type) {
    case 'text': if (!currentText) currentText = addMessage('assistant', ''); currentText.textContent += event.delta; scroll(); break;
    case 'tool_start': toolCard(event.id, event.tool, event.input); break;
    case 'approval': approval(event); break;
    case 'tool_end': {
      const card = toolCard(event.id, event.tool, null);
      const state = card.querySelector('.state'); if (state.textContent !== 'declined') state.textContent = event.isError ? 'failed' : 'done';
      card.classList.toggle('error', event.isError);
      if (event.output) card.append(el('pre', 'output', short(event.output, 6000)));
      break;
    }
    case 'turn_end': currentText = null; break;
    case 'compaction': addMessage('system', event.phase === 'start' ? 'Compacting the conversation to fit the model context…' : 'Conversation compacted.'); break;
    case 'retry': addMessage('system', `Retrying (${event.attempt}/${event.maxAttempts})…`); break;
    case 'error': addMessage('error', event.message); break;
    case 'settled': setStreaming(false); currentText = null; break;
  }
});
window.publik.onHistory(messages => {
  for (const n of [...log.querySelectorAll('.msg,.tool')]) n.remove();
  toolCards.clear(); currentText = null; $('empty').hidden = messages.length > 0;
  const textOf = c => typeof c === 'string' ? c : (c || []).filter(p => p.type === 'text').map(p => p.text).join('');
  for (const m of messages) {
    if (m.role === 'user') addMessage('user', textOf(m.content));
    else if (m.role === 'assistant') for (const part of m.content || []) {
      if (part.type === 'text' && part.text) addMessage('assistant', part.text);
      else if (part.type === 'toolCall') toolCard(part.id, part.name, part.arguments).querySelector('.state').textContent = 'done';
    }
  }
  scroll();
});
function sendPrompt(text) {
  if (!text.trim()) return;
  addMessage('user', text); currentText = null; setStreaming(true);
  $('input').value = '';
  window.publik.prompt(text).catch(error => { addMessage('error', error.message); setStreaming(false); });
}
$('composer').onsubmit = e => { e.preventDefault(); sendPrompt($('input').value); };
$('input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendPrompt($('input').value); } };
for (const chip of document.querySelectorAll('.chip')) chip.onclick = () => sendPrompt(chip.textContent);
$('abort').onclick = () => window.publik.abort();
$('new-chat').onclick = () => act(() => window.publik.newChat());
$('ws-stop').onclick = () => act(() => window.publik.stop());
$('ws-tier').onchange = () => act(() => window.publik.setTier($('ws-tier').value));
$('ws-payment-link').onclick = () => act(() => window.publik.openLink('payment'));
const baseRender = render;
render = next => {
  baseRender(next);
  $('ws-provider').textContent = next.provider === 'own' ? `Your API · ${next.own?.model ?? ''}` : 'Publik';
  $('ws-tier').hidden = next.provider === 'own';
  if (next.tier) $('ws-tier').value = next.tier;
  $('ws-balance').textContent = next.provider === 'publik' ? (next.balanceHeader ? `Balance ${next.balanceHeader}` : next.balanceMicros != null ? `Balance ${dollars(next.balanceMicros)}` : '') : '';
  $('ws-payment').hidden = !next.payment;
  $('ws-payment-message').textContent = next.payment?.message || '';
  $('ws-payment-link').hidden = !next.payment?.url;
};
