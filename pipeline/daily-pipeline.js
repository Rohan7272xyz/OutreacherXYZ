const { execSync } = require('child_process');
const path = require('path');
const PIPELINE_DIR = __dirname;

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

function runStep(name, script) {
  log('Starting: ' + name);
  try {
    execSync('node ' + path.join(PIPELINE_DIR, script), {
      stdio: 'inherit',
      cwd: PIPELINE_DIR
    });
    log('Completed: ' + name + '\n');
    return true;
  } catch (err) {
    log('FAILED: ' + name + ' - ' + err.message);
    return false;
  }
}

async function main() {
  log('========== DAILY PIPELINE START ==========\n');
  log('Processing both companies: CoinFluence + CreatorPredict\n');

  // Step 1: Import sent emails from Gmail to Sent tabs
  if (runStep('Import Gmail Sent History (Both Companies)', 'import-sent.js') === false) {
    log('Pipeline aborted at Step 1');
    process.exit(1);
  }

  // Step 2: Filter leads (remove duplicates, already-sent)
  if (runStep('Filter Leads (Both Companies)', 'filter.js') === false) {
    log('Pipeline aborted at Step 2');
    process.exit(1);
  }

  // Step 3: Send emails to all new leads
  if (runStep('Send Emails (Both Companies)', 'send.js') === false) {
    log('Pipeline aborted at Step 3');
    process.exit(1);
  }

  // Step 4: Clear lead tabs for fresh scraping
  if (runStep('Clear Lead Tabs', 'clear.js') === false) {
    log('Pipeline aborted at Step 4');
    process.exit(1);
  }

  log('========== DAILY PIPELINE COMPLETE ==========');
}

main().catch(function(err) {
  log('Pipeline error: ' + err.message);
  process.exit(1);
});
