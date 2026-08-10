#!/usr/bin/env node
// OutreacherXYZ local control panel.
// Zero-dependency HTTP server: serves the GUI, manages config/credentials,
// and drives the scraper processes with live log streaming.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4242;
const ROOT = path.join(__dirname, '..');
const SCRAPER = path.join(ROOT, 'scraper');
const PUBLIC = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const CREDS_PATH = path.join(SCRAPER, 'credentials.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// ---------- config ----------

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    return {};
  }
}

function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

// ---------- process + log management ----------

const TARGETS = ['instagram', 'tiktok', 'install'];
const procs = {};
for (const t of TARGETS) {
  procs[t] = { child: null, status: 'idle', awaitingLogin: false, sessionLeads: 0, log: [], sse: [] };
}

// npm and playwright emit colour codes and progress-bar redraws; strip them so
// the panel's log reads as plain text.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|[\r\b]/g;

function pushLog(target, line) {
  const p = procs[target];
  line = line.replace(ANSI, '').trimEnd();
  if (!line) return;
  p.log.push(line);
  if (p.log.length > 500) p.log.splice(0, p.log.length - 500);
  const payload = `data: ${JSON.stringify({ line })}\n\n`;
  for (const res of p.sse) res.write(payload);
}

function broadcastState(target) {
  const p = procs[target];
  const payload = `event: state\ndata: ${JSON.stringify(procState(target))}\n\n`;
  for (const res of p.sse) res.write(payload);
}

function procState(target) {
  const p = procs[target];
  return { status: p.status, awaitingLogin: p.awaitingLogin, sessionLeads: p.sessionLeads };
}

function handleChildLine(target, line) {
  const p = procs[target];
  if (/>>>.*[Ll]og in|Press ENTER after login/.test(line)) {
    p.awaitingLogin = true;
    if (p.status === 'starting') p.status = 'awaiting-login';
  }
  if (/Scraping \(campaign|\[Sheets\] Connected/.test(line) && p.status === 'starting' && !p.awaitingLogin) {
    p.status = 'running';
  }
  if (/\*\*\* FOUND:/.test(line)) p.sessionLeads += 1;
  pushLog(target, line);
  broadcastState(target);
}

function wireChild(target, child, doneStatus) {
  const p = procs[target];
  p.child = child;
  let buf = { out: '', err: '' };
  const onData = (key) => (chunk) => {
    buf[key] += chunk.toString();
    let idx;
    while ((idx = buf[key].indexOf('\n')) >= 0) {
      const line = buf[key].slice(0, idx).replace(/\r$/, '');
      buf[key] = buf[key].slice(idx + 1);
      if (line.trim()) handleChildLine(target, line);
    }
  };
  child.stdout.on('data', onData('out'));
  child.stderr.on('data', onData('err'));
  child.on('exit', (code) => {
    p.child = null;
    p.awaitingLogin = false;
    p.status = doneStatus(code);
    pushLog(target, `— process exited (${code === 0 || code === null ? 'stopped' : 'code ' + code})`);
    broadcastState(target);
  });
}

function startScraper(target, opts) {
  const p = procs[target];
  if (p.child) return { error: 'Already running' };
  const cfg = loadConfig();
  if (!cfg.sheetId) return { error: 'Connect a Google Sheet first (Setup)' };
  if (!fs.existsSync(CREDS_PATH)) return { error: 'Add Google credentials first (Setup)' };

  p.status = 'starting';
  p.awaitingLogin = false;
  p.sessionLeads = 0;
  p.log = [];
  pushLog(target, `— starting ${target} scraper…`);
  const child = spawn(process.execPath, [`run-${target}.js`], {
    cwd: SCRAPER,
    env: {
      ...process.env,
      SHEET_ID: cfg.sheetId,
      LEADS_TAB: cfg.leadsTab || 'crosscheck',
      MIN_FOLLOWERS: opts.min ? String(opts.min) : '0',
      MAX_FOLLOWERS: opts.max ? String(opts.max) : '',
      PROFILES_PER_HOUR: opts.pace === undefined ? '120' : String(Number(opts.pace) || 0),
      DEVICE_NAME: cfg.deviceName || os.hostname(),
      BLACKOUT_ENABLED: cfg.blackoutEnabled ? '1' : '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  wireChild(target, child, (code) => (code === 0 || code === null ? 'idle' : 'error'));
  broadcastState(target);
  return { ok: true };
}

function stopScraper(target) {
  const p = procs[target];
  if (!p.child) return { ok: true };
  p.status = 'stopping';
  pushLog(target, '— stopping…');
  broadcastState(target);
  const child = p.child;
  if (process.platform === 'win32') {
    child.kill();
  } else {
    child.kill('SIGINT');
    setTimeout(() => {
      if (p.child === child) child.kill('SIGKILL');
    }, 6000);
  }
  return { ok: true };
}

function continueLogin(target) {
  const p = procs[target];
  if (!p.child) return { error: 'Not running' };
  p.child.stdin.write('\n');
  p.awaitingLogin = false;
  p.status = 'running';
  pushLog(target, '— continuing after login…');
  broadcastState(target);
  return { ok: true };
}

function runInstall() {
  const p = procs.install;
  if (p.child) return { error: 'Install already running' };
  p.status = 'running';
  p.log = [];
  pushLog('install', '— installing scraper dependencies (this can take a few minutes)…');
  const shellOpts = { cwd: SCRAPER, shell: true, stdio: ['ignore', 'pipe', 'pipe'] };
  const step1 = spawn('npm install --no-fund --no-audit', [], shellOpts);
  wireChild('install', step1, () => 'running');
  step1.on('exit', (code) => {
    if (code !== 0) {
      p.status = 'error';
      pushLog('install', '— npm install failed. Check your internet connection and try again.');
      broadcastState('install');
      return;
    }
    pushLog('install', '— downloading the browser engine (Chromium)…');
    const step2 = spawn('npx playwright install chromium', [], shellOpts);
    wireChild('install', step2, (c) => (c === 0 ? 'done' : 'error'));
    step2.on('exit', (c) => {
      pushLog('install', c === 0 ? '— all set! ✓' : '— browser download failed. Try again.');
      broadcastState('install');
    });
  });
  broadcastState('install');
  return { ok: true };
}

// ---------- helpers that shell out to scraper/tools ----------

function runTool(script, cb) {
  const cfg = loadConfig();
  const child = spawn(process.execPath, [path.join('tools', script)], {
    cwd: SCRAPER,
    env: { ...process.env, SHEET_ID: cfg.sheetId || '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  child.on('exit', () => {
    try {
      cb(JSON.parse(out.trim().split('\n').pop()));
    } catch (e) {
      cb({ ok: false, error: (err || out || 'helper failed').slice(0, 400) });
    }
  });
  child.on('error', (e) => cb({ ok: false, error: e.message }));
}

// ---------- environment checks ----------

function browsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

// Ask playwright where the binary should be and check it is actually there.
// A directory alone is not proof: an interrupted download leaves the folder
// behind with nothing usable in it.
function chromiumInstalled() {
  try {
    const { chromium } = require(path.join(SCRAPER, 'node_modules', 'playwright'));
    return fs.existsSync(chromium.executablePath());
  } catch (err) {
    try {
      return fs.readdirSync(browsersPath()).some((d) => /^chromium-\d+/.test(d));
    } catch (e) {
      return false;
    }
  }
}

function getState() {
  const cfg = loadConfig();
  let clientEmail = null;
  try {
    clientEmail = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')).client_email || null;
  } catch (err) { /* no credentials yet */ }
  return {
    node: process.version,
    depsInstalled: fs.existsSync(path.join(SCRAPER, 'node_modules', 'googleapis')) &&
      fs.existsSync(path.join(SCRAPER, 'node_modules', 'playwright')),
    chromiumInstalled: chromiumInstalled(),
    clientEmail,
    sheetId: cfg.sheetId || null,
    sheetTitle: cfg.sheetTitle || null,
    setupComplete: !!cfg.setupComplete,
    deviceName: os.hostname(),
    procs: {
      instagram: procState('instagram'),
      tiktok: procState('tiktok'),
      install: procState('install'),
    },
  };
}

// ---------- stats cache ----------

let statsCache = { at: 0, data: null };

// ---------- request handling ----------

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 1e6) req.destroy();
  });
  req.on('end', () => {
    try {
      cb(body ? JSON.parse(body) : {});
    } catch (err) {
      cb(null);
    }
  });
}

function extractSheetId(input) {
  if (!input) return null;
  const urlMatch = input.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (urlMatch) return urlMatch[1];
  const raw = input.trim();
  return /^[a-zA-Z0-9_-]{20,}$/.test(raw) ? raw : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // --- static ---
  if (req.method === 'GET' && (p === '/' || /^\/[a-z.-]+\.(html|css|js|svg|png)$/.test(p))) {
    const file = path.join(PUBLIC, p === '/' ? 'index.html' : p.slice(1));
    return fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
      res.end(data);
    });
  }

  // --- SSE logs ---
  const sseMatch = p.match(/^\/api\/logs\/(instagram|tiktok|install)$/);
  if (req.method === 'GET' && sseMatch) {
    const target = sseMatch[1];
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const line of procs[target].log) res.write(`data: ${JSON.stringify({ line })}\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify(procState(target))}\n\n`);
    procs[target].sse.push(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      procs[target].sse = procs[target].sse.filter((r) => r !== res);
    });
    return;
  }

  // --- API ---
  if (p === '/api/state' && req.method === 'GET') return json(res, 200, getState());

  if (p === '/api/stats' && req.method === 'GET') {
    if (Date.now() - statsCache.at < 30000 && statsCache.data) return json(res, 200, statsCache.data);
    return runTool('sheet-stats.js', (result) => {
      if (result.ok) statsCache = { at: Date.now(), data: result };
      json(res, 200, result);
    });
  }

  if (p === '/api/install' && req.method === 'POST') return json(res, 200, runInstall());

  if (p === '/api/credentials' && req.method === 'POST') {
    return readBody(req, (body) => {
      if (!body) return json(res, 400, { error: 'Bad JSON' });
      const creds = body.credentials;
      if (!creds || creds.type !== 'service_account' || !creds.client_email ||
          !String(creds.private_key || '').includes('BEGIN PRIVATE KEY')) {
        return json(res, 400, { error: 'That does not look like a service account key file. It should be the JSON you downloaded from Google Cloud.' });
      }
      fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
      statsCache = { at: 0, data: null };
      json(res, 200, { ok: true, clientEmail: creds.client_email });
    });
  }

  if (p === '/api/config' && req.method === 'POST') {
    return readBody(req, (body) => {
      if (!body) return json(res, 400, { error: 'Bad JSON' });
      const sheetId = extractSheetId(body.sheet);
      if (!sheetId) return json(res, 400, { error: 'Could not find a sheet ID in that. Paste the full URL of your Google Sheet.' });
      saveConfig({ sheetId, sheetTitle: null });
      statsCache = { at: 0, data: null };
      json(res, 200, { ok: true, sheetId });
    });
  }

  if (p === '/api/sheet/setup' && req.method === 'POST') {
    return runTool('setup-sheet.js', (result) => {
      if (result.ok) saveConfig({ sheetTitle: result.title });
      json(res, 200, result);
    });
  }

  if (p === '/api/setup/complete' && req.method === 'POST') {
    saveConfig({ setupComplete: true });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/setup/reopen' && req.method === 'POST') {
    saveConfig({ setupComplete: false });
    return json(res, 200, { ok: true });
  }

  const runMatch = p.match(/^\/api\/(run|stop|continue)\/(instagram|tiktok)$/);
  if (runMatch && req.method === 'POST') {
    const [, action, target] = runMatch;
    if (action === 'stop') return json(res, 200, stopScraper(target));
    if (action === 'continue') return json(res, 200, continueLogin(target));
    return readBody(req, (body) => {
      const result = startScraper(target, body || {});
      json(res, result.error ? 409 : 200, result);
    });
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  OutreacherXYZ is running.');
  console.log(`  Open ${url} in your browser (it should open automatically).`);
  console.log('  Keep this window open while you use the tool. Press Ctrl+C to quit.');
  console.log('');
  if (!process.argv.includes('--no-open')) {
    const opener = process.platform === 'darwin' ? `open "${url}"`
      : process.platform === 'win32' ? `start "" "${url}"`
      : `xdg-open "${url}"`;
    spawn(opener, [], { shell: true, stdio: 'ignore' });
  }
});

process.on('SIGINT', () => {
  for (const t of ['instagram', 'tiktok']) {
    if (procs[t].child) procs[t].child.kill(process.platform === 'win32' ? undefined : 'SIGINT');
  }
  setTimeout(() => process.exit(0), 300);
});
