const $ = id => document.getElementById(id);
let state;
let tab = 'publik';
let working = false;
const dollars = micros => `$${(micros / 1e6).toFixed(2)}`;
function render(next) {
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
}
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
window.publik.onState(render);
window.publik.onHome(() => { $('home').hidden = false; });
window.publik.onWorkspace(() => { $('home').hidden = true; });
void act(async () => { const initial = await window.publik.state(); if (initial.provider === 'own') selectTab('own'); return initial; });
