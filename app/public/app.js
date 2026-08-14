/* OutreacherXYZ control panel — front-end logic */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const api = {
  get: (p) => fetch(p).then((r) => r.json()),
  post: (p, body) => fetch(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json()),
};

let state = null;
let wizardStep = 0;

/* ---------- view switching ---------- */

function render() {
  const setupDone = state && state.setupComplete;
  $('#wizard').classList.toggle('hidden', !!setupDone);
  $('#dashboard').classList.toggle('hidden', !setupDone);
  $('#btn-setup').classList.toggle('hidden', !setupDone);
  $('#open-sheet').classList.toggle('hidden', !(setupDone && state.sheetId));
  if (state && state.sheetId) {
    $('#open-sheet').href = `https://docs.google.com/spreadsheets/d/${state.sheetId}`;
  }
  if (!setupDone) renderWizard();
  else renderRunners();
}

/* ---------- wizard ---------- */

function showStep(n) {
  wizardStep = n;
  $$('.step').forEach((el) => el.classList.toggle('hidden', +el.dataset.step !== n));
  $$('.stepper li').forEach((el) => {
    el.classList.toggle('active', +el.dataset.step === n);
    el.classList.toggle('done', +el.dataset.step < n);
  });
}

function renderWizard() {
  if (!state) return;
  // step 1 checklist
  $('#chk-node').classList.add('ok');
  $('#node-version').textContent = state.node;
  $('#chk-deps').classList.toggle('ok', state.depsInstalled);
  $('#chk-chromium').classList.toggle('ok', state.chromiumInstalled);
  const ready = state.depsInstalled && state.chromiumInstalled;
  $('#next-1').disabled = !ready;
  $('#btn-install').disabled = state.procs.install.status === 'running';
  if (['running', 'error'].includes(state.procs.install.status)) {
    $('#install-log').classList.remove('hidden');
    openLogStream('install', $('#install-log'));
  }
  if (ready) $('#install-status').textContent = 'All installed ✓';
  else if (state.procs.install.status === 'running') $('#install-status').textContent = 'Installing…';
  else if (state.procs.install.status === 'error') $('#install-status').textContent = 'Something failed — see the log below, then try again.';
  // step 2
  if (state.clientEmail) {
    $('#creds-ok').classList.remove('hidden');
    $('#client-email').textContent = state.clientEmail;
    $$('.client-email-echo').forEach((el) => (el.textContent = state.clientEmail));
    $('#next-2').disabled = false;
  }
}

$$('.step [data-next]').forEach((b) => b.addEventListener('click', () => showStep(wizardStep + 1)));
$$('.step [data-back]').forEach((b) => b.addEventListener('click', () => showStep(wizardStep - 1)));

$('#btn-install').addEventListener('click', async () => {
  $('#install-log').classList.remove('hidden');
  openLogStream('install', $('#install-log'));
  await api.post('/api/install');
  refresh();
});

/* credentials upload */
const dropzone = $('#dropzone');
const fileInput = $('#creds-file');
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer.files[0]) handleCredsFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => fileInput.files[0] && handleCredsFile(fileInput.files[0]));

function handleCredsFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let creds;
    try { creds = JSON.parse(reader.result); } catch (e) {
      return showCredsError('That file is not valid JSON. Make sure you picked the key file downloaded from Google Cloud.');
    }
    const res = await api.post('/api/credentials', { credentials: creds });
    if (res.error) return showCredsError(res.error);
    $('#creds-err').classList.add('hidden');
    refresh();
  };
  reader.readAsText(file);
}

function showCredsError(msg) {
  const el = $('#creds-err');
  el.textContent = msg;
  el.classList.remove('hidden');
}

$('#btn-copy-email').addEventListener('click', () => {
  navigator.clipboard.writeText($('#client-email').textContent);
  $('#btn-copy-email').textContent = 'Copied ✓';
  setTimeout(() => ($('#btn-copy-email').textContent = 'Copy'), 1500);
});

/* sheet connect */
$('#btn-connect-sheet').addEventListener('click', async () => {
  const ok = $('#sheet-ok'); const err = $('#sheet-err');
  ok.classList.add('hidden'); err.classList.add('hidden');
  $('#btn-connect-sheet').disabled = true;
  $('#btn-connect-sheet').textContent = 'Connecting…';
  try {
    const saved = await api.post('/api/config', { sheet: $('#sheet-url').value });
    if (saved.error) throw new Error(saved.error);
    const prep = await api.post('/api/sheet/setup');
    if (!prep.ok) throw new Error(prep.error || 'Could not reach the sheet. Did you share it with the robot account as Editor?');
    ok.innerHTML = `✓ Connected to <strong></strong>` ;
    ok.querySelector('strong').textContent = `“${prep.title}”`;
    if (prep.created.length) ok.append(` — set up ${prep.created.length} tabs for you.`);
    ok.classList.remove('hidden');
    $('#btn-finish').classList.remove('hidden');
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    $('#btn-connect-sheet').disabled = false;
    $('#btn-connect-sheet').textContent = 'Connect';
  }
});

$('#btn-finish').addEventListener('click', async () => {
  await api.post('/api/setup/complete');
  await refresh();
  loadStats();
});

$('#btn-setup').addEventListener('click', async () => {
  await api.post('/api/setup/reopen');
  await refresh();
  showStep(1);
});

/* ---------- dashboard ---------- */

const RUNNERS = {
  instagram: { name: 'Instagram', icon: '📸', min: 5000, max: 250000 },
  tiktok: { name: 'TikTok', icon: '🎵', min: '', max: '' },
};
const runnerEls = {};

function buildRunner(target) {
  const tpl = $('#runner-template').content.cloneNode(true);
  const card = tpl.querySelector('.runner');
  const cfg = RUNNERS[target];
  tpl.querySelector('.runner-name').textContent = cfg.name;
  tpl.querySelector('.runner-icon').textContent = cfg.icon;
  const el = {
    card,
    pill: tpl.querySelector('[data-role=pill]'),
    pillText: tpl.querySelector('[data-role=pill-text]'),
    min: tpl.querySelector('[data-role=min]'),
    max: tpl.querySelector('[data-role=max]'),
    pace: tpl.querySelector('[data-role=pace]'),
    start: tpl.querySelector('[data-role=start]'),
    stop: tpl.querySelector('[data-role=stop]'),
    banner: tpl.querySelector('[data-role=login-banner]'),
    cont: tpl.querySelector('[data-role=continue]'),
    leads: tpl.querySelector('[data-role=session-leads]'),
    toggleLog: tpl.querySelector('[data-role=toggle-log]'),
    log: tpl.querySelector('[data-role=log]'),
  };
  el.min.value = cfg.min;
  el.max.value = cfg.max;
  el.start.addEventListener('click', async () => {
    const res = await api.post(`/api/run/${target}`, {
      min: el.min.value || undefined,
      max: el.max.value || undefined,
      pace: el.pace.value,
    });
    if (res.error) alert(res.error);
    el.log.classList.remove('hidden');
    el.toggleLog.textContent = 'Hide activity';
    refresh();
  });
  el.stop.addEventListener('click', () => api.post(`/api/stop/${target}`).then(refresh));
  el.cont.addEventListener('click', () => api.post(`/api/continue/${target}`).then(refresh));
  el.toggleLog.addEventListener('click', () => {
    const hidden = el.log.classList.toggle('hidden');
    el.toggleLog.textContent = hidden ? 'Show activity' : 'Hide activity';
  });
  $(`#runner-${target}`).replaceChildren(card);
  runnerEls[target] = el;
  openLogStream(target, el.log, (procState) => applyProcState(target, procState));
}

const PILL_LABELS = {
  idle: ['Idle', ''],
  starting: ['Starting…', 'is-starting'],
  'awaiting-login': ['Waiting for you to log in', 'is-waiting'],
  running: ['Scraping', 'is-running'],
  stopping: ['Stopping…', 'is-stopping'],
  error: ['Stopped with an error', 'is-error'],
};

function applyProcState(target, ps) {
  const el = runnerEls[target];
  if (!el) return;
  const [label, cls] = PILL_LABELS[ps.status] || [ps.status, ''];
  el.pillText.textContent = label;
  el.pill.className = 'pill' + (cls ? ' ' + cls : '');
  const active = ['starting', 'awaiting-login', 'running', 'stopping'].includes(ps.status);
  el.start.classList.toggle('hidden', active);
  el.stop.classList.toggle('hidden', !active);
  el.banner.classList.toggle('hidden', !ps.awaitingLogin);
  el.leads.textContent = ps.sessionLeads ? `${ps.sessionLeads} lead${ps.sessionLeads === 1 ? '' : 's'} this session` : '';
}

function renderRunners() {
  if (!runnerEls.instagram) { buildRunner('instagram'); buildRunner('tiktok'); }
  applyProcState('instagram', state.procs.instagram);
  applyProcState('tiktok', state.procs.tiktok);
}

/* ---------- stats ---------- */

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return n >= 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : n.toLocaleString();
}

async function loadStats() {
  if (!state || !state.setupComplete) return;
  const s = await api.get('/api/stats');
  const banner = $('#stats-error');
  if (!s.ok) {
    // Never leave dashes on screen with no explanation — an auth or sharing
    // problem looks exactly like "no leads yet" otherwise.
    banner.textContent = s.error || 'Could not read your sheet.';
    banner.classList.remove('hidden');
    return;
  }
  banner.classList.add('hidden');
  $('#stat-total').textContent = fmt(s.leads.crosscheck);
  $('#stat-cp').textContent = fmt(s.leads.creatorPredict);
  $('#stat-cf').textContent = fmt(s.leads.coinFluence);
  $('#stat-sent').textContent = fmt(s.leads.sent);
  $('#stat-sheet-name').textContent = state.sheetTitle ? `in “${state.sheetTitle}”` : '';
}

/* ---------- log streams (SSE) ---------- */

const streams = {};
function openLogStream(target, pre, onState) {
  if (streams[target]) return;
  const es = new EventSource(`/api/logs/${target}`);
  streams[target] = es;
  es.onmessage = (e) => {
    const { line } = JSON.parse(e.data);
    pre.textContent += line + '\n';
    const lines = pre.textContent.split('\n');
    if (lines.length > 400) pre.textContent = lines.slice(-400).join('\n');
    pre.scrollTop = pre.scrollHeight;
  };
  es.addEventListener('state', (e) => {
    if (onState) onState(JSON.parse(e.data));
    else refresh();
  });
}

/* ---------- polling ---------- */

async function refresh() {
  state = await api.get('/api/state');
  render();
}

(async function init() {
  await refresh();
  if (!state.setupComplete) showStep(0);
  loadStats();
  setInterval(refresh, 5000);
  setInterval(loadStats, 60000);
})();
