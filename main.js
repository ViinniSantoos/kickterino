// Kickterino — processo principal.
// Ideia: uma sessão de navegador persistente (você faz login na Kick uma vez),
// uma janela oculta "api" em kick.com para consultar status/pontos, e uma janela
// oculta e muda por canal AO VIVO tocando o player real — é isso que conta como "assistindo".
const {
  app, BrowserWindow, dialog, ipcMain, session, Tray, Menu, Notification, nativeImage, powerSaveBlocker, powerMonitor,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// Mantém vídeos rodando mesmo com janelas ocultas/minimizadas.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Com placa de vídeo, o Chromium congela vídeos de janelas ocultas (o tempo do player parava em 0–1 s).
app.commandLine.appendSwitch('disable-background-media-suspend');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,BackgroundVideoTrackOptimization,IntensiveWakeUpThrottling');
// O JavaScript de cada página reserva menos memória "jovem".
app.commandLine.appendSwitch('js-flags', '--max-semi-space-size=1');

// Pasta de dados alternativa (testes sem mexer na instalação de verdade).
if (process.env.KICKTERINO_DATA) app.setPath('userData', process.env.KICKTERINO_DATA);

const PARTITION = 'persist:kick';
const KICK = 'https://kick.com';
const POLL_MS = 60 * 1000;
const PLAYER_CHECK_MS = 30 * 1000;

const configPath = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG = {
  channels: [
    'yetz', 'biscoitao', 'surskity', 'tftoddy', 'techzz', 'clovaobengalalol', 'axt', 'yulla', 'faturetosl',
    'cogu', 'rodil', 'patopapao2', 'matta', 'luccatv', 'guaxilol1', 'dersin2k', 'mecmeno',
  ],
  farming: true,
  // Medido em 30/10/2026: a Kick só contou pontos em ~2 lives por vez (12 abertas renderam o
  // mesmo que 2). Mais vagas só gastam memória; o rodízio espalha os pontos entre os canais.
  maxWatchers: 2,
  lowQuality: true,
  rotation: true,
  notifyBonus: true,
};
let config = { ...DEFAULT_CONFIG };

function loadConfig() {
  try { config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; } catch {}
  // Canais oficiais novos de uma versão nova entram uma vez; os que a pessoa removeu não voltam.
  const seen = new Set(config.seenDefaults || config.channels);
  for (const slug of DEFAULT_CONFIG.channels) {
    if (!seen.has(slug) && !config.channels.includes(slug)) config.channels.push(slug);
  }
  config.seenDefaults = [...new Set([...seen, ...DEFAULT_CONFIG.channels])];
  // v2: instalações antigas vinham com 20 lives; passa para o padrão novo (2 + rodízio) uma vez.
  if ((config.configVersion || 1) < 2) {
    config.maxWatchers = DEFAULT_CONFIG.maxWatchers;
    config.rotation = true;
    config.configVersion = 2;
  }
  saveConfig();
}
function saveConfig() {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

let mainWin = null;
let apiWin = null;
let apiReady = null;
const watchers = new Map(); // slug -> BrowserWindow
const status = new Map();   // slug -> { live, viewers, chatroomId, title, points, watchedMs, watchingSince, error }

function send(channel, payload) {
  if (process.env.KICKTERINO_DEBUG && channel === 'chat') console.log(`CHAT ${payload.slug} ${payload.kind} ${payload.data.username || payload.data.sender.username}`);
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

// Anúncios e rastreadores de terceiros: não fazem parte da live e só gastam memória/CPU.
const BLOCKED_HOSTS = [
  'googlesyndication.com', 'doubleclick.net', 'googletagmanager.com', 'google-analytics.com',
  'googleadservices.com', 'adservice.google.com', 'imasdk.googleapis.com', 'amazon-adsystem.com',
  'facebook.net', 'facebook.com/tr', 'quora.com', 'analytics.tiktok.com', 'criteo.com', 'criteo.net',
  'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'taboola.com', 'hotjar.com', 'clarity.ms',
];

// Lives ocultas não precisam de imagens nem fontes: ninguém está olhando para elas.
const watcherIds = new Set();
const HIDDEN_SKIP = new Set(['image', 'font']);

function isHiddenWatcher(webContents) {
  if (!webContents || !watcherIds.has(webContents.id)) return false;
  const win = BrowserWindow.fromWebContents(webContents);
  return !!win && !userOpened.has(win);
}

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

function setupSession() {
  const ses = session.fromPartition(PARTITION);
  ses.setSpellCheckerEnabled(false);
  // Câmera, microfone, localização e afins: nenhuma página precisa disso aqui.
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    const url = details.url;
    cb({
      cancel: BLOCKED_HOSTS.some((h) => url.includes(h)) || url.startsWith('https://static.kick.com/ads/')
        || (HIDDEN_SKIP.has(details.resourceType) && isHiddenWatcher(details.webContents)),
    });
  });
}

// Deixa só a menor qualidade (160p) na lista de qualidades da live — o mesmo que escolher 160p no player.
function lowestQualityOnly(playlist) {
  const lines = playlist.split('\n');
  const head = [];
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) { variants.push([lines[i], lines[i + 1]]); i++; }
    else if (!variants.length) head.push(lines[i]);
  }
  if (variants.length < 2) return null;
  const bandwidth = (l) => Number((l.match(/BANDWIDTH=(\d+)/) || [0, Infinity])[1]);
  variants.sort((a, b) => bandwidth(a[0]) - bandwidth(b[0]));
  return [...head, ...variants[0]].join('\n') + '\n';
}

// Só a Kick e as páginas de login que ela usa abrem no app: nada de site de fora na mesma
// sessão que guarda o login. Pop-ups de login abrem numa janela normal com a mesma sessão.
const TRUSTED_DOMAINS = ['kick.com', 'google.com', 'accounts.youtube.com', 'apple.com', 'discord.com'];
const GOOGLE_REGIONAL = /^accounts\.google\.(com?\.)?[a-z]{2}$/; // o Google passa pelo domínio do país no login

function isTrustedUrl(url) {
  if (url === 'about:blank') return true;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (GOOGLE_REGIONAL.test(hostname)
      || TRUSTED_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`)));
  } catch { return false; }
}

app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => (isTrustedUrl(url) ? {
    action: 'allow',
    overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { partition: PARTITION } },
  } : { action: 'deny' }));
  const guard = (details) => { if (details.isMainFrame && !isTrustedUrl(details.url)) details.preventDefault(); };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
});

// Página "vazia" em kick.com: mesma origem e cookies, mas sem carregar o site inteiro.
const LIGHT_URL = `${KICK}/robots.txt`;

const withTimeout = (promise, ms) => Promise.race([
  promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
]);

function loadApi(url) {
  apiReady = new Promise((resolve) => apiWin.webContents.once('did-finish-load', resolve));
  apiWin.loadURL(url);
  return apiReady;
}

function createApiWindow() {
  apiWin = new BrowserWindow({
    width: 1100, height: 800, show: false, title: 'Kick — login', autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, backgroundThrottling: false },
  });
  apiWin.webContents.setAudioMuted(true);
  // Sem internet ou com a Kick fora do ar: tenta de novo sozinho. Nunca durante o login.
  const retryApi = () => setTimeout(() => { if (!apiWin.isVisible()) loadApi(LIGHT_URL); }, 30 * 1000);
  apiWin.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) retryApi();
  });
  apiWin.webContents.on('render-process-gone', retryApi);
  loadApi(LIGHT_URL);
  // Fechar a janela de login apenas a esconde e volta para a página leve.
  apiWin.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    apiWin.hide();
    loadApi(LIGHT_URL).then(poll);
  });
}

// Loja de pontos: o chat popout oficial da Kick, que tem o saldo e as recompensas do canal.
const storeWindows = new Map();
function openStore(slug) {
  let win = storeWindows.get(slug);
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 420, height: 720, title: `Pontos — ${slug}`, autoHideMenuBar: true, backgroundColor: '#0b0e0f',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { partition: PARTITION },
  });
  win.loadURL(`${KICK}/popout/${slug}/chat`);
  win.on('closed', () => { storeWindows.delete(slug); refreshChannel(slug).then(() => send('status', snapshot())); });
  storeWindows.set(slug, win);
}

async function sessionToken() {
  const cookies = await session.fromPartition(PARTITION).cookies.get({ url: KICK, name: 'session_token' });
  return cookies[0] ? decodeURIComponent(cookies[0].value) : '';
}

// Faz um fetch de dentro da página kick.com (mesmos cookies/headers de um navegador normal).
async function kickFetch(apiPath, { method = 'GET', body } = {}) {
  await withTimeout(apiReady, 20 * 1000);
  const token = await sessionToken();
  const code = `(async () => {
    const xsrf = decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || '');
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    const token = ${JSON.stringify(token)};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;
    const r = await fetch(${JSON.stringify(apiPath)}, {
      method: ${JSON.stringify(method)}, headers, credentials: 'include',
      ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''}
    });
    return { status: r.status, text: await r.text() };
  })()`;
  const res = await withTimeout(apiWin.webContents.executeJavaScript(code, true), 20 * 1000);
  let json = null;
  try { json = JSON.parse(res.text); } catch {}
  return { status: res.status, json };
}

// Na janela de cada live: força 160p enquanto ela está oculta e lê o chat do websocket
// que a própria página da Kick abre (realtime.*.kick.com), repassando mensagens e resgates.
function instrumentWatcher(slug, win) {
  const dbg = win.webContents.debugger;
  try { dbg.attach('1.3'); } catch { return; }
  const seen = new Set();
  dbg.on('message', async (_e, method, p) => {
    if (method === 'Fetch.requestPaused') {
      const pass = () => dbg.sendCommand('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      if (!config.lowQuality || win.isDestroyed() || userOpened.has(win)) return pass();
      try {
        const { body, base64Encoded } = await dbg.sendCommand('Fetch.getResponseBody', { requestId: p.requestId });
        const text = base64Encoded ? Buffer.from(body, 'base64').toString() : body;
        const low = text.includes('#EXT-X-STREAM-INF') ? lowestQualityOnly(text) : null;
        if (!low) return pass();
        await dbg.sendCommand('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: p.responseStatusCode || 200,
          responseHeaders: p.responseHeaders, body: Buffer.from(low).toString('base64'),
        });
      } catch { pass(); }
      return;
    }
    if (method !== 'Network.webSocketFrameReceived') return;
    for (const line of p.response.payloadData.split('\n')) {
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      const pub = frame.push && frame.push.pub && frame.push.pub.data;
      if (!pub || typeof pub.data !== 'string') continue;
      let data;
      try { data = JSON.parse(pub.data); } catch { continue; }
      if (pub.event === 'App\\Events\\ChatMessageEvent') {
        if (seen.has(data.id)) continue;
        seen.add(data.id);
        if (seen.size > 2000) seen.clear();
        send('chat', { slug, kind: 'message', data });
      } else if (pub.event === 'RewardRedeemedEvent') {
        send('chat', { slug, kind: 'reward', data });
      }
    }
  });
  dbg.sendCommand('Network.enable').catch(() => {});
  dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*.m3u8*', requestStage: 'Response' }] }).catch(() => {});
}

// Lives que a pessoa abriu para ver (com imagem, som e qualidade normal).
const userOpened = new WeakSet();

// Janela "invisível": existe para o Windows (o vídeo é desenhado e anda de verdade, ao contrário
// de uma janela oculta, que o Chromium congela), mas é transparente, não recebe cliques e não
// aparece na barra de tarefas nem no Alt+Tab.
function makeInvisible(win) {
  userOpened.delete(win);
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.setFocusable(false);
  win.setSize(480, 270);
  win.setPosition(0, 0);
  win.showInactive();
}

function startWatcher(slug) {
  if (watchers.has(slug)) return;
  const win = new BrowserWindow({
    width: 480, height: 270, x: 0, y: 0, show: false, title: `Kick — ${slug}`, autoHideMenuBar: true,
    type: 'toolbar', skipTaskbar: true, focusable: false, opacity: 0,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { partition: PARTITION, backgroundThrottling: false, spellcheck: false },
  });
  win.webContents.setAudioMuted(true);
  const wcId = win.webContents.id;
  watcherIds.add(wcId);
  win.on('closed', () => watcherIds.delete(wcId));
  instrumentWatcher(slug, win);
  win.loadURL(`${KICK}/${slug}`);
  makeInvisible(win);
  // Fechar a live aberta só a torna invisível de novo: volta para 160p, sem som e sem imagens.
  win.on('close', (e) => {
    if (app.isQuitting || watchers.get(slug) !== win) return;
    e.preventDefault();
    makeInvisible(win);
    win.webContents.setAudioMuted(true);
    win.webContents.reload();
  });
  win.on('closed', () => { if (watchers.get(slug) === win) watchers.delete(slug); });
  // Página que caiu ou não carregou: fecha, e a próxima rodada abre de novo (ou põe outra live).
  const drop = () => setImmediate(() => { if (watchers.get(slug) === win) stopWatcher(slug); });
  win.webContents.on('render-process-gone', drop);
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) drop();
  });
  watchers.set(slug, win);
  const s = status.get(slug) || {};
  s.watchingSince = Date.now();
  status.set(slug, s);
}

function stopWatcher(slug) {
  const win = watchers.get(slug);
  if (!win) return;
  watchers.delete(slug);
  const s = status.get(slug);
  if (s && s.watchingSince) { s.watchedMs = (s.watchedMs || 0) + (Date.now() - s.watchingSince); s.watchingSince = null; }
  if (!win.isDestroyed()) win.destroy();
}

// Avisa quando o saldo do canal alcança um bônus do PokeIdle. O saldo ao abrir o app é a
// referência: só o que for alcançado depois gera aviso.
const BONUSES = [
  { cost: 300, name: '+15% XP' }, { cost: 500, name: '+15% Capture Boost' }, { cost: 1000, name: '+15% Secret Lure' },
];
const liveNotifications = new Set(); // sem referência, o Windows perde o clique na notificação

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, 'build', 'icon.png') });
  liveNotifications.add(n);
  n.on('click', () => { liveNotifications.delete(n); if (onClick) onClick(); });
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}

function checkBonus(slug, s) {
  const tier = BONUSES.filter((b) => s.points >= b.cost).length;
  if (s.bonusTier != null && tier > s.bonusTier && config.notifyBonus) {
    notify(`${s.displayName || slug}: ${s.points} pontos`, `Já dá para resgatar ${BONUSES[tier - 1].name}. Clique para abrir a loja.`, () => openStore(slug));
  }
  s.bonusTier = tier;
}

async function refreshChannel(slug) {
  const s = status.get(slug) || { watchedMs: 0 };
  try {
    const { status: code, json } = await kickFetch(`/api/v2/channels/${slug}`);
    if (code !== 200 || !json) throw new Error(`HTTP ${code}`);
    s.chatroomId = json.chatroom && json.chatroom.id;
    s.live = !!json.livestream;
    s.viewers = json.livestream ? json.livestream.viewer_count : 0;
    s.title = json.livestream ? json.livestream.session_title : '';
    s.displayName = (json.user && json.user.username) || slug;
    s.error = null;
  } catch (e) {
    s.error = String(e.message || e);
  }
  // Se a conta segue o canal (só logado) — para conferir se seguir influencia nos pontos.
  try {
    const { status: code, json } = await kickFetch(`/api/v2/channels/${slug}/me`);
    if (code === 200 && json && typeof json.is_following === 'boolean') s.following = json.is_following;
  } catch {}
  // Saldo de pontos — endpoint não documentado; se falhar, só mostramos "—".
  try {
    const { status: code, json } = await kickFetch(`/api/v2/channels/${slug}/points`);
    if (code === 200 && json) {
      const p = json.data ? json.data.points : json.points;
      if (typeof p === 'number') {
        // Ganho de assistir (gastos na loja fazem o saldo cair e não contam).
        if (s.points != null && p > s.points) {
          s.gainedTotal = (s.gainedTotal || 0) + (p - s.points);
          if (watchers.has(slug)) s.lastGainAt = Date.now();
        }
        s.points = p;
        checkBonus(slug, s);
      }
    }
  } catch {}
  status.set(slug, s);
}

// Confere cada live oculta: aviso +18 (só a pessoa pode confirmar) e estado do player, para o
// histórico. O tempo do vídeo NÃO indica se a live conta: no player da Kick ele fica em 0–1 s
// mesmo com os pontos subindo, então quem diz se está valendo é o saldo (ver lastGainAt).
async function checkPlayers() {
  for (const [slug, win] of watchers) {
    const s = status.get(slug);
    if (!s || win.isDestroyed() || userOpened.has(win)) continue;
    const info = await withTimeout(win.webContents.executeJavaScript(`(() => {
      const v = document.querySelector('video');
      return {
        gate: !!document.querySelector('[data-testid="mature"]'),
        visibility: document.visibilityState,
        video: v ? { paused: v.paused, time: Math.round(v.currentTime), height: v.videoHeight, ready: v.readyState } : null,
      };
    })()`), PLAYER_CHECK_MS).catch((err) => {
      // Página congelada não responde nunca: fecha, e a próxima rodada abre de novo (ou põe outra live).
      if (err.message === 'timeout' && watchers.get(slug) === win) stopWatcher(slug);
      return null;
    });
    if (!info) continue;
    s.ageGate = info.gate;
    s.visibility = info.visibility;
    s.video = info.video;
  }
}

// "Ganhando": o saldo subiu nos últimos minutos enquanto a live tocava. A primeira contagem
// leva ~6–7 min depois que a live abre; depois, +10 a cada ~5–6 min.
const EARN_WINDOW_MS = 13 * 60 * 1000;
function earningState(slug, now) {
  const s = status.get(slug) || {};
  if (!watchers.has(slug)) return null;
  if (s.lastGainAt && now - s.lastGainAt < EARN_WINDOW_MS) return 'earning';
  if (now - (s.watchingSince || now) < EARN_WINDOW_MS) return 'warming';
  return 'idle';
}

// Histórico em points-log.jsonl (pasta de dados do app): uma linha por minuto com pontos e
// estado de cada live. Serve para conferir se os pontos sobem com o app minimizado.
function logHistory() {
  const now = Date.now();
  const channels = {};
  for (const slug of config.channels) {
    const s = status.get(slug) || {};
    if (!s.live && s.points == null) continue;
    channels[slug] = {
      live: !!s.live, watching: watchers.has(slug), points: s.points ?? null, following: s.following ?? null,
      earning: earningState(slug, now), video: s.video || null, visibility: s.visibility || null,
      gate: !!s.ageGate, watchedMin: Math.floor(totalWatched(slug, now) / 60000),
    };
  }
  const line = JSON.stringify({
    t: new Date(now).toISOString(), mainMinimized: !!mainWin && mainWin.isMinimized(),
    mainFocused: !!mainWin && mainWin.isFocused(), loggedIn, memoryMB: snapshot().memoryMB,
    maxWatchers: config.maxWatchers, limitTest: limitTestSnapshot(), channels,
  });
  const file = path.join(app.getPath('userData'), 'points-log.jsonl');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, line + '\n');
  } catch {}
}

// Foco em bônus: o saldo é separado por canal, então espalhar pontos atrasa as compras. As vagas
// vão para quem está mais perto do próximo bônus, e todos os canais ao vivo chegam a 300 antes
// de alguém buscar 500, depois 1.000 e cada milhar seguinte. Cada troca perde ~6–7 min até a primeira contagem, por isso só troca
// quando o canal bateu a meta ou quando a diferença compensa (SWITCH_MARGIN).
const SWITCH_MARGIN = 50;
const IDLE_COOLDOWN_MS = 30 * 60 * 1000;

function goalRank(points) {
  const p = points || 0;
  // Passou de 1.000: cada milhar é uma meta nova, então ninguém dispara na frente dos outros.
  const thousands = Math.floor(p / 1000);
  const tier = thousands ? BONUSES.length - 1 + thousands : BONUSES.filter((b) => p >= b.cost).length;
  const goal = thousands ? (thousands + 1) * 1000 : BONUSES[tier].cost;
  return { tier, goal, left: goal - p };
}

const compareGoal = (a, b) => {
  const ra = goalRank(a.points), rb = goalRank(b.points);
  return !!a.cooling - !!b.cooling || ra.tier - rb.tier || ra.left - rb.left;
};

function worthSwitching(candidate, current) {
  if (candidate.cooling) return false;
  const c = goalRank(candidate.points), w = goalRank(current.points);
  return c.tier < w.tier || (c.tier === w.tier && c.left + SWITCH_MARGIN < w.left);
}

const totalWatched = (slug, now) => {
  const s = status.get(slug) || {};
  return (s.watchedMs || 0) + (s.watchingSince ? now - s.watchingSince : 0);
};
const turnTime = (slug, now) => now - ((status.get(slug) || {}).watchingSince || now);
const isShown = (slug) => { const w = watchers.get(slug); return !!w && !w.isDestroyed() && userOpened.has(w); };

// Rodando direto, a página da Kick vai acumulando memória: renova a live de tempos em tempos.
const RECYCLE_MS = 6 * 60 * 60 * 1000;

function reconcileWatchers() {
  const now = Date.now();
  // Sem login a Kick não dá pontos: abrir live só gastaria memória.
  const canFarm = config.farming && (loggedIn || process.env.KICKTERINO_ALLOW_ANON);
  for (const slug of [...watchers.keys()]) {
    const s = status.get(slug);
    if (isShown(slug)) continue;
    if (!canFarm || !config.channels.includes(slug) || (s && s.live === false)) stopWatcher(slug);
  }
  if (!canFarm) return;

  // Vaga não pode ficar parada: com o limite de 2 lives, quem não rende cede o lugar.
  // Com mais vagas que isso, ficar sem ganhar é esperado, então não mexe.
  for (const slug of [...watchers.keys()]) {
    if (isShown(slug)) continue;
    const idle = loggedIn && !limitTest && config.maxWatchers <= 2 && earningState(slug, now) === 'idle';
    if (idle && s) s.cooldownUntil = now + IDLE_COOLDOWN_MS; // senão voltaria na mesma hora
    if (idle || turnTime(slug, now) >= RECYCLE_MS) stopWatcher(slug);
  }

  // Limite reduzido: libera primeiro quem está há mais tempo na vez.
  const rotatable = () => [...watchers.keys()].filter((slug) => !isShown(slug))
    .sort((a, b) => turnTime(b, now) - turnTime(a, now));
  while (watchers.size > config.maxWatchers && rotatable().length) stopWatcher(rotatable()[0]);

  // Sem foco, as vagas seguem a ordem da lista de canais e ninguém troca de lugar.
  const focusInfo = (slug) => {
    const s = status.get(slug) || {};
    return { points: s.points, cooling: (s.cooldownUntil || 0) > now };
  };
  const byGoal = (a, b) => compareGoal(focusInfo(a), focusInfo(b));
  const waiting = config.channels.filter((slug) => !watchers.has(slug) && (status.get(slug) || {}).live);
  if (config.rotation) waiting.sort(byGoal);
  while (watchers.size < config.maxWatchers && waiting.length) startWatcher(waiting.shift());
  if (!config.rotation) return;

  for (const slug of rotatable().sort((a, b) => byGoal(b, a))) {
    if (!waiting.length || !worthSwitching(focusInfo(waiting[0]), focusInfo(slug))) break;
    stopWatcher(slug);
    startWatcher(waiting.shift());
  }
}

// Teste de limite: descobre quantas lives a Kick conta ao mesmo tempo. Em cada etapa abre N
// lives (sem rodízio), ignora o aquecimento e mede quantos pontos entraram no resto da etapa.
// Uma live no ritmo cheio rende 10 pts a cada 5 min, então "lives contando" ≈ pts / (min × 2).
// A 1ª etapa abre TODAS as lives ao vivo: se todas contarem, acaba ali. Senão, testa só os
// números até um pouco acima do que contou, para achar o menor que rende o máximo.
const LIMIT_LADDER = [2, 3, 4, 6, 8, 10, 13, 16, 20];
const LIMIT_STEP_MS = (Number(process.env.KICKTERINO_LIMIT_STEP_MIN) || 20) * 60 * 1000;
const LIMIT_WARMUP_MS = (Number(process.env.KICKTERINO_LIMIT_WARMUP_MIN) || 8) * 60 * 1000;
let limitTest = null;

const sumGained = () => [...status.values()].reduce((t, s) => t + (s.gainedTotal || 0), 0);
const liveCount = () => config.channels.filter((slug) => (status.get(slug) || {}).live).length;

function startLimitTest() {
  const all = Math.max(2, liveCount());
  limitTest = {
    i: 0, steps: [all, ...LIMIT_LADDER.filter((n) => n < all)],
    stepStart: Date.now(), baseline: null, results: [],
    prev: { maxWatchers: config.maxWatchers, rotation: config.rotation },
  };
  config.maxWatchers = all;
  config.rotation = false;
}

function stopLimitTest() {
  if (!limitTest) return;
  config.maxWatchers = limitTest.prev.maxWatchers;
  config.rotation = limitTest.prev.rotation;
  limitTest = null;
  saveConfig();
}

function advanceLimitTest() {
  if (!limitTest) return;
  const now = Date.now();
  const elapsed = now - limitTest.stepStart;
  if (limitTest.baseline == null && elapsed >= LIMIT_WARMUP_MS) {
    limitTest.baseline = sumGained();
    limitTest.baselineAt = now;
  }
  if (elapsed < LIMIT_STEP_MS || limitTest.baseline == null) return;

  const minutes = (now - limitTest.baselineAt) / 60000;
  const pts = sumGained() - limitTest.baseline;
  const result = {
    lives: limitTest.steps[limitTest.i], playing: watchers.size, minutes: Math.round(minutes),
    pts, counting: Math.round((pts / (minutes * 2)) * 10) / 10,
  };
  limitTest.results.push(result);
  if (limitTest.i === 0) {
    // Todas contaram (≥ 85%)? Então não há limite para achar. Senão, só testa até um pouco
    // acima do que contou.
    const cap = result.counting >= result.playing * 0.85 ? 0 : Math.ceil(result.counting) + 2;
    limitTest.steps = [limitTest.steps[0], ...limitTest.steps.slice(1).filter((n) => n <= Math.max(cap, 3) && cap > 0)];
  }
  limitTest.i++;
  if (limitTest.i < limitTest.steps.length) {
    Object.assign(limitTest, { stepStart: now, baseline: null });
    config.maxWatchers = limitTest.steps[limitTest.i];
    return;
  }
  // Fim: fica com o menor número de lives que rendeu pelo menos 90% do melhor resultado.
  const best = Math.max(...limitTest.results.map((r) => r.pts));
  const chosen = [...limitTest.results].sort((a, b) => a.lives - b.lives).find((r) => r.pts >= best * 0.9)
    || limitTest.results[0];
  config.limitResult = { at: new Date(now).toISOString(), results: limitTest.results, chosen: chosen.lives };
  config.maxWatchers = chosen.lives;
  config.rotation = true;
  limitTest = null;
  saveConfig();
}

function limitTestSnapshot() {
  if (!limitTest) return null;
  const elapsed = Date.now() - limitTest.stepStart;
  return {
    step: limitTest.i + 1, steps: limitTest.steps.length, lives: limitTest.steps[limitTest.i],
    warming: limitTest.baseline == null, leftMin: Math.max(0, Math.ceil((LIMIT_STEP_MS - elapsed) / 60000)),
    totalLeftMin: Math.ceil(((limitTest.steps.length - limitTest.i) * LIMIT_STEP_MS - elapsed) / 60000),
    results: limitTest.results,
  };
}

function snapshot() {
  const now = Date.now();
  return {
    farming: config.farming,
    maxWatchers: config.maxWatchers,
    lowQuality: config.lowQuality,
    rotation: config.rotation,
    limitTest: limitTestSnapshot(),
    limitResult: config.limitResult || null,
    openAtLogin: isOpenAtLogin(),
    notifyBonus: config.notifyBonus,
    channels: config.channels.map((slug) => {
      const s = status.get(slug) || {};
      const watchedMs = (s.watchedMs || 0) + (s.watchingSince ? now - s.watchingSince : 0);
      return {
        slug, displayName: s.displayName || slug, live: !!s.live, viewers: s.viewers || 0,
        title: s.title || '', chatroomId: s.chatroomId || null, points: s.points ?? null,
        watching: watchers.has(slug), ageGate: !!s.ageGate, earning: earningState(slug, now),
        following: s.following ?? null,
        gained: s.gainedTotal || 0,
        goal: s.points != null ? goalRank(s.points).goal : null,
        goalLeft: s.points != null ? goalRank(s.points).left : null,
        watchedMin: Math.floor(watchedMs / 60000), error: s.error || null,
      };
    }),
    memoryMB: Math.round(app.getAppMetrics().reduce((t, m) => t + m.memory.workingSetSize, 0) / 1024),
    loggedIn,
  };
}

// Uma rodada presa não pode parar o app: passado esse tempo, a seguinte começa mesmo assim.
const POLL_STUCK_MS = 5 * 60 * 1000;
let polling = false;
let pollStartedAt = 0;
let loggedIn = false;
async function poll() {
  if (polling && Date.now() - pollStartedAt < POLL_STUCK_MS) return;
  const startedAt = Date.now();
  polling = true;
  pollStartedAt = startedAt;
  try {
    loggedIn = !!(await sessionToken());
    await withTimeout(apiReady, 5 * 1000); // sem a página da Kick não há o que consultar agora
    for (const slug of config.channels) await refreshChannel(slug);
    // Nenhum canal respondeu: a página de consulta pode ter ficado velha, então renova.
    if (config.channels.length && config.channels.every((slug) => (status.get(slug) || {}).error) && !apiWin.isVisible()) {
      loadApi(LIGHT_URL);
    }
    advanceLimitTest();
    reconcileWatchers();
    await checkPlayers();
    logHistory();
    send('status', snapshot());
    updateTray();
    if (process.env.KICKTERINO_DEBUG) {
      console.log(JSON.stringify(snapshot()));
      for (const [slug, win] of watchers) {
        const h = await win.webContents.executeJavaScript(`(document.querySelector('video') || {}).videoHeight`).catch(() => '?');
        const mem = app.getAppMetrics().find((m) => m.pid === win.webContents.getOSProcessId());
        console.log(`VIDEO ${slug} ${h}p ${mem ? Math.round(mem.memory.workingSetSize / 1024) : '?'}MB`);
      }
      for (const m of app.getAppMetrics()) console.log(`PROC ${m.type} ${Math.round(m.memory.workingSetSize / 1024)}MB`);
    }
  } catch {
    // Kick ou internet fora do ar: a próxima rodada tenta de novo.
  } finally { if (pollStartedAt === startedAt) polling = false; }
}

// ---------- Modo 24/7 ----------
// Impede o PC de suspender enquanto farma. O monitor pode apagar normalmente.
let awakeBlocker = null;
function syncKeepAwake() {
  if (config.farming && awakeBlocker == null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!config.farming && awakeBlocker != null) { powerSaveBlocker.stop(awakeBlocker); awakeBlocker = null; }
}

function setFarming(on) {
  config.farming = !!on;
  saveConfig();
  syncKeepAwake();
  reconcileWatchers();
  updateTray();
  send('status', snapshot());
}

// O app portátil roda de uma pasta temporária: o que abre com o Windows é o .exe original.
const LOGIN_ITEM = { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ['--hidden'] };
const isOpenAtLogin = () => app.getLoginItemSettings(LOGIN_ITEM).openAtLogin;

function showMain() {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function quitApp() {
  app.isQuitting = true;
  app.quit();
}

let tray = null;
function updateTray() {
  if (!tray) return;
  const gained = sumGained();
  tray.setToolTip(`Kickterino — ${config.farming ? `${watchers.size} assistindo` : 'farm pausado'}${gained ? ` · +${gained} pts` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Kickterino', click: showMain },
    { label: 'Farmar pontos', type: 'checkbox', checked: config.farming, click: (item) => setFarming(item.checked) },
    { type: 'separator' },
    { label: 'Sair', click: quitApp },
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.on('click', showMain);
  updateTray();
}

// Depois de suspender ou ficar sem rede, as lives abertas não voltam sozinhas: reabre tudo.
function recoverAfterResume() {
  for (const slug of [...watchers.keys()]) if (!isShown(slug)) stopWatcher(slug);
  if (!apiWin.isVisible()) loadApi(LIGHT_URL);
  setTimeout(poll, 15 * 1000);
}

// Atualização automática pelo GitHub Releases. A versão portátil não se atualiza sozinha.
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
function setupAutoUpdate() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) return;
  const check = () => autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  autoUpdater.on('error', () => {}); // sem internet: tenta de novo na próxima rodada
  check();
  setInterval(check, UPDATE_CHECK_MS);
}

ipcMain.handle('state:get', () => snapshot());
ipcMain.handle('channels:add', async (_e, slug) => {
  slug = String(slug || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?kick\.com\//, '').replace(/[^a-z0-9_-]/g, '');
  if (slug && !config.channels.includes(slug)) { config.channels.push(slug); saveConfig(); poll(); }
  return snapshot();
});
ipcMain.handle('channels:remove', (_e, slug) => {
  config.channels = config.channels.filter((c) => c !== slug);
  stopWatcher(slug); status.delete(slug); saveConfig();
  return snapshot();
});
ipcMain.handle('farming:set', (_e, on) => { setFarming(on); return snapshot(); });
ipcMain.handle('autostart:set', (_e, on) => { app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: !!on }); return snapshot(); });
ipcMain.handle('notifyBonus:set', (_e, on) => { config.notifyBonus = !!on; saveConfig(); return snapshot(); });
ipcMain.handle('maxWatchers:set', (_e, n) => {
  limitTest = null; // mexer na mão cancela o teste de limite
  config.maxWatchers = Math.max(1, Math.min(30, Number(n) || 1)); saveConfig(); reconcileWatchers(); return snapshot();
});
ipcMain.handle('rotation:set', (_e, on) => { limitTest = null; config.rotation = !!on; saveConfig(); reconcileWatchers(); return snapshot(); });
ipcMain.handle('limitTest:start', () => {
  if (!loggedIn && !process.env.KICKTERINO_LIMIT_AUTOSTART) return snapshot(); // sem login a Kick não dá pontos: o teste não mediria nada
  startLimitTest(); reconcileWatchers(); return snapshot(); });
ipcMain.handle('limitTest:stop', () => { stopLimitTest(); reconcileWatchers(); return snapshot(); });
ipcMain.handle('lowQuality:set', (_e, on) => {
  config.lowQuality = !!on; saveConfig();
  for (const win of watchers.values()) if (!win.isDestroyed() && !userOpened.has(win)) win.webContents.reload();
  return snapshot();
});
ipcMain.handle('refresh', async () => { await poll(); return snapshot(); });
ipcMain.handle('login:show', async () => {
  apiWin.show(); apiWin.focus();
  await loadApi(`${KICK}/login`);
});
// Sair da conta: apaga cookies, cache e tudo que as páginas guardaram, inclusive o login do
// Google, Apple ou Discord. A lista de canais e as preferências ficam.
ipcMain.handle('logout', async () => {
  const { response } = await dialog.showMessageBox(mainWin, {
    type: 'question', buttons: ['Sair da conta', 'Cancelar'], defaultId: 1, cancelId: 1,
    title: 'Sair da conta', message: 'Sair da conta da Kick neste PC?',
    detail: 'Os dados de login salvos no app serão apagados. Para farmar de novo, será preciso entrar outra vez.',
  });
  if (response !== 0) return snapshot();
  for (const slug of [...watchers.keys()]) stopWatcher(slug);
  for (const win of storeWindows.values()) if (!win.isDestroyed()) win.close();
  const ses = session.fromPartition(PARTITION);
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
  ses.flushStorageData();
  status.clear();
  await loadApi(LIGHT_URL);
  await poll();
  return snapshot();
});
ipcMain.handle('store:open', (_e, slug) => openStore(slug));
// Mostra a live de verdade, com imagem, som e qualidade normal (e o aviso +18, se houver, para a pessoa confirmar).
ipcMain.handle('channel:show', (_e, slug) => {
  let win = watchers.get(slug);
  if (!win) { startWatcher(slug); win = watchers.get(slug); }
  userOpened.add(win);
  win.webContents.setAudioMuted(false);
  win.setOpacity(1);
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.setSize(960, 600); win.center();
  win.show(); win.focus();
  win.webContents.reload();
  const s = status.get(slug);
  if (s) s.ageGate = false;
  send('status', snapshot());
});
ipcMain.handle('chat:send', async (_e, { chatroomId, content }) => {
  const { status: code, json } = await kickFetch(`/api/v2/messages/send/${chatroomId}`, {
    method: 'POST', body: { content, type: 'message' },
  });
  return { ok: code >= 200 && code < 300, status: code, message: json && (json.message || (json.status && json.status.message)) };
});

// Só uma instância: abrir o atalho de novo traz a janela existente para frente.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', showMain);
app.setAppUserModelId('com.vinniisaantos.kickterino');

app.whenReady().then(() => {
  loadConfig();
  setupSession();
  mainWin = new BrowserWindow({
    width: 1100, height: 760, backgroundColor: '#1a1a1a', title: 'Kickterino',
    show: !process.argv.includes('--hidden'), // ao iniciar com o Windows, abre direto na bandeja
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Fechar a janela não para o farm: o app continua na bandeja, perto do relógio.
  mainWin.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    mainWin.hide();
    if (!config.trayHintShown) {
      config.trayHintShown = true;
      saveConfig();
      notify('O Kickterino continua farmando', 'Ele fica na bandeja, perto do relógio. Para sair de vez: botão direito no ícone > Sair.', showMain);
    }
  });
  // Desligar ou reiniciar o Windows não pode ficar preso na janela escondida.
  mainWin.on('query-session-end', () => { app.isQuitting = true; });
  mainWin.on('session-end', () => { app.isQuitting = true; });

  createTray();
  syncKeepAwake();
  powerMonitor.on('resume', recoverAfterResume);
  setupAutoUpdate();
  createApiWindow();
  apiReady.then(poll).then(() => {
    if (process.env.KICKTERINO_LIMIT_AUTOSTART) { startLimitTest(); reconcileWatchers(); }
  });
  setInterval(poll, POLL_MS);
  setInterval(() => send('status', snapshot()), 15 * 1000);
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => app.quit());
