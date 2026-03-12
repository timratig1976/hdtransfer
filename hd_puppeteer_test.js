/**
 * Puppeteer High-Res Basket Download Test
 * Flow: Add all images to basket → Download Files → toggle High Res → Download ZIP → extract
 * Usage:
 *   node hd_puppeteer_test.js <username> <password>
 */

const puppeteer  = require('puppeteer');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const { execSync } = require('child_process');

const BIKE_URL = 'https://h-dmediakit.com/eu/bdp/?ra1250s|2025';
const OUT_DIR  = './hd_highres_test_images';
const HD_USER  = process.argv[2] || '';
const HD_PASS  = process.argv[3] || '';

function downloadFile(fileUrl, dest) {
  return new Promise((resolve, reject) => {
    const mod  = fileUrl.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    let bytes  = 0;
    mod.get(fileUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if ([301,302,303].includes(res.statusCode) && res.headers.location) {
        file.close(); if (fs.existsSync(dest)) fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); if (fs.existsSync(dest)) fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.on('data', c => bytes += c.length);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(bytes)));
    }).on('error', reject);
  });
}

(async () => {
  if (!HD_USER || !HD_PASS) {
    console.log('Usage: node hd_puppeteer_test.js <username> <password>');
    process.exit(1);
  }

  console.log('🚀 HD Mediakit Basket Download Test');
  console.log('   Bike   :', BIKE_URL);
  console.log('   User   :', HD_USER);
  console.log('   Output :', OUT_DIR);
  console.log('');

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page    = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // ── Step 1: Login ────────────────────────────────────────────
  console.log('🔐 Logging in…');
  await page.goto('https://h-dmediakit.com/eu/reg/login.html', { waitUntil: 'networkidle2', timeout: 20000 });
  await page.type('input[name="username"]', HD_USER, { delay: 40 });
  await page.type('input[name="password"]', HD_PASS, { delay: 40 });
  await Promise.all([
    page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
    page.evaluate(() => document.querySelector('#loginLoginForm').submit()),
  ]);
  const afterLogin = page.url();
  if (afterLogin.includes('login')) {
    console.log('❌ Login failed – check username/password'); await browser.close(); process.exit(1);
  }
  console.log('✅ Logged in, at:', afterLogin);

  // ── Step 2: Navigate to bike images page ─────────────────────
  console.log('⬇️  Loading bike page…');
  await page.goto(BIKE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('✅ Bike page loaded');

  // Scroll to Images section
  const scrolled = await page.evaluate(() => {
    const el = [...document.querySelectorAll('a, button, h2, h3')].find(e => /images/i.test(e.textContent));
    if (el) { el.scrollIntoView(); return el.textContent.trim(); }
    return null;
  });
  console.log('   Scrolled to section:', scrolled || '(not found)');

  // ── Step 3: Click "ADD ALL IN THIS SECTION TO BASKET" ────────
  console.log('🛒 Looking for "Add all to basket" button…');
  const addAllSel = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, a, [class*="basket"], [class*="add-all"]')];
    const btn = btns.find(b => /add all/i.test(b.textContent) || /basket/i.test(b.className));
    return btn ? { text: btn.textContent.trim(), cls: btn.className } : null;
  });
  console.log('   Found:', addAllSel ? addAllSel.text : 'NOT FOUND');

  const added = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, a')];
    const btn = btns.find(b => /add all in this section/i.test(b.textContent));
    if (!btn) return false;
    btn.click();
    return btn.textContent.trim();
  });

  if (!added) {
    console.log('⚠️  "Add all" button not found – trying individual add buttons…');
    const addCount = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.add-asset, [class*="add-to-basket"], [epress-feature*="add"]')];
      btns.forEach(b => b.click());
      return btns.length;
    });
    console.log('   Clicked', addCount, 'individual add buttons');
  } else {
    console.log('✅ Clicked:', added);
  }

  await new Promise(r => setTimeout(r, 2000));

  // ── Step 4: Open basket ───────────────────────────────────────
  console.log('📂 Opening basket/files panel…');
  const basketOpened = await page.evaluate(() => {
    // Try basket icon, FILES button, or basket link
    const candidates = [
      ...document.querySelectorAll('[class*="basket"], [class*="files"], [href*="basket"], [href*="files"]'),
      ...document.querySelectorAll('button, a'),
    ];
    const btn = candidates.find(b =>
      /basket|files|saved/i.test(b.textContent) ||
      /basket|minibasket/i.test(b.className)
    );
    if (btn) { btn.click(); return btn.textContent.trim().substring(0, 50); }
    return null;
  });
  console.log('   Basket trigger:', basketOpened || 'not found');
  await new Promise(r => setTimeout(r, 1500));

  // ── Step 5: Click "DOWNLOAD FILES" ───────────────────────────
  console.log('⬇️  Clicking "Download Files"…');
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, a')];
    const btn = btns.find(b => /download files/i.test(b.textContent));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 1500));

  // ── Step 6: Toggle High Res ───────────────────────────────────
  console.log('🔄 Toggling to High Res…');
  const toggled = await page.evaluate(() => {
    // Look for the quality toggle (low res / high res)
    const toggle = document.querySelector(
      'input[type="checkbox"][class*="quality"], input[type="checkbox"][class*="res"], ' +
      '.quality-toggle input, [class*="image-quality"] input, [class*="highres"] input'
    );
    if (toggle && !toggle.checked) { toggle.click(); return 'toggled checkbox'; }
    if (toggle && toggle.checked)  { return 'already high res'; }
    // Fallback: find the "high res" label and click it
    const labels = [...document.querySelectorAll('label, span, button')];
    const highLbl = labels.find(l => /high.?res/i.test(l.textContent));
    if (highLbl) { highLbl.click(); return 'clicked label: ' + highLbl.textContent.trim(); }
    return null;
  });
  console.log('   Toggle result:', toggled || 'not found');
  await new Promise(r => setTimeout(r, 1000));

  // ── Step 7: Intercept ZIP and click "DOWNLOAD SELECTED FILES" ─
  console.log('📦 Clicking "Download Selected Files" and intercepting ZIP…');

  let zipUrl = null;
  page.on('response', async res => {
    const u = res.url();
    if ((u.includes('.zip') || u.includes('download') || u.includes('bundle')) && res.status() === 200) {
      if (!zipUrl) { zipUrl = u; console.log('🎯 Intercepted ZIP/download URL:', u.substring(0, 100)); }
    }
  });
  // Also intercept request URL in case of redirect
  page.on('request', req => {
    const u = req.url();
    if ((u.includes('.zip') || u.includes('bundle')) && !zipUrl) {
      zipUrl = u; console.log('🎯 Intercepted ZIP request:', u.substring(0, 100));
    }
  });

  // Click the button
  const dlBtnText = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, a')];
    const btn = btns.find(b => /download selected/i.test(b.textContent));
    if (btn) { btn.click(); return btn.textContent.trim(); }
    return null;
  });
  console.log('   Clicked:', dlBtnText || 'button not found');

  // Wait for ZIP URL to be intercepted (up to 15s)
  for (let i = 0; i < 30 && !zipUrl; i++) {
    await new Promise(r => setTimeout(r, 500));
  }

  await browser.close();

  if (!zipUrl) {
    console.log('\n❌ No ZIP download URL intercepted.');
    console.log('   → The site may be generating the ZIP asynchronously (polling).');
    console.log('   → Or login may have failed – check credentials.');
    process.exit(1);
  }

  // ── Step 8: Download the ZIP ──────────────────────────────────
  const zipFile = path.join(OUT_DIR, 'highres_images.zip');
  console.log('\n⬇️  Downloading ZIP:', zipFile, '…');
  const bytes = await downloadFile(zipUrl, zipFile);
  const mb    = (bytes / 1024 / 1024).toFixed(1);
  console.log(`✅ ZIP downloaded: ${mb} MB`);

  // ── Step 9: Extract the ZIP ───────────────────────────────────
  console.log('📂 Extracting…');
  execSync(`unzip -o "${zipFile}" -d "${OUT_DIR}"`);
  const extracted = fs.readdirSync(OUT_DIR).filter(f => /\.(jpg|jpeg|png|tif)$/i.test(f));
  console.log(`\n✅ Done! ${extracted.length} images extracted to ${OUT_DIR}/`);
  extracted.slice(0, 5).forEach(f => {
    const size = fs.statSync(path.join(OUT_DIR, f)).size;
    console.log(`   ${f} (${(size/1024/1024).toFixed(1)} MB)`);
  });
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
