#!/usr/bin/env node
/**
 * Supervisor for long unattended runs: relaunches a scraper if it exits
 * unexpectedly, with a backoff so a persistent failure doesn't spin.
 *
 *   node run-resilient.js instagram
 *   node run-resilient.js tiktok --min 10000 --max 250000
 *
 * The nightly pause that used to live here is now a setting — see
 * BLACKOUT_ENABLED in the README. Ctrl+C stops the supervisor and the child.
 */
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const platform = (args[0] || '').toLowerCase();
const passArgs = args.slice(1);

const SCRIPTS = {
  instagram: 'run-instagram.js', ig: 'run-instagram.js',
  tiktok: 'run-tiktok.js', tt: 'run-tiktok.js',
};

if (!SCRIPTS[platform]) {
  console.log('Usage: node run-resilient.js <instagram|tiktok> [--min N] [--max N] [--device name]');
  process.exit(1);
}

const script = path.join(__dirname, SCRIPTS[platform]);
const MIN_BACKOFF = 30000;
const MAX_BACKOFF = 15 * 60 * 1000;

let backoff = MIN_BACKOFF;
let child = null;
let stopping = false;

function log(msg) {
  console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] [supervisor] ${msg}`);
}

function launch() {
  if (stopping) return;
  log(`starting ${SCRIPTS[platform]}`);
  const startedAt = Date.now();
  child = spawn(process.execPath, [script, ...passArgs], { stdio: 'inherit' });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    // A run that lasted a while was healthy; reset the backoff.
    if (Date.now() - startedAt > 10 * 60 * 1000) backoff = MIN_BACKOFF;

    if (code === 0) {
      log('scraper exited cleanly — supervisor stopping');
      process.exit(0);
    }
    log(`scraper exited (${signal || 'code ' + code}); restarting in ${Math.round(backoff / 1000)}s`);
    setTimeout(launch, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    log('stopping...');
    if (child) child.kill(sig);
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

launch();
