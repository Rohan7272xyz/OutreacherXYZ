const nodemailer = require('nodemailer');

const CONFIG = {
  gmail: process.env.ALERT_GMAIL || 'you@example.com',
  appPassword: process.env.ALERT_APP_PASSWORD || '',
  checkInterval: 60000,
  sheetId: process.env.SHEET_ID || 'YOUR_SHEET_ID',
};

const alertedDevices = new Set();
const overrides = { 'rohan-pc': 'decommissioned' };

async function fetchSheetData() {
  // Fetch emails
  const emailUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/gviz/tq?tqx=out:json&sheet=Sheet1`;
  const emailRes = await fetch(emailUrl);
  const emailText = await emailRes.text();
  const emailJson = JSON.parse(emailText.substring(47, emailText.length - 2));
  
  const emails = emailJson.table.rows.map(row => ({
    device: row.c[3]?.v || 'unknown',
    timestamp: row.c[4]?.v || '',
  })).filter(r => r.device && r.device !== 'found_by');

  // Fetch statuses
  const statuses = {};
  try {
    const statusUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/gviz/tq?tqx=out:json&sheet=Status`;
    const statusRes = await fetch(statusUrl);
    const statusText = await statusRes.text();
    const statusJson = JSON.parse(statusText.substring(47, statusText.length - 2));
    
    statusJson.table.rows.forEach(row => {
      const device = row.c[0]?.v || '';
      const status = row.c[1]?.v || '';
      const cooldownEnd = row.c[2]?.v || null;
      const timestamp = row.c[3]?.v || '';
      
      if (device && device !== 'device') {
        if (!statuses[device] || new Date(timestamp) > new Date(statuses[device].timestamp)) {
          statuses[device] = { status, cooldownEnd, timestamp };
        }
      }
    });
  } catch (e) {}

  return { emails, statuses };
}

function calculateDeviceStatus(emails, statuses) {
  const devices = {};
  const now = new Date();
  emails.forEach(entry => {
    if (!devices[entry.device]) devices[entry.device] = { name: entry.device, lastSeen: null };
    const t = new Date(entry.timestamp);
    if (!devices[entry.device].lastSeen || t > devices[entry.device].lastSeen) devices[entry.device].lastSeen = t;
  });
  return Object.values(devices).map(d => {
    const mins = d.lastSeen ? Math.floor((now - d.lastSeen) / 60000) : Infinity;
    const rep = statuses[d.name];
    const live = rep?.status || null;
    const cdEnd = rep?.cooldownEnd ? new Date(rep.cooldownEnd) : null;
    const cdRem = cdEnd ? Math.max(0, Math.floor((cdEnd - now) / 60000)) : 0;
    let status;
    if (live === 'stuck-loop') status = 'stuck-loop';
    else if (live === 'cooldown' && cdRem > 0) status = 'cooldown';
    else if (live === 'break') status = 'break';
    else if (live === 'blackout') status = 'blackout';
    else if (mins < 15) status = 'active';
    else if (mins < 60) status = 'warning';
    else status = 'down';
    return { ...d, status, minutesSinceLastSeen: mins };
  });
}

async function sendAlert(subject, body) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: CONFIG.gmail, pass: CONFIG.appPassword },
  });
  try {
    await transporter.sendMail({ from: `Scraper Alerts <${CONFIG.gmail}>`, to: CONFIG.gmail, subject, html: body });
    console.log(`[${new Date().toISOString()}] Alert: ${subject}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed:`, err.message);
  }
}

async function checkAndAlert() {
  try {
    const { emails, statuses } = await fetchSheetData();
    const devices = calculateDeviceStatus(emails, statuses);
    for (const d of devices) {
      if (overrides[d.name]) continue;
      const needsAlert = d.status === 'down' || d.status === 'stuck-loop';
      const key = `${d.name}-${d.status}`;
      if (needsAlert && !alertedDevices.has(key)) {
        const subj = d.status === 'stuck-loop' ? `[URGENT] STUCK LOOP: ${d.name}` : `[URGENT] SERVER DOWN: ${d.name}`;
        const body = `<div style="font-family:Arial;padding:20px;"><h2 style="color:${d.status === 'stuck-loop' ? '#be123c' : '#dc2626'}">${d.status === 'stuck-loop' ? 'STUCK LOOP' : 'SERVER DOWN'}</h2><p><b>Device:</b> ${d.name}</p><p><b>Last seen:</b> ${d.minutesSinceLastSeen}m ago</p><p><a href="https://cloutx.org">Dashboard</a></p></div>`;
        await sendAlert(subj, body);
        alertedDevices.add(key);
      }
      if (!needsAlert) {
        const dk = `${d.name}-down`, sk = `${d.name}-stuck-loop`;
        if (alertedDevices.has(dk) || alertedDevices.has(sk)) {
          await sendAlert(`[RESOLVED] ${d.name} back online`, `<div style="font-family:Arial;padding:20px;"><h2 style="color:#10b981">RECOVERED</h2><p>${d.name} is back online</p></div>`);
          alertedDevices.delete(dk);
          alertedDevices.delete(sk);
        }
      }
    }
    console.log(`[${new Date().toISOString()}] ${devices.filter(d => d.status === 'active').length}/${devices.length} active`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error:`, err.message);
  }
}

console.log('Alert service started');
checkAndAlert();
setInterval(checkAndAlert, CONFIG.checkInterval);
