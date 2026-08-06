#!/usr/bin/env node

/**
 * ScraperUltra Resilient Runner
 *
 * For devices with parental controls that cut WiFi from 1:00-4:00 AM EST.
 * Automatically sleeps during blackout and restarts after.
 *
 * Usage:
 *   node run-resilient.js instagram --parental
 *   node run-resilient.js tiktok --parental
 *   node run-resilient.js ig --parental --device my-laptop
 *   node run-resilient.js tt --parental --device my-desktop
 */

const { spawn } = require('child_process');
const path = require('path');

// Blackout window: 1:00 AM - 4:00 AM EST
const BLACKOUT_START_MINUTES = 60;   // 1:00 AM = 60 minutes from midnight
const BLACKOUT_END_MINUTES = 240;    // 4:00 AM = 240 minutes from midnight
const SAFETY_BUFFER_MINUTES = 5;     // Stop 5 min early, resume 5 min late

function log(msg) {
  const time = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${time}] [RESILIENT] ${msg}`);
}

function getESTTime() {
  const now = new Date();
  const estOffset = -5; // EST is UTC-5
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 3600000 * estOffset);
}

function getESTMinutes() {
  const est = getESTTime();
  return est.getHours() * 60 + est.getMinutes();
}

function isInBlackoutWindow() {
  const minutes = getESTMinutes();
  // With safety buffer: stop at 12:55 AM, resume at 4:05 AM
  return minutes >= (BLACKOUT_START_MINUTES - SAFETY_BUFFER_MINUTES) &&
         minutes < (BLACKOUT_END_MINUTES + SAFETY_BUFFER_MINUTES);
}

function isApproachingBlackout() {
  const minutes = getESTMinutes();
  // 10 minutes before blackout
  return minutes >= (BLACKOUT_START_MINUTES - 10) &&
         minutes < BLACKOUT_START_MINUTES;
}

function getMinutesUntilBlackoutEnd() {
  const minutes = getESTMinutes();
  if (minutes < BLACKOUT_END_MINUTES + SAFETY_BUFFER_MINUTES) {
    return (BLACKOUT_END_MINUTES + SAFETY_BUFFER_MINUTES) - minutes;
  }
  // After 4:05 AM, next blackout is tomorrow
  return (24 * 60 - minutes) + (BLACKOUT_END_MINUTES + SAFETY_BUFFER_MINUTES);
}

function formatTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sleepUntilBlackoutEnds() {
  const minutesRemaining = getMinutesUntilBlackoutEnd();

  log('');
  log('='.repeat(50));
  log('  PARENTAL CONTROL BLACKOUT DETECTED');
  log('  WiFi will be off from 1:00 AM - 4:00 AM EST');
  log('='.repeat(50));
  log(`  Sleeping for ${formatTime(minutesRemaining)} until 4:05 AM EST...`);
  log('');

  // Sleep in 5-minute chunks with progress updates
  const totalChunks = Math.ceil(minutesRemaining / 5);
  for (let i = 0; i < totalChunks; i++) {
    const remaining = minutesRemaining - (i * 5);
    if (remaining <= 0) break;

    const sleepTime = Math.min(5, remaining);
    log(`  Blackout sleep: ${formatTime(remaining)} remaining...`);
    await sleep(sleepTime * 60 * 1000);
  }

  log('');
  log('='.repeat(50));
  log('  BLACKOUT ENDED - Resuming scraper');
  log('='.repeat(50));
  log('');
}

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
ScraperUltra Resilient Runner

Usage:
  node run-resilient.js <platform> --parental [options]

Platforms:
  instagram, ig    Run Instagram scraper
  tiktok, tt       Run TikTok scraper

Options:
  --parental       Enable parental control mode (auto-sleep 1-4 AM EST)
  --device <name>  Set device name for tracking

Examples:
  node run-resilient.js instagram --parental
  node run-resilient.js tiktok --parental --device my-laptop
`);
    process.exit(0);
  }

  const platform = args[0].toLowerCase();
  const hasParental = args.includes('--parental');

  // Pass through other args (--device, --manual, etc.)
  const passArgs = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--parental') continue;
    passArgs.push(args[i]);
  }

  let scriptPath;
  if (platform === 'instagram' || platform === 'ig') {
    scriptPath = path.join(__dirname, 'run-instagram.js');
  } else if (platform === 'tiktok' || platform === 'tt') {
    scriptPath = path.join(__dirname, 'run-tiktok.js');
  } else {
    console.error(`Unknown platform: ${platform}`);
    console.error('Use: instagram, ig, tiktok, or tt');
    process.exit(1);
  }

  return { platform, scriptPath, passArgs, hasParental };
}

function runScraper(scriptPath, passArgs) {
  return new Promise((resolve) => {
    log(`Starting scraper: node ${path.basename(scriptPath)} ${passArgs.join(' ')}`);

    const child = spawn('node', [scriptPath, ...passArgs], {
      stdio: 'inherit',
      cwd: __dirname,
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        log(`Scraper terminated by signal: ${signal}`);
      } else {
        log(`Scraper exited with code: ${code}`);
      }
      resolve({ code, signal });
    });

    child.on('error', (err) => {
      log(`Scraper error: ${err.message}`);
      resolve({ code: 1, error: err });
    });
  });
}

async function main() {
  const { platform, scriptPath, passArgs, hasParental } = parseArgs();

  console.log(`
${'='.repeat(50)}
  ScraperUltra Resilient Runner
${'='.repeat(50)}
  Platform: ${platform}
  Parental Mode: ${hasParental ? 'ENABLED (1-4 AM EST blackout)' : 'DISABLED'}
  Auto-Restart: ${hasParental ? 'YES' : 'NO'}
${'='.repeat(50)}
`);

  if (!hasParental) {
    // Just run normally without the resilient wrapper
    log('Running in normal mode (no auto-restart)');
    await runScraper(scriptPath, passArgs);
    return;
  }

  // Resilient mode with auto-restart loop
  let restartCount = 0;
  const MAX_RAPID_RESTARTS = 5;
  let lastRestartTime = 0;

  while (true) {
    // Check if we're in blackout window before starting
    if (isInBlackoutWindow()) {
      await sleepUntilBlackoutEnds();
    }

    // Check for rapid restart loop (crash protection)
    const now = Date.now();
    if (now - lastRestartTime < 60000) {
      restartCount++;
      if (restartCount >= MAX_RAPID_RESTARTS) {
        log(`ERROR: ${MAX_RAPID_RESTARTS} rapid restarts detected. Waiting 5 minutes...`);
        await sleep(5 * 60 * 1000);
        restartCount = 0;
      }
    } else {
      restartCount = 0;
    }
    lastRestartTime = now;

    // Run the scraper
    const result = await runScraper(scriptPath, passArgs);

    // Check why it exited
    if (result.signal === 'SIGINT' || result.signal === 'SIGTERM') {
      log('Scraper stopped by user. Exiting resilient runner.');
      break;
    }

    // Check if we're entering blackout window
    if (isInBlackoutWindow()) {
      log('Scraper exited during blackout window (WiFi likely cut off)');
      await sleepUntilBlackoutEnds();
    } else if (isApproachingBlackout()) {
      log('Approaching blackout window. Sleeping until it ends...');
      await sleepUntilBlackoutEnds();
    } else {
      // Crashed outside blackout - wait a bit and restart
      log('Scraper crashed outside blackout. Restarting in 30 seconds...');
      await sleep(30000);
    }

    log('Restarting scraper...\n');
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  log('\nReceived SIGINT. Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('\nReceived SIGTERM. Shutting down...');
  process.exit(0);
});

main().catch(err => {
  console.error('Resilient runner error:', err);
  process.exit(1);
});
