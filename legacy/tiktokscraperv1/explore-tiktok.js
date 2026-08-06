const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const userDataDir = path.join(__dirname, 'browser-profile');
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: null,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  const page = context.pages()[0] || await context.newPage();
  
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  
  await page.goto('https://www.tiktok.com/foryou');
  
  console.log('\n========================================');
  console.log('1. Log into TikTok if prompted');
  console.log('2. Dismiss any popups');
  console.log('3. Wait for feed to load');
  console.log('4. Press ENTER here when ready');
  console.log('========================================\n');
  
  await new Promise(resolve => process.stdin.once('data', resolve));
  
  console.log('Dumping page structure...');
  
  const domDump = await page.evaluate(() => {
    function getStructure(el, depth = 0) {
      if (depth > 5 || !el) return '';
      const tag = el.tagName?.toLowerCase() || '';
      const id = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0,3).join('.') : '';
      const attr = el.getAttribute('data-e2e') ? ' [data-e2e=' + el.getAttribute('data-e2e') + ']' : '';
      const indent = '  '.repeat(depth);
      let result = indent + '<' + tag + id + cls + attr + '>\n';
      for (const child of (el.children || [])) result += getStructure(child, depth + 1);
      return result;
    }
    return getStructure(document.body);
  });
  
  fs.writeFileSync('tiktok-dom-dump.txt', domDump);
  console.log('Saved: tiktok-dom-dump.txt');
  
  const userLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href*="/@"]')).slice(0, 10).map(el => ({
      href: el.href,
      text: el.innerText?.slice(0, 50)
    }));
  });
  
  fs.writeFileSync('tiktok-analysis.json', JSON.stringify(userLinks, null, 2));
  console.log('Saved: tiktok-analysis.json');
  
  console.log('\nPress ENTER to close browser...');
  await new Promise(resolve => process.stdin.once('data', resolve));
  await context.close();
})();
