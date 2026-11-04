// Kickterino — interface (abas estilo Chatterino). O chat chega do processo principal,
// que o lê das janelas da live (só canais ao vivo que estão sendo assistidos).
const MAX_MESSAGES = 400;

const $ = (sel) => document.querySelector(sel);
let state = { channels: [], farming: true, maxWatchers: 10 };
let active = null;
const buffers = new Map();   // slug -> array de elementos .msg
const unread = new Set();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function timeStr(d = new Date()) {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Converte "[emote:123:nome]" em imagens; o resto vira texto puro (sem innerHTML).
function appendContent(parent, content) {
  const re = /\[emote:(\d+):([^\]]*)\]/g;
  let last = 0, m;
  while ((m = re.exec(content))) {
    if (m.index > last) parent.append(content.slice(last, m.index));
    const img = el('img', 'emote');
    img.src = `https://files.kick.com/emotes/${m[1]}/fullsize`;
    img.alt = img.title = m[2];
    parent.append(img);
    last = re.lastIndex;
  }
  if (last < content.length) parent.append(content.slice(last));
}

function renderChat(data) {
  const wrap = document.createDocumentFragment();
  const replyTo = data.metadata && data.metadata.original_sender;
  if (data.type === 'reply' && replyTo) {
    wrap.append(el('div', 'msg reply-to', `↪ respondendo @${replyTo.username}: ${(data.metadata.original_message || {}).content || ''}`));
  }
  const row = el('div', 'msg');
  row.append(el('span', 'time', timeStr(new Date(data.created_at || Date.now()))));
  const identity = (data.sender && data.sender.identity) || {};
  for (const b of identity.badges || []) row.append(el('span', `badge ${b.type}`, b.text || b.type));
  const user = el('span', 'user', data.sender ? data.sender.username : '?');
  user.style.color = identity.color || '#ccc';
  row.append(user, ': ');
  appendContent(row, data.content || '');
  wrap.append(row);
  return wrap;
}

function systemMessage(text) {
  const row = el('div', 'msg system');
  row.append(el('span', 'time', timeStr()), text);
  return row;
}

function pushMessage(slug, node) {
  const nodes = node instanceof DocumentFragment ? [...node.childNodes] : [node];
  const buf = buffers.get(slug) || [];
  buf.push(...nodes);
  while (buf.length > MAX_MESSAGES) { const old = buf.shift(); old.remove(); }
  buffers.set(slug, buf);
  if (slug === active) {
    const box = $('#messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.append(...nodes);
    if (atBottom) box.scrollTop = box.scrollHeight;
  } else if (!unread.has(slug)) {
    unread.add(slug);
    renderTabs();
  }
}

// ---------- Abas ----------
function renderTabs() {
  const nav = $('#tabs');
  nav.replaceChildren();
  for (const ch of state.channels) {
    const queued = ch.live && !ch.watching;
    const t = el('div', 'tab' + (ch.live ? ' live' : '') + (queued ? ' queued' : '') + (ch.ageGate ? ' age' : '') + (ch.slug === active ? ' active' : ''));
    const name = el('span', unread.has(ch.slug) && ch.slug !== active ? 'unread' : '', ch.displayName);
    t.append(name);
    if (ch.live) t.append(el('span', 'dot'));
    t.title = !ch.live ? 'offline'
      : `AO VIVO · ${ch.viewers} espectadores\n${ch.title}`
        + (queued ? '\nNa fila: entra quando abrir uma vaga (o chat aparece quando estiver assistindo)' : '');
    t.onclick = () => select(ch.slug);
    nav.append(t);
  }
  const add = el('div', 'tab add', '+');
  add.title = 'Adicionar canal';
  add.onclick = () => {
    const input = el('input');
    input.placeholder = 'nome do canal';
    add.replaceChildren(input);
    input.focus();
    const done = async (commit) => {
      if (commit && input.value.trim()) { state = await window.kick.addChannel(input.value); select(state.channels[state.channels.length - 1].slug); }
      renderTabs();
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
    input.onblur = () => done(false);
  };
  nav.append(add);
}

function select(slug) {
  active = slug;
  unread.delete(slug);
  const box = $('#messages');
  box.replaceChildren(...(buffers.get(slug) || []));
  box.scrollTop = box.scrollHeight;
  renderTabs();
  renderHeader();
  $('#input').focus();
}

function renderHeader() {
  const ch = state.channels.find((c) => c.slug === active);
  const title = $('#chat-title');
  title.replaceChildren();
  if (!ch) return;
  title.append(el('b', null, ch.displayName), ch.live ? ` · AO VIVO · ${ch.viewers} · ${ch.title}` : ' · offline');
  if (ch.ageGate) {
    const warn = el('button', 'age-gate', '⚠ Canal +18: clique para confirmar a idade');
    warn.title = 'A Kick pede confirmação de idade antes de tocar esta live. Sem isso, ela não conta pontos.';
    warn.onclick = () => window.kick.showChannel(ch.slug);
    title.prepend(warn, ' ');
  }
  $('#input').placeholder = ch.chatroomId ? `Enviar mensagem em ${ch.displayName}…` : 'Carregando canal…';
  const pts = $('#points-val');
  const text = ch.points != null ? ch.points.toLocaleString('pt-BR') : '—';
  if (pts.textContent !== text) {
    if (pts.textContent !== '—' && ch.points != null) {
      const btn = $('#btn-points');
      btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump');
    }
    pts.textContent = text;
  }
}

// ---------- Teste de limite ----------
function resultLines(results) {
  return results.map((r) => `${r.lives} lives → +${r.pts} pts em ${r.minutes} min (≈ ${r.counting} lives contando)`);
}

function renderLimitTest() {
  const t = state.limitTest;
  const info = $('#limit-info');
  const btn = $('#btn-limit');
  info.replaceChildren();
  if (t) {
    btn.textContent = 'Cancelar teste';
    info.append(el('div', 'limit-now',
      `Etapa ${t.step}/${t.steps}: ${t.lives} lives · ${t.warming ? 'aquecendo' : 'medindo'} · ${t.leftMin} min nesta etapa (~${t.totalLeftMin} min no total)`));
    for (const line of resultLines(t.results)) info.append(el('div', null, line));
    return;
  }
  btn.textContent = state.limitResult ? 'Refazer teste de limite' : 'Descobrir limite de lives';
  btn.disabled = !state.loggedIn;
  btn.title = state.loggedIn ? 'Abre todas as lives ao vivo e mede quantas a Kick conta; se não forem todas, testa números menores (~20 min por etapa) e ajusta o app para o que rende mais pontos' : 'Faça login na Kick para testar';
  const r = state.limitResult;
  if (!r) return;
  info.append(el('div', 'limit-now', `Último teste (${new Date(r.at).toLocaleString('pt-BR')}): usando ${r.chosen} lives`));
  for (const line of resultLines(r.results)) info.append(el('div', null, line));
}

// ---------- Painel / status ----------
function renderPanel() {
  const rows = $('#panel-rows');
  rows.replaceChildren();
  let totalPts = 0, gained = 0, watching = 0, live = 0;
  const queued = state.channels.filter((c) => c.live && !c.watching).length;
  for (const ch of state.channels) {
    if (ch.points != null) totalPts += ch.points;
    if (ch.gained > 0) gained += ch.gained;
    if (ch.watching) watching++;
    if (ch.live) live++;
    const tr = el('tr');
    const st = ch.ageGate ? el('span', 'pill age', 'CONFIRMAR +18')
      : ch.earning === 'earning' ? el('span', 'pill watching', 'GANHANDO')
      : ch.earning === 'warming' ? el('span', 'pill warming', 'AQUECENDO')
      : ch.earning === 'idle' ? el('span', 'pill stalled', 'SEM PONTOS')
      : ch.live ? el('span', 'pill queue', state.rotation ? 'NA FILA' : 'SEM VAGA') : el('span', 'pill', 'offline');
    if (ch.earning === 'warming') st.title = 'A Kick dá a primeira contagem ~6–7 min depois que a live abre.';
    if (ch.earning === 'idle') st.title = 'Tocando há mais de 13 min sem o saldo subir. A Kick só conta ~2 lives por vez.';
    if (ch.live && ch.goalLeft != null && state.rotation) st.title = `${st.title || ''}\nFaltam ${ch.goalLeft} pts para ${ch.goal}`.trim();
    const tdStatus = el('td'); tdStatus.append(st);
    if (ch.error) tdStatus.title = ch.error;
    const tdPts = el('td', null, ch.points != null ? ch.points.toLocaleString('pt-BR') : '—');
    if (ch.gained > 0) tdPts.append(' ', el('span', 'gain', `+${ch.gained}`));
    const tdName = el('td', null, ch.displayName);
    if (ch.following) { const f = el('span', 'follow', ' ♥'); f.title = 'Você segue este canal'; tdName.append(f); }
    if (ch.subscribed) { const b = el('span', 'sub', ' SUB'); b.title = 'Você é sub: pontos em dobro aqui. Com o foco ligado, este canal vem primeiro enquanto estiver ao vivo.'; tdName.append(b); }
    tr.append(tdName, tdStatus, tdPts, el('td', null, `${ch.watchedMin} min`));
    tr.style.cursor = 'pointer';
    tr.onclick = () => select(ch.slug);
    rows.append(tr);
  }
  renderLimitTest();
  $('#summary').textContent = !state.loggedIn ? `${live} ao vivo · Faça login para farmar pontos` : `${live} ao vivo · ${watching} assistindo`
    + (queued ? (state.rotation ? ` · ${queued} na fila (foco no próximo bônus)` : ` · ${queued} sem vaga`) : '')
    + ` · ${totalPts.toLocaleString('pt-BR')} pts`
    + (gained ? ` (+${gained.toLocaleString('pt-BR')} nesta sessão)` : '');
}

function applyState(s) {
  const prevLive = new Map(state.channels.map((c) => [c.slug, c.live]));
  state = s;
  for (const ch of state.channels) {
    const was = prevLive.get(ch.slug);
    if (was === false && ch.live) pushMessage(ch.slug, systemMessage(`${ch.displayName} entrou ao vivo.`));
    if (was === true && !ch.live) pushMessage(ch.slug, systemMessage(`${ch.displayName} está offline.`));
  }
  if (!active && state.channels.length) active = state.channels[0].slug;
  $('#farming').checked = state.farming;
  $('#low-quality').checked = state.lowQuality;
  $('#rotation').checked = state.rotation;
  $('#bonus-target').value = String(state.bonusTarget || 0);
  $('#bonus-target').disabled = !state.rotation;
  $('#autostart').checked = !!state.openAtLogin;
  // No Linux a bandeja pode não aparecer (GNOME sem extensão), então o Sair fica também na janela.
  if (state.platform === 'linux') {
    $('#autostart-label span').textContent = 'Iniciar com o sistema';
    $('#autostart-label').title = 'Abre sozinho, direto na bandeja, quando você entra no computador';
    $('#btn-quit').hidden = false;
  }
  $('#notify-bonus').checked = !!state.notifyBonus;
  $('#memory').textContent = state.memoryMB ? `${state.memoryMB} MB` : '';
  $('#btn-login').textContent = state.loggedIn ? 'Conectado ✓' : 'Login Kick';
  $('#btn-login').classList.toggle('ok', !!state.loggedIn);
  $('#btn-logout').hidden = !state.loggedIn;
  if (document.activeElement !== $('#max-watchers')) $('#max-watchers').value = state.maxWatchers;
  renderTabs();
  renderHeader();
  renderPanel();
}

// ---------- Eventos ----------
$('#btn-login').onclick = () => window.kick.showLogin();
$('#btn-logout').onclick = async () => applyState(await window.kick.logout());
$('#btn-refresh').onclick = async () => applyState(await window.kick.refresh());
$('#farming').onchange = async (e) => applyState(await window.kick.setFarming(e.target.checked));
$('#btn-limit').onclick = async () => applyState(await (state.limitTest ? window.kick.stopLimitTest() : window.kick.startLimitTest()));
$('#autostart').onchange = async (e) => applyState(await window.kick.setAutostart(e.target.checked));
$('#btn-quit').onclick = () => window.kick.quit();
$('#notify-bonus').onchange = async (e) => applyState(await window.kick.setNotifyBonus(e.target.checked));
$('#rotation').onchange = async (e) => applyState(await window.kick.setRotation(e.target.checked));
$('#bonus-target').onchange = async (e) => applyState(await window.kick.setBonusTarget(Number(e.target.value)));
$('#low-quality').onchange = async (e) => applyState(await window.kick.setLowQuality(e.target.checked));
$('#max-watchers').onchange = async (e) => applyState(await window.kick.setMaxWatchers(e.target.value));
$('#btn-panel').onclick = () => {
  const p = $('#panel');
  p.hidden = !p.hidden;
  $('#btn-panel').textContent = p.hidden ? 'Pontos ▸' : 'Pontos ◂';
};
$('#btn-points').onclick = () => active && window.kick.openStore(active);
$('#btn-show').onclick = () => active && window.kick.showChannel(active);
$('#btn-remove').onclick = async () => {
  if (!active) return;
  const slug = active;
  buffers.delete(slug);
  active = null;
  applyState(await window.kick.removeChannel(slug));
  if (state.channels.length) select(state.channels[0].slug); else $('#messages').replaceChildren();
};
$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#input');
  const ch = state.channels.find((c) => c.slug === active);
  const text = input.value.trim();
  if (!ch || !ch.chatroomId || !text) return;
  input.value = '';
  const res = await window.kick.sendChat(ch.chatroomId, text);
  if (!res.ok) pushMessage(ch.slug, systemMessage(`Falha ao enviar (${res.status}${res.message ? ': ' + res.message : ''}). Você fez login?`));
};

window.kick.onStatus(applyState);
window.kick.onChat(({ slug, kind, data }) => {
  if (kind === 'message') pushMessage(slug, renderChat(data));
  else if (kind === 'reward') pushMessage(slug, systemMessage(`🎁 ${data.username} resgatou "${data.reward_title}"`));
});
window.kick.getState().then((s) => { applyState(s); if (active) select(active); });
