const { chromium } = require('playwright');
const fs = require('fs');

async function debug() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    isMobile: true,
    hasTouch: true,
  });

  const page = await context.newPage();
  
  // Load cookies
  if (fs.existsSync('./session.json')) {
    await context.addCookies(JSON.parse(fs.readFileSync('./session.json')));
    console.log('Session loaded');
  }

  console.log('Going to reels...');
  await page.goto('https://www.instagram.com/reels/', { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 3000));

  // Click video
  await page.evaluate(() => document.querySelector('video')?.click());
  await new Promise(r => setTimeout(r, 2000));

  // Dump ALL links
  const links = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('a[href^="/"]').forEach(link => {
      const href = link.getAttribute('href') || '';
      const rect = link.getBoundingClientRect();
      const inNav = !!link.closest('nav');
      
      results.push({
        href,
        text: link.innerText.trim().substring(0, 30),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        inNav,
        visible: rect.width > 0 && rect.height > 0
      });
    });
    return results;
  });

  console.log('\n========== ALL LINKS ON SCREEN ==========\n');
  console.log('TOP\tLEFT\tSIZE\t\tINNAV\tHREF\t\t\t\tTEXT');
  console.log('-'.repeat(100));
  
  links
    .filter(l => l.visible)
    .sort((a, b) => a.top - b.top)
    .forEach(l => {
      console.log(`${l.top}\t${l.left}\t${l.width}x${l.height}\t\t${l.inNav}\t${l.href.padEnd(25)}\t${l.text}`);
    });

  console.log('\n=========================================\n');
  
  // Keep browser open
  console.log('Browser staying open - check the screen and compare with links above');
  console.log('Press Ctrl+C to exit');
  
  await new Promise(() => {}); // Keep alive
}

debug().catch(console.error);
