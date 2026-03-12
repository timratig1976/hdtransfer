/**
 * ============================================================
 * HD → HubSpot — Unified Server
 * ============================================================
 * Usage:
 *   node hd_server.js
 *   → http://localhost:3737
 * ============================================================
 */

const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const url        = require('url');
const puppeteer  = require('puppeteer');
const sharp      = require('sharp');

// ── Load .env file if present (no dotenv dependency) ──────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) return;
    const eq = clean.indexOf('=');
    if (eq < 1) return;
    const key = clean.slice(0, eq).trim();
    const val = clean.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  });
  console.log('✓ .env loaded');
}

// ── Global crash guards (prevent server death on unhandled errors) ──
process.on('uncaughtException', err => {
  console.error('\n[CRASH PREVENTED] uncaughtException:', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('\n[CRASH PREVENTED] unhandledRejection:', reason?.stack || reason);
});

const PORT       = 3737;
const HTML_FILE  = path.join(__dirname, 'hd_app.html');
const BASE_URL   = 'https://h-dmediakit.com';
const STATE_FILE = path.join(__dirname, 'hd_state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch(e) { console.error('loadState error:', e.message); }
  return { bikes: [], crawled: {}, imported: {} };
}
function saveState(patch) {
  const current = loadState();
  const next    = { ...current, ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── SSE ───────────────────────────────────────────────────────
const sseClients = [];

function sendSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch(e) {} });
}

function log(msg, level = 'info', source = 'system') {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}][${source}] ${msg}`);
  sendSSE({ type: 'log', level, msg, ts, source });
}
function logOk(msg, src)   { log('✅ ' + msg, 'ok',    src); }
function logErr(msg, src)  { log('❌ ' + msg, 'error', src); }
function logWarn(msg, src) { log('⚠️  ' + msg, 'warn',  src); }

// ── Shared Utilities ──────────────────────────────────────────

function sanitize(str) {
  return str.replace(/[^a-z0-9_-]/gi, '_').replace(/__+/g, '_').toLowerCase();
}
function cleanText(str) {
  return (str||'').replace(/\s+/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#160;/g,' ').replace(/&nbsp;/g,' ').trim();
}
function stripTags(html) {
  return cleanText(html.replace(/<[^>]+>/g,' '));
}

function sanitizeSlug(str) {
  return str.toLowerCase()
    .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}

// ── Video Analysis ─────────────────────────────────────────────

async function fetchImageAsBase64(imageUrl) {
  return new Promise((resolve, reject) => {
    const mod = imageUrl.startsWith('https') ? https : http;
    const chunks = [];
    const req = mod.get(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if ([301,302,303].includes(res.statusCode) && res.headers.location) {
        return fetchImageAsBase64(res.headers.location).then(resolve).catch(reject);
      }
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Image fetch timeout')); });
  });
}

async function extractVideoFrames(mp4Url, thumbUrl) {
  const frames = [];
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:#000">
      <video id="v" src="${mp4Url}" preload="metadata" style="width:1280px;height:720px;object-fit:contain"></video>
    </body></html>`);
    await page.waitForFunction(() => {
      const v = document.getElementById('v');
      return v && v.readyState >= 1 && isFinite(v.duration) && v.duration > 0;
    }, { timeout: 20000 });
    const duration = await page.evaluate(() => document.getElementById('v').duration);
    log(`Video duration: ${duration.toFixed(1)}s, extracting frames…`, 'info', 'analyzer');
    for (const pct of [0.1, 0.3, 0.5, 0.75]) {
      const t = pct * duration;
      await page.evaluate(t => { document.getElementById('v').currentTime = t; }, t);
      await page.waitForFunction(() => !document.getElementById('v').seeking, { timeout: 8000 }).catch(() => {});
      await sleep(400);
      const shot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 80 });
      frames.push(shot);
    }
    await browser.close();
    log(`Extracted ${frames.length} frames from video`, 'ok', 'analyzer');
  } catch(e) {
    if (browser) await browser.close().catch(() => {});
    logWarn(`Frame extraction failed (${e.message}), using thumbnail`, 'analyzer');
    if (thumbUrl) {
      try {
        const b64 = await fetchImageAsBase64(thumbUrl);
        if (b64) frames.push(b64);
      } catch(e2) { logErr(`Thumbnail fetch failed: ${e2.message}`, 'analyzer'); }
    }
  }
  return frames;
}

function analyzeFramesWithOpenAI(frames, apiKey, bikeName, videoFilename) {
  return new Promise((resolve, reject) => {
    if (!frames.length) { reject(new Error('No frames to analyze')); return; }
    const imageContent = frames.map(f => ({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${f}`, detail: 'low' }
    }));
    const body = JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `These are ${frames.length} frame(s) from a Harley Davidson marketing video for the "${bikeName}" (file: ${videoFilename}).

Classify this video into EXACTLY ONE of these two types:
- "detail_view": close-up detail shots of the bike, studio or controlled setting, slow/static camera, focuses on specific parts (engine, wheels, design elements), no or minimal riding, often white/dark background
- "riding_outdoor": bike shown in real-world outdoor context, someone riding it, landscape/road visible, lifestyle/action scenes, B-roll footage, drone shots, dynamic movement

Return ONLY valid JSON (no markdown, no code block), exactly this shape:
{
  "type": "detail_view" | "riding_outdoor",
  "confidence": "high" | "medium" | "low",
  "description": "2-3 sentence description of what is shown",
  "setting": "brief setting description (e.g. mountain road, studio, city street)",
  "riderPresent": true | false
}`
          },
          ...imageContent
        ]
      }]
    });
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) { reject(new Error(json.error.message)); return; }
          const raw = json.choices[0].message.content.trim();
          try {
            const parsed = JSON.parse(raw);
            resolve(parsed);
          } catch {
            // fallback: try to extract JSON from response
            const m = raw.match(/\{[\s\S]+\}/);
            if (m) { resolve(JSON.parse(m[0])); return; }
            // last resort: wrap as plain description
            resolve({ type: 'unknown', confidence: 'low', description: raw, setting: '', riderPresent: false });
          }
        } catch(e) { reject(new Error('OpenAI response parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(45000, () => { req.destroy(); reject(new Error('OpenAI API timeout')); });
    req.write(body);
    req.end();
  });
}

// Keywords that suggest a good hero / lifestyle image by filename
const HERO_KEYWORDS = /groupriding|group.?rid|lifestyle|action|outdoor|riding|dynamic|scenic|hero|broll|b-roll|flyaround|fly.around|social|adventure|journey/i;

async function analyzeImagesForBike(outputDir, folder, openaiKey) {
  const bikeDir  = path.join(outputDir, 'bikes', folder);
  const imgDir   = path.join(bikeDir, 'images');
  const dataPath = path.join(bikeDir, 'data.json');
  if (!fs.existsSync(imgDir)) throw new Error('images folder not found');
  const imgFiles = fs.readdirSync(imgDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
  if (!imgFiles.length) throw new Error('No images found');

  // ── Pre-filter: keyword-matching hero candidates ──────────────
  const priorityFiles = imgFiles.filter(f => HERO_KEYWORDS.test(path.basename(f, path.extname(f))));
  const hasPriority   = priorityFiles.length > 0;
  if (hasPriority) log(`Hero pre-filter: ${priorityFiles.length} keyword match(es) → ${priorityFiles.join(', ')}`, 'info', 'analyzer');
  else             log(`No keyword matches — will classify all ${imgFiles.length} images`, 'info', 'analyzer');

  // Cap: always include priority files, sample the rest up to MAX total
  const MAX_IMAGES_PER_CALL = 18;
  const otherFiles     = imgFiles.filter(f => !HERO_KEYWORDS.test(path.basename(f, path.extname(f))));
  const remainingSlots = Math.max(0, MAX_IMAGES_PER_CALL - priorityFiles.length);
  const sampledOthers  = otherFiles.length <= remainingSlots
    ? otherFiles
    : otherFiles.filter((_, i) => i % Math.ceil(otherFiles.length / remainingSlots) === 0).slice(0, remainingSlots);
  const filesToAnalyze = [...priorityFiles, ...sampledOthers];
  if (imgFiles.length > MAX_IMAGES_PER_CALL)
    log(`Capping: ${imgFiles.length} images → ${filesToAnalyze.length} sent (${priorityFiles.length} priority + ${sampledOthers.length} sampled)`, 'info', 'analyzer');

  log(`Reading ${filesToAnalyze.length} images for analysis (resizing to 512px)…`, 'info', 'analyzer');
  const imageContent = [];
  const validFiles   = [];
  for (const f of filesToAnalyze) {
    try {
      const srcPath = path.join(imgDir, f);
      // Resize to max 512px for GPT-4o detail:low — dramatically reduces payload
      const resizedBuf = await sharp(srcPath)
        .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      const b64 = resizedBuf.toString('base64');
      imageContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' } });
      validFiles.push(f);
    } catch(e) { logWarn(`Skipping ${f}: ${e.message}`, 'analyzer'); }
  }
  if (!validFiles.length) throw new Error('No readable images');

  // Build priority-candidate hint for prompt
  const priorityIndices = validFiles
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => HERO_KEYWORDS.test(path.basename(f, path.extname(f))))
    .map(({ i }) => i);

  const priorityHint = priorityIndices.length > 0
    ? `\n\nPRIORITY HERO CANDIDATES (by filename): indices ${priorityIndices.join(', ')} — [${priorityIndices.map(i => validFiles[i]).join(', ')}]\nWhen choosing "heroCandidate", PREFER these indices if any of them show the full bike outdoors with a rider or great scenery. Only mark a non-priority image as heroCandidate if none of the priority candidates qualify.`
    : '';

  const prompt = `These are ${validFiles.length} product images for a Harley-Davidson motorcycle, numbered in order.

Classify EACH image and return a JSON array (one object per image, same order):
{
  "index": 0,
  "type": "outdoor_rider" | "outdoor_static" | "studio_detail" | "feature_closeup" | "color_variant" | "lifestyle",
  "riderPresent": true | false,
  "outdoorSetting": true | false,
  "bikeVisibility": "full" | "partial" | "minimal",
  "heroCandidate": true | false,
  "description": "one short sentence"
}

"heroCandidate" = true for the SINGLE best image showing the full bike outdoors with a rider or great scenery — ideal for a website hero.${priorityHint}

Return ONLY a valid JSON array, no markdown.

Image filenames in order: ${validFiles.map((f, i) => `[${i}] ${f}`).join(', ')}`;

  const body = JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 1400,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...imageContent] }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}`, 'Content-Length': Buffer.byteLength(body) }
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) { reject(new Error(json.error.message)); return; }
          const raw = json.choices[0].message.content.trim();
          let results;
          try { results = JSON.parse(raw); }
          catch { const m = raw.match(/\[[\s\S]+\]/); if (m) results = JSON.parse(m[0]); else throw new Error('Could not parse response'); }

          // Merge results back into data.json
          const bikeData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
          results.forEach(r => {
            const fname = validFiles[r.index];
            if (!fname) return;
            const img = (bikeData.images || []).find(i => (i.localFile || i.filename) === fname);
            if (img) img.analysis = { type: r.type, riderPresent: r.riderPresent, outdoorSetting: r.outdoorSetting, bikeVisibility: r.bikeVisibility, heroCandidate: r.heroCandidate, description: r.description, priorityCandidate: priorityIndices.includes(r.index), analyzedAt: new Date().toISOString() };
          });

          // Hero selection: priority candidates first, then any heroCandidate
          let heroIdx = -1;
          if (priorityIndices.length > 0) {
            heroIdx = results.findIndex(r => r.heroCandidate && priorityIndices.includes(r.index));
          }
          if (heroIdx < 0) heroIdx = results.findIndex(r => r.heroCandidate);
          if (heroIdx >= 0) {
            bikeData.recommendedHero = validFiles[heroIdx];
            const src = priorityIndices.includes(heroIdx) ? 'keyword-priority' : 'AI-fallback';
            log(`Hero selected: [${heroIdx}] ${validFiles[heroIdx]} (${src})`, 'ok', 'analyzer');
          }
          fs.writeFileSync(dataPath, JSON.stringify(bikeData, null, 2));
          resolve({ results, validFiles, recommendedHero: heroIdx >= 0 ? validFiles[heroIdx] : null, priorityIndices });
        } catch(e) { reject(new Error('Image analysis parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('OpenAI timeout')); });
    req.write(body);
    req.end();
  });
}

function formatSpecsTextEN(sections, flatSpecs) {
  if (sections && sections.length) {
    return sections.map(s => {
      const title = (s.section || s.title || '').trim();
      const rows  = (s.rows || []).map(r => `${r.name}: ${r.value}`).join('\n');
      return title ? `<h3>${title}</h3>\n${rows}` : rows;
    }).filter(Boolean).join('\n\n');
  }
  if (flatSpecs && Object.keys(flatSpecs).length) {
    return Object.entries(flatSpecs).map(([k,v]) => `${k}: ${v}`).join('\n');
  }
  return '';
}

function formatSpecsTextDE(sectionsDE, flatSpecsDE) {
  if (sectionsDE && sectionsDE.length) {
    return sectionsDE.map(s => {
      const title = (s.title || s.section || '').trim();
      const rows  = Object.entries(s.specs || {}).map(([k,v]) => `${k}: ${v}`).join('\n');
      return title ? `<h3>${title}</h3>\n${rows}` : rows;
    }).filter(Boolean).join('\n\n');
  }
  if (flatSpecsDE && Object.keys(flatSpecsDE).length) {
    return Object.entries(flatSpecsDE).map(([k,v]) => `${k}: ${v}`).join('\n');
  }
  return '';
}

async function translateToDE(text, openaiKey, context) {
  if (!text || !openaiKey) return '';
  const prompt = `Translate the following ${context||'text'} from English to German.
Keep all HTML tags (e.g. <h3>) exactly as they are. Only translate the visible text content (section titles and specification key names).
Keep all numeric values, measurements, model names, and units unchanged.
Do not add any explanation, just return the translated text.

Text to translate:
${text}`;

  const body = JSON.stringify({ model: 'gpt-4o', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}`, 'Content-Length': Buffer.byteLength(body) }
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) { reject(new Error(json.error.message)); return; }
          resolve(json.choices[0].message.content.trim());
        } catch(e) { reject(new Error('translate parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(45000, () => { req.destroy(); reject(new Error('translate timeout')); });
    req.write(body);
    req.end();
  });
}

function guessVideoType(filename, sizeMB) {
  const f = (filename || '').toLowerCase();
  // Strong detail indicators: PDP (Product Detail Page), DES/INN/PER suffix
  if (/pdp|_des_|_inn_|_per_|detail|studio|feature/.test(f)) return 'detail_view';
  // Strong riding indicators: broll, b-roll, flyaround, lifestyle, riding
  if (/broll|b-roll|flyaround|fly-around|lifestyle|riding|outdoor/.test(f)) return 'riding_outdoor';
  // Size heuristic: detail videos are typically small (< 50MB), riding B-roll is large (> 80MB)
  if (sizeMB && sizeMB < 50)  return 'detail_view';
  if (sizeMB && sizeMB > 80)  return 'riding_outdoor';
  return null; // unknown
}

async function classifyVideoWithAI(thumbUrl, filename, openaiKey) {
  // Fetch thumbnail as base64
  let b64 = '';
  if (thumbUrl) {
    try {
      b64 = await new Promise((resolve, reject) => {
        const mod = thumbUrl.startsWith('https') ? https : http;
        mod.get(thumbUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            classifyVideoWithAI(res.headers.location, filename, openaiKey).then(resolve).catch(reject);
            return;
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
        }).on('error', reject);
      });
    } catch(e) { logWarn(`classifyVideoWithAI: thumb fetch failed (${e.message})`, 'importer'); }
  }

  const prompt = `This is a thumbnail image from a Harley-Davidson motorcycle video named "${filename}".
Classify the video as ONE of:
- "detail_view"   → studio or controlled environment, close-up product shots, no outdoor setting, typically a short loop showing the bike's features/design
- "riding_outdoor" → bike being ridden outdoors, B-roll, lifestyle footage, scenery/landscape visible, rider in action

Respond ONLY with valid JSON:
{"type":"detail_view"|"riding_outdoor","confidence":"high"|"medium"|"low","description":"one sentence"}`;

  const messages = [{ role: 'user', content: b64
    ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' } }]
    : [{ type: 'text', text: prompt + `\n(No thumbnail available — classify from filename only.)` }]
  }];

  const body = JSON.stringify({ model: 'gpt-4o', max_tokens: 80, messages });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}`, 'Content-Length': Buffer.byteLength(body) }
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) { reject(new Error(json.error.message)); return; }
          const raw = json.choices[0].message.content.trim();
          try {
            resolve(JSON.parse(raw));
          } catch {
            const m = raw.match(/\{[\s\S]+?\}/);
            if (m) resolve(JSON.parse(m[0]));
            else resolve({ type: 'detail_view', confidence: 'low', description: raw });
          }
        } catch(e) { reject(new Error('parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function fetchHTML(targetUrl) {
  return new Promise((resolve, reject) => {
    const mod = targetUrl.startsWith('https') ? https : http;
    const req = mod.get(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    }, res => {
      if ([301,302,303].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : BASE_URL + res.headers.location;
        return fetchHTML(loc).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// PRIMARY: Fetch high-res download URLs via public dynamicassets API (no login required)
async function getHighResUrlsViaDynamicAssets(epaItemIds) {
  if (!epaItemIds || !epaItemIds.length) return {};
  const ids  = epaItemIds.join(',');
  const url  = `${BASE_URL}/epressassetsaapi/dynamicassets/${ids}`;
  const json = await fetchHTML(url);
  const data = JSON.parse(json);
  const result = {};
  for (const [id, item] of Object.entries(data)) {
    if (item.epa_item_download) result[id] = item.epa_item_download;
  }
  return result; // { epaItemId: highResS3Url, ... }
}

// FALLBACK: Use Puppeteer to fetch all high-res download URLs for a bike page in one browser session
async function getHighResUrlsViaPuppeteer(bikeUrl, sessionCookie) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();

    // Set session cookie if provided
    if (sessionCookie) {
      await page.setCookie({ name: 'PHPSESSID', value: sessionCookie, domain: 'h-dmediakit.com', path: '/' });
    }

    // Navigate and wait for JS to settle
    await page.goto(bikeUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Get all epa-item-ids from the DOM
    const itemIds = await page.evaluate(() =>
      [...document.querySelectorAll('[data-epa-item-id]')]
        .map(el => el.getAttribute('data-epa-item-id'))
        .filter(Boolean)
    );

    if (!itemIds.length) { await browser.close(); return {}; }

    // Fetch all asset URLs via browser's built-in fetch (sends cookies automatically)
    const assetUrls = await page.evaluate(async (ids) => {
      const results = {};
      for (const id of ids) {
        try {
          const res  = await fetch(`/epapi-get/asset/${id}`, { credentials: 'include' });
          const data = await res.json();
          const dl   = data.epa_item_download || data.download_url || data.file_url || data.url || null;
          if (dl) results[id] = dl.startsWith('http') ? dl : 'https://h-dmediakit.com' + dl;
        } catch(e) { /* skip on error */ }
      }
      return results;
    }, itemIds);

    await browser.close();
    return assetUrls; // { epaItemId: downloadUrl, ... }
  } catch(e) {
    await browser.close();
    throw e;
  }
}

function downloadFile(fileUrl, dest, minSize = 1000) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest) && fs.statSync(dest).size >= minSize) {
      resolve({ status: 'exists', size: fs.statSync(dest).size });
      return;
    }
    const tmp  = dest + '.tmp';
    const mod  = fileUrl.startsWith('https') ? https : http;
    const file = fs.createWriteStream(tmp);
    let totalBytes = 0;
    const req = mod.get(fileUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if ([301,302,303].includes(res.statusCode) && res.headers.location) {
        file.close();
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        const loc = res.headers.location.startsWith('http') ? res.headers.location : BASE_URL + res.headers.location;
        return downloadFile(loc, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.on('data', chunk => { totalBytes += chunk.length; });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(tmp, dest);
          resolve({ status: 'downloaded', size: totalBytes });
        });
      });
    });
    req.on('error', e => {
      file.close();
      if (fs.existsSync(tmp)) try { fs.unlinkSync(tmp); } catch {}
      reject(e);
    });
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

// ── Scraper: Parsing ──────────────────────────────────────────

function extractDescription(html) {
  const m = html.match(/class="brief-copy"[^>]*>([\s\S]*?)<\/div>/);
  return m ? stripTags(m[1]) : '';
}

function extractImages(html) {
  const results = [];
  // Match thumbnail items: grab both the epa-item-id and the preview src from the same block
  const itemRe = /data-epa-item-id="(\d+)"[\s\S]{0,600}?src="(https:\/\/s3-eu-west-2\.amazonaws\.com\/[^"]+\/images\/preview\/[^"]+\.jpg)"/g;
  let m;
  const seen = new Set();
  while ((m = itemRe.exec(html)) !== null) {
    const epaItemId = m[1], previewUrl = m[2];
    if (!seen.has(previewUrl)) {
      seen.add(previewUrl);
      results.push({ previewUrl, epaItemId, caption: '' });
    }
  }
  // Fallback: preview URLs without epa-item-id
  const re = /src="(https:\/\/s3-eu-west-2\.amazonaws\.com\/[^"]+\/images\/preview\/[^"]+\.jpg)"/g;
  while ((m = re.exec(html)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); results.push({ previewUrl: m[1], epaItemId: null, caption: '' }); }
  }
  const capRe = /<p class="caption">([^<]+)<\/p>/g;
  let ci = 0;
  while ((m = capRe.exec(html)) !== null && ci < results.length) {
    results[ci].caption = cleanText(m[1]); ci++;
  }
  return results;
}

function extractVideos(html) {
  const results = [];
  const re = /src="(https:\/\/s3-eu-west-2\.amazonaws\.com\/[^"]+\/video\/preview\/([^"\/]+)\.jpg)"/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    const thumbUrl = m[1], filename = m[2];
    if (!seen.has(thumbUrl)) {
      seen.add(thumbUrl);
      const mp4Url = thumbUrl.replace('/video/preview/', '/video/').replace(/\.jpg$/, '.mp4');
      results.push({ thumbUrl, mp4Url, filename: filename + '.mp4', caption: '' });
    }
  }
  return results;
}

function extractSpecs(html) {
  const sections = [];
  const flat = {};

  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/g;
  let tableMatch;
  while ((tableMatch = tableRe.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    let sectionName = null;
    const rows = [];

    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let rowMatch;
    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];

      // Check for <th> header row -> extract section name
      const thCells = [];
      const thRe = /<th[^>]*>([\s\S]*?)<\/th>/g;
      let thM;
      while ((thM = thRe.exec(rowHtml)) !== null) thCells.push(stripTags(thM[1]).trim());
      if (thCells.length > 0) {
        // First <th> is the section heading (e.g. "Dimensions", "Chassis")
        // Second <th> is bike name, third is "Notes" — both ignored
        if (!sectionName && thCells[0]) sectionName = thCells[0];
        continue;
      }

      // Data row — only <td> cells
      const cells = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
      let tdM;
      while ((tdM = tdRe.exec(rowHtml)) !== null) cells.push(stripTags(tdM[1]).trim());
      if (cells.length < 2) continue;

      const name  = cells[0];
      const value = cells[1];
      // Skip footnote rows (key is purely numeric) and rows with empty value
      if (!name || /^\d+$/.test(name) || !value) continue;

      rows.push({ name, value });
      flat[name] = value;
    }

    if (rows.length > 0) {
      sections.push({ section: sectionName || '', rows });
    }
  }

  return { sections, flat };
}

function extractSpecsPdfUrl(html) {
  const m = html.match(/href="(\/epapi-get\/pdf\/bikepages\/specs\/[^"]+\.pdf)"/);
  return m ? BASE_URL + m[1] : '';
}

// ── Scraper: Logic ────────────────────────────────────────────

async function scrapeBike(config, bike) {
  const { outputDir, sessionCookie, forceRedownload } = config;
  const { year, category, name, code } = bike;

  const bikeUrl  = `${BASE_URL}/eu/bdp/?${code}|${year}`;
  const slug     = `${year}_${sanitize(name)}_${code}`;
  const bikeDir  = path.join(outputDir, 'bikes', slug);
  const imgDir   = path.join(bikeDir, 'images');
  const vidDir   = path.join(bikeDir, 'videos');
  const docsDir  = path.join(bikeDir, 'docs');
  const logsDir  = path.join(outputDir, 'logs');

  sendSSE({ type: 'scraper_bike_start', bike: { name, year, code } });
  log(`━━ SCRAPING: ${name} ${year}`, 'section', 'scraper');

  fs.mkdirSync(imgDir,  { recursive: true });
  fs.mkdirSync(vidDir,  { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  if (forceRedownload) {
    const del = (dir, exts) => { if (!fs.existsSync(dir)) return 0; const files = fs.readdirSync(dir).filter(f => exts.test(f)); files.forEach(f => fs.unlinkSync(path.join(dir, f))); return files.length; };
    const di = del(imgDir, /\.(jpg|jpeg|png|tif)$/i);
    const dv = del(vidDir, /\.(mp4|mov|avi)$/i);
    if (di || dv) log(`Force: ${di} Bilder + ${dv} Videos gelöscht`, 'warn', 'scraper');
  }

  const result = { bike: { name, year, code, category }, status: 'pending', folder: slug };

  log(`Fetching ${bikeUrl}...`, 'info', 'scraper');
  sendSSE({ type: 'scraper_progress', step: 'fetch', total: 1, done: 0 });
  let html;
  try {
    html = await fetchHTML(bikeUrl);
    logOk(`Page loaded (${Math.round(html.length/1024)} KB)`, 'scraper');
  } catch(e) {
    logErr(`Failed to fetch: ${e.message}`, 'scraper');
    sendSSE({ type: 'scraper_bike_done', bike: { name, year, code }, status: 'error', error: e.message });
    return { ...result, status: 'error', error: e.message };
  }
  sendSSE({ type: 'scraper_progress', step: 'fetch', total: 1, done: 1 });

  const description = extractDescription(html);
  const specsResult = extractSpecs(html);
  const specs       = specsResult.flat;
  const specsSections = specsResult.sections;
  const images      = extractImages(html);
  const videos      = extractVideos(html);
  const specsPdf    = extractSpecsPdfUrl(html);

  log(`Found: ${images.length} images, ${videos.length} videos, ${Object.keys(specs).length} specs in ${specsSections.length} sections`, 'info', 'scraper');

  // Fetch high-res URLs — try dynamicassets API first, fall back to Puppeteer
  let highResMap = {};
  const epaIds = images.map(img => img.epaItemId).filter(Boolean);
  if (epaIds.length) {
    log(`dynamicassets: Lade High-Res URLs für ${epaIds.length} Bilder…`, 'info', 'scraper');
    try {
      highResMap = await getHighResUrlsViaDynamicAssets(epaIds);
      const found = Object.keys(highResMap).length;
      if (found > 0) {
        logOk(`dynamicassets: ${found} High-Res URLs gefunden`, 'scraper');
      } else {
        throw new Error('keine URLs zurückgegeben');
      }
    } catch(e) {
      logWarn(`dynamicassets fehlgeschlagen (${e.message}) → versuche Puppeteer…`, 'scraper');
      try {
        highResMap = await getHighResUrlsViaPuppeteer(bikeUrl, sessionCookie || '');
        const found = Object.keys(highResMap).length;
        if (found > 0) {
          logOk(`Puppeteer: ${found} High-Res URLs gefunden`, 'scraper');
        } else {
          logWarn('Puppeteer: Keine High-Res URLs → nutze Previews', 'scraper');
        }
      } catch(e2) {
        logWarn(`Puppeteer fehlgeschlagen (${e2.message}) → nutze Previews`, 'scraper');
      }
    }
  }

  // Images
  sendSSE({ type: 'scraper_progress', step: 'images', total: images.length, done: 0 });
  const imageResults = [];
  for (let i = 0; i < images.length; i++) {
    const img        = images[i];
    const filename   = path.basename(img.previewUrl.split('?')[0]);
    const dest       = path.join(imgDir, filename);
    const highResUrl = img.epaItemId ? highResMap[img.epaItemId] : null;
    try {
      const downloadUrl = highResUrl || img.previewUrl;
      const r  = await downloadFile(downloadUrl, dest);
      const kb = Math.round((r.size||0)/1024);
      log(`[${i+1}/${images.length}] ${filename} (${kb} KB)${highResUrl ? ' [High-Res]' : ' [Preview]'}`, 'ok', 'scraper');
      imageResults.push({ ...img, localFile: filename, status: r.status, highRes: !!highResUrl });
    } catch(e) {
      logErr(`${filename}: ${e.message}`, 'scraper');
      imageResults.push({ ...img, localFile: '', status: 'error: '+e.message });
    }
    sendSSE({ type: 'scraper_progress', step: 'images', total: images.length, done: i + 1 });
    await sleep(150);
  }

  // Videos
  sendSSE({ type: 'scraper_progress', step: 'videos', total: videos.length, done: 0 });
  const videoResults = [];
  for (let i = 0; i < videos.length; i++) {
    const vid  = videos[i];
    const dest = path.join(vidDir, vid.filename);
    log(`Downloading ${vid.filename}...`, 'info', 'scraper');
    try {
      const r = await downloadFile(vid.mp4Url, dest);
      const mb = Math.round((r.size||0)/1024/1024);
      logOk(`${vid.filename} (${mb} MB)`, 'scraper');
      videoResults.push({ ...vid, localFile: vid.filename, status: r.status, sizeMB: mb });
    } catch(e) {
      logErr(`${vid.filename}: ${e.message}`, 'scraper');
      videoResults.push({ ...vid, localFile: '', status: 'error: '+e.message });
    }
    sendSSE({ type: 'scraper_progress', step: 'videos', total: videos.length, done: i + 1 });
    await sleep(150);
  }

  // PDF
  sendSSE({ type: 'scraper_progress', step: 'pdf', total: 1, done: 0 });
  let pdfLocal = '';
  if (specsPdf) {
    const pdfDest = path.join(docsDir, `specs_${code}_${year}_eu.pdf`);
    try {
      const r = await downloadFile(specsPdf, pdfDest);
      pdfLocal = path.basename(pdfDest);
      logOk(`PDF: ${pdfLocal} (${Math.round((r.size||0)/1024)} KB)`, 'scraper');
    } catch(e) {
      logWarn(`PDF failed: ${e.message}`, 'scraper');
    }
  } else {
    logWarn('No PDF found', 'scraper');
  }
  sendSSE({ type: 'scraper_progress', step: 'pdf', total: 1, done: 1 });

  // ── Translation ───────────────────────────────────────────────
  let beschreibung = '';
  let abmessungenDE = '';
  const openaiApiKey = config.openaiApiKey || process.env.OPENAI_API_KEY || '';
  if (openaiApiKey) {
    sendSSE({ type: 'scraper_progress', step: 'translate', total: 2, done: 0 });

    log('Übersetze Beschreibung (DE)…', 'info', 'scraper');
    try {
      beschreibung = await translateDescription(description, openaiApiKey);
      logOk('Beschreibung übersetzt', 'scraper');
    } catch(e) { logWarn(`Beschreibung Übersetzung fehlgeschlagen: ${e.message}`, 'scraper'); }
    sendSSE({ type: 'scraper_progress', step: 'translate', total: 2, done: 1 });

    // Translate the formatted EN specs text directly — avoids JSON structure mismatch
    log('Übersetze Spezifikationen (DE)…', 'info', 'scraper');
    try {
      const specsTextEN = formatSpecsTextEN(specsSections, specs);
      if (specsTextEN) {
        abmessungenDE = await translateToDE(specsTextEN, openaiApiKey, 'motorcycle technical specifications (keep <h3> tags, translate section headings and spec key names to German, keep numeric values and units unchanged)');
        logOk('Spezifikationen übersetzt', 'scraper');
      }
    } catch(e) { logWarn(`Spezifikationen Übersetzung fehlgeschlagen: ${e.message}`, 'scraper'); }
    sendSSE({ type: 'scraper_progress', step: 'translate', total: 2, done: 2 });
  } else {
    logWarn('Kein OpenAI API Key → keine Übersetzung', 'scraper');
  }

  const bikeData = { year, category, name, code, url: bikeUrl, description, beschreibung, specs, specsSections, abmessungenDE, images: imageResults, videos: videoResults, specsPdf, pdfLocal: pdfLocal ? `docs/${pdfLocal}` : '' };
  fs.writeFileSync(path.join(bikeDir, 'data.json'), JSON.stringify(bikeData, null, 2));

  // ── Auto hero image identification ────────────────────────────
  if (openaiApiKey) {
    sendSSE({ type: 'scraper_progress', step: 'hero', total: 1, done: 0 });
    log('🖼️  Auto-identifying hero image…', 'info', 'scraper');
    try {
      const analysis = await analyzeImagesForBike(outputDir, slug, openaiApiKey);
      if (analysis.recommendedHero) logOk(`⭐ Hero: ${analysis.recommendedHero}`, 'scraper');
    } catch(e) {
      logWarn(`Hero identification failed: ${e.message}`, 'scraper');
    }
    sendSSE({ type: 'scraper_progress', step: 'hero', total: 1, done: 1 });
  }

  logOk(`Done: ${slug}`, 'scraper');
  result.status     = 'success';
  result.imageCount = imageResults.filter(i => !i.status.startsWith('error')).length;
  result.videoCount = videoResults.filter(v => !v.status.startsWith('error')).length;
  result.specsCount = Object.keys(specs).length;

  sendSSE({ type: 'scraper_bike_done', bike: { name, year, code }, status: 'success', folder: slug });
  return result;
}

// ── Translation: OpenAI ───────────────────────────────────────

function openaiChat(apiKey, messages, model = 'gpt-4o') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, temperature: 0.2 });
    const req  = https.request({
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error) return reject(new Error(j.error.message));
          resolve(j.choices[0].message.content.trim());
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('OpenAI timeout')); });
    req.write(body); req.end();
  });
}

async function translateDescription(text, apiKey) {
  if (!text || !apiKey) return '';
  const content = await openaiChat(apiKey, [
    { role: 'system', content: 'Du bist ein professioneller Übersetzer für Motorrad-Marketingtexte. Übersetze den folgenden englischen Text ins Deutsche. Behalte Produktnamen, Modellbezeichnungen und technische Begriffe bei. Antworte nur mit dem übersetzten Text, ohne Erklärungen.' },
    { role: 'user', content: text },
  ]);
  return content;
}

async function translateSpecsSections(sections, apiKey) {
  if (!sections || !sections.length || !apiKey) return sections;
  const prompt = JSON.stringify(sections);
  const content = await openaiChat(apiKey, [
    { role: 'system', content: 'Du bist ein professioneller Übersetzer für technische Motorrad-Spezifikationen. Übersetze das folgende JSON-Array von Spezifikationsabschnitten ins Deutsche. Übersetze alle "title"-Felder und alle Schlüssel und Werte in den "specs"-Objekten. Behalte Produktnamen, Modellnummern, Maßangaben (z.B. "1923cc", "4.016\\"") und Einheiten unverändert. Antworte NUR mit dem vollständigen übersetzten JSON-Array, ohne Markdown oder Erklärungen.' },
    { role: 'user', content: prompt },
  ]);
  // Strip markdown code fences if present
  const clean = content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/,'').trim();
  return JSON.parse(clean);
}

function flattenSections(sections) {
  const flat = {};
  for (const sec of sections) {
    if (sec.specs) Object.assign(flat, sec.specs);
  }
  return flat;
}

// ── Importer: HubSpot Helpers ─────────────────────────────────

function apiRequest(token, method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    let postData;
    const headers = { 'Authorization': `Bearer ${token}` };
    if (body) {
      postData = JSON.stringify(body);
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(postData);
    }
    const u = new URL('https://api.hubapi.com' + endpoint);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            let errMsg = `HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`;
            if (res.statusCode === 401) {
              errMsg = `❌ HubSpot Auth Failed (401): Token ungültig oder abgelaufen.\n→ Neuen Private App Token generieren: Settings → Integrations → Private Apps\n→ Scopes: files (read+write) + custom objects (write)`;
            }
            reject(new Error(errMsg));
          } else resolve(parsed);
        } catch(e) {
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          else resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function findHubSpotObjectByName(token, objectTypeId, name) {
  try {
    const res = await apiRequest(token, 'POST', `/crm/v3/objects/${objectTypeId}/search`, {
      filterGroups: [{ filters: [{ propertyName: 'hs_name', operator: 'EQ', value: name }] }],
      properties: ['hs_name'],
      limit: 1
    });
    if (res.total > 0 && res.results && res.results[0]) {
      return res.results[0].id;
    }
    return null;
  } catch(e) {
    logWarn(`HubSpot search failed (will create new): ${e.message}`, 'importer');
    return null;
  }
}

const MAX_UPLOAD_PX   = 2500;
const UPLOAD_QUALITY  = 92;

async function resizeForUpload(filePath) {
  try {
    const meta = await sharp(filePath).metadata();
    const needsResize = (meta.width > MAX_UPLOAD_PX || meta.height > MAX_UPLOAD_PX);
    const isLarge     = fs.statSync(filePath).size > 2 * 1024 * 1024;
    if (!needsResize && !isLarge) return filePath; // already small enough
    const tmpPath = filePath + '.upload_tmp.jpg';
    await sharp(filePath)
      .resize({ width: MAX_UPLOAD_PX, height: MAX_UPLOAD_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: UPLOAD_QUALITY, mozjpeg: true })
      .toFile(tmpPath);
    return tmpPath;
  } catch(e) {
    return filePath; // fallback: use original if resize fails
  }
}

function uploadFile(token, filePath, fileName, folderPath) {
  return new Promise((resolve, reject) => {
    const fileBuffer = fs.readFileSync(filePath);
    const boundary   = '----HDBoundary' + Date.now();
    const ext        = path.extname(fileName).toLowerCase();
    const mimeMap    = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.mp4':'video/mp4','.pdf':'application/pdf' };
    const mimeType   = mimeMap[ext] || 'application/octet-stream';
    const options    = JSON.stringify({ access: 'PUBLIC_INDEXABLE', overwrite: true });
    const textParts  =
      `--${boundary}\r\nContent-Disposition: form-data; name="folderPath"\r\n\r\n${folderPath}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${fileName}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n${options}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const body = Buffer.concat([Buffer.from(textParts), fileBuffer, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const req = https.request({
      hostname: 'api.hubapi.com', path: '/files/v3/files', method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            let errMsg = `Upload HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`;
            if (res.statusCode === 401) {
              errMsg = `❌ HubSpot Auth Failed (401): Token ungültig oder abgelaufen.\n→ Neuen Private App Token generieren: Settings → Integrations → Private Apps\n→ Scopes: files (read+write) + custom objects (write)`;
            }
            reject(new Error(errMsg));
          } else resolve(parsed);
        } catch(e) { reject(new Error(`Upload parse error: ${data.substring(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── HubSpot CMS: Page helpers ──────────────────────────────────

async function findHubSpotPageBySlug(token, slug) {
  try {
    const res = await apiRequest(token, 'GET', `/cms/v3/pages/site-pages?slug=${encodeURIComponent(slug)}&limit=1&archived=false`);
    if (res.results && res.results.length) return res.results[0];
  } catch(e) { /* not found */ }
  return null;
}

async function createOrUpdateHubSpotPage(token, pageData) {
  const existing = await findHubSpotPageBySlug(token, pageData.slug);

  const widgetContainers = {};
  if (pageData.objectId && pageData.moduleId) {
    const fieldName = pageData.fieldName || 'bike';
    widgetContainers[pageData.moduleId] = {
      id:   pageData.moduleId,
      name: pageData.moduleId,
      type: 'module',
      body: { [fieldName]: { id: String(pageData.objectId) } },
    };
  }

  const body = {
    name:            pageData.name,
    slug:            pageData.slug,
    templatePath:    pageData.templatePath,
    htmlTitle:       pageData.htmlTitle || pageData.name,
    metaDescription: (pageData.metaDescription || '').slice(0, 160),
    language:        pageData.language || 'de',
    state:           'DRAFT',
    ...(Object.keys(widgetContainers).length ? { widgetContainers } : {}),
  };

  if (existing) {
    await apiRequest(token, 'PATCH', `/cms/v3/pages/site-pages/${existing.id}`, body);
    return { id: existing.id, url: existing.url || `/${pageData.slug}`, action: 'updated' };
  } else {
    const res = await apiRequest(token, 'POST', `/cms/v3/pages/site-pages`, body);
    return { id: res.id, url: res.url || `/${pageData.slug}`, action: 'created' };
  }
}

// ── Importer: Logic ───────────────────────────────────────────

async function importBike(config, folderName) {
  const { apiToken, objectTypeId, inputDir, finanzierungsUrl, versicherungenUrl, openaiKey: openaiKey_ } = config;
  const openaiKey = openaiKey_ || process.env.OPENAI_API_KEY || '';
  const bikeDir  = path.join(inputDir, 'bikes', folderName);
  const dataPath = path.join(bikeDir, 'data.json');

  sendSSE({ type: 'importer_bike_start', folder: folderName });
  log(`━━ IMPORT: ${folderName}`, 'section', 'importer');

  let bike;
  try {
    bike = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    log(`data.json: ${bike.name} ${bike.year}`, 'info', 'importer');
  } catch(e) {
    logErr(`data.json nicht lesbar: ${e.message}`, 'importer');
    sendSSE({ type: 'importer_bike_done', folder: folderName, status: 'error', error: e.message });
    return { folder: folderName, status: 'error', error: e.message };
  }

  const slug     = sanitizeSlug(bike.name);
  const catSlug  = sanitizeSlug(bike.category);
  const prefix   = `${bike.year}_${slug}`;
  const basePath = `/hd-media/${bike.year}/${catSlug}/${slug}`;

  // Load existing progress (resume support)
  const progressPath = path.join(bikeDir, 'import_progress.json');
  let progress = { images: {}, videos: {}, pdf: null };
  if (fs.existsSync(progressPath)) {
    try {
      progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      const resumeCount = Object.keys(progress.images).length + Object.keys(progress.videos).length + (progress.pdf ? 1 : 0);
      if (resumeCount > 0) log(`♻️  Fortschritt gefunden – ${resumeCount} Datei(en) bereits hochgeladen, werden übersprungen`, 'warn', 'importer');
    } catch(e) { progress = { images: {}, videos: {}, pdf: null }; }
  }
  const saveProgress = () => fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));

  const result = { folder: folderName, bike: { name: bike.name, year: bike.year, code: bike.code }, status: 'pending', images: [], videos: [], pdf: null, hubspotId: null };

  // Images
  const imgDir   = path.join(bikeDir, 'images');
  const imgFiles = fs.existsSync(imgDir) ? fs.readdirSync(imgDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)) : [];
  log(`Bilder: ${imgFiles.length}`, 'info', 'importer');
  sendSSE({ type: 'importer_progress', step: 'images', total: imgFiles.length, done: 0 });

  for (let i = 0; i < imgFiles.length; i++) {
    const ext     = path.extname(imgFiles[i]);
    const base    = path.basename(imgFiles[i], ext);
    const newName = `${prefix}_${base}${ext}`;
    if (progress.images[imgFiles[i]]?.fileId) {
      const cached = progress.images[imgFiles[i]];
      log(`[${i+1}/${imgFiles.length}] ⏭️  ${newName} übersprungen (bereits hochgeladen → ${cached.fileId})`, 'skip', 'importer');
      result.images.push({ original: imgFiles[i], uploaded: newName, fileId: cached.fileId, url: cached.url, skipped: true });
    } else {
      try {
        const origPath    = path.join(imgDir, imgFiles[i]);
        const uploadPath  = await resizeForUpload(origPath);
        const wasResized  = uploadPath !== origPath;
        const origMB      = (fs.statSync(origPath).size / 1024 / 1024).toFixed(1);
        const upMB        = (fs.statSync(uploadPath).size / 1024 / 1024).toFixed(1);
        if (wasResized) log(`[${i+1}/${imgFiles.length}] Resize: ${origMB}MB → ${upMB}MB`, 'info', 'importer');
        const res = await uploadFile(apiToken, uploadPath, newName, `${basePath}/images`);
        if (wasResized) try { fs.unlinkSync(uploadPath); } catch {}
        log(`[${i+1}/${imgFiles.length}] ${newName} → ${res.id}`, 'ok', 'importer');
        result.images.push({ original: imgFiles[i], uploaded: newName, fileId: res.id, url: res.url });
        progress.images[imgFiles[i]] = { fileId: res.id, url: res.url };
        saveProgress();
      } catch(e) {
        logErr(`${newName}: ${e.message}`, 'importer');
        result.images.push({ original: imgFiles[i], uploaded: newName, fileId: null, error: e.message });
      }
    }
    sendSSE({ type: 'importer_progress', step: 'images', total: imgFiles.length, done: i + 1 });
    await sleep(350);
  }

  // Videos
  const vidDir   = path.join(bikeDir, 'videos');
  const vidFiles = fs.existsSync(vidDir) ? fs.readdirSync(vidDir).filter(f => /\.mp4$/i.test(f)) : [];
  log(`Videos: ${vidFiles.length}`, 'info', 'importer');
  sendSSE({ type: 'importer_progress', step: 'videos', total: vidFiles.length, done: 0 });

  // Re-read data.json after potential earlier modifications
  let bikeLatest = bike;
  try { bikeLatest = JSON.parse(fs.readFileSync(dataPath, 'utf8')); } catch(e) {}

  for (let vi = 0; vi < vidFiles.length; vi++) {
    const vidFile  = vidFiles[vi];
    const dataVid  = (bikeLatest.videos || []).find(v => (v.localFile || v.filename) === vidFile);
    const sizeMB   = dataVid?.sizeMB || 0;
    const thumbUrl = dataVid?.thumbUrl || '';

    // Priority 1: AI-confirmed type already stored in data.json
    let vidType = dataVid?.analysis?.type || null;
    let typeSource = vidType ? 'stored-AI' : null;

    // Priority 2: Heuristic from filename + size
    if (!vidType) {
      vidType = guessVideoType(vidFile, sizeMB);
      if (vidType) typeSource = 'heuristic';
    }

    // Priority 3: Fallback — call GPT-4o to classify via thumbnail
    if (!vidType && openaiKey && thumbUrl) {
      log(`[${vi+1}/${vidFiles.length}] ${vidFile}: type unknown → GPT-4o classification…`, 'info', 'importer');
      try {
        const aiResult = await classifyVideoWithAI(thumbUrl, vidFile, openaiKey);
        vidType    = aiResult.type || 'detail_view';
        typeSource = `AI(${aiResult.confidence||'?'})`;
        // Persist AI result back to data.json
        const fresh = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        const dv    = (fresh.videos || []).find(v => (v.localFile || v.filename) === vidFile);
        if (dv) dv.analysis = { type: vidType, confidence: aiResult.confidence, description: aiResult.description, analyzedAt: new Date().toISOString() };
        fs.writeFileSync(dataPath, JSON.stringify(fresh, null, 2));
        bikeLatest = fresh;
        logOk(`GPT-4o → ${vidType} (${aiResult.confidence}) · "${aiResult.description}"`, 'importer');
      } catch(e) {
        logWarn(`GPT-4o classify failed: ${e.message} → defaulting to detail_view`, 'importer');
        vidType    = 'detail_view';
        typeSource = 'fallback';
      }
    }

    // Final fallback if still unknown
    if (!vidType) { vidType = 'detail_view'; typeSource = 'fallback'; }

    const typeSuffix = vidType === 'riding_outdoor' ? 'b-roll' : 'detail';
    const newName    = `${prefix}_${typeSuffix}.mp4`;

    if (progress.videos[vidFile]?.fileId) {
      const cached = progress.videos[vidFile];
      log(`⏭️  ${newName} [${vidType} · ${typeSource}] übersprungen (bereits hochgeladen → ${cached.fileId})`, 'skip', 'importer');
      result.videos.push({ original: vidFile, uploaded: newName, fileId: cached.fileId, url: cached.url, videoType: cached.videoType || vidType, skipped: true });
    } else {
      try {
        const res = await uploadFile(apiToken, path.join(vidDir, vidFile), newName, `${basePath}/videos`);
        logOk(`${newName} [${vidType} · ${typeSource}] → ${res.id}`, 'importer');
        result.videos.push({ original: vidFile, uploaded: newName, fileId: res.id, url: res.url, videoType: vidType });
        progress.videos[vidFile] = { fileId: res.id, url: res.url, videoType: vidType };
        saveProgress();
      } catch(e) {
        logErr(`${newName}: ${e.message}`, 'importer');
        result.videos.push({ original: vidFile, uploaded: newName, fileId: null, videoType: vidType, error: e.message });
      }
    }
    sendSSE({ type: 'importer_progress', step: 'videos', total: vidFiles.length, done: vi + 1 });
    await sleep(350);
  }

  // PDF
  const pdfPath = path.join(bikeDir, 'docs', `specs_${bike.code}_${bike.year}_eu.pdf`);
  sendSSE({ type: 'importer_progress', step: 'pdf', total: 1, done: 0 });
  if (fs.existsSync(pdfPath)) {
    const newName = `${prefix}_specs.pdf`;
    if (progress.pdf?.fileId) {
      log(`⏭️  ${newName} übersprungen (bereits hochgeladen → ${progress.pdf.fileId})`, 'skip', 'importer');
      result.pdf = { uploaded: newName, fileId: progress.pdf.fileId, url: progress.pdf.url, skipped: true };
    } else {
      try {
        const res = await uploadFile(apiToken, pdfPath, newName, `${basePath}/docs`);
        logOk(`${newName} → ${res.id}`, 'importer');
        result.pdf = { uploaded: newName, fileId: res.id, url: res.url };
        progress.pdf = { fileId: res.id, url: res.url };
        saveProgress();
      } catch(e) {
        logErr(`PDF: ${e.message}`, 'importer');
        result.pdf = { error: e.message };
      }
    }
  } else {
    logWarn('Keine PDF gefunden', 'importer');
  }
  sendSSE({ type: 'importer_progress', step: 'pdf', total: 1, done: 1 });

  // Build HubSpot properties
  // Step 1: Build structured EN text (source of truth)
  const specsTextEN = formatSpecsTextEN(bike.specsSections, bike.specs);

  // Step 2: Build DE text — prefer stored abmessungenDE, else translate EN now
  let specsText = bikeLatest.abmessungenDE || bike.abmessungenDE || '';
  if (!specsText && specsTextEN && openaiKey) {
    log('Keine DE-Übersetzung der Specs gefunden → übersetze jetzt…', 'info', 'importer');
    try {
      specsText = await translateToDE(specsTextEN, openaiKey, 'motorcycle technical specifications (keep <h3> tags, translate section headings and spec key names to German, keep numeric values and units unchanged)');
      const fresh = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      fresh.abmessungenDE = specsText;
      fs.writeFileSync(dataPath, JSON.stringify(fresh, null, 2));
      logOk('Specs DE übersetzt und gespeichert', 'importer');
    } catch(e) { logWarn(`Specs-Übersetzung fehlgeschlagen: ${e.message}`, 'importer'); specsText = specsTextEN; }
  }

  // Step 3: Description — prefer stored DE, else translate EN now
  let beschreibungDE = bike.beschreibung || '';
  if (!beschreibungDE && bike.description && openaiKey) {
    log('Keine DE-Beschreibung gefunden → übersetze jetzt…', 'info', 'importer');
    try {
      beschreibungDE = await translateToDE(bike.description, openaiKey, 'motorcycle marketing description');
      const fresh = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      fresh.beschreibung = beschreibungDE;
      fs.writeFileSync(dataPath, JSON.stringify(fresh, null, 2));
      logOk('Beschreibung DE übersetzt und gespeichert', 'importer');
    } catch(e) { logWarn(`Beschreibung-Übersetzung fehlgeschlagen: ${e.message}`, 'importer'); beschreibungDE = bike.description; }
  }

  const okImages    = result.images.filter(i => i.fileId);
  // Prefer AI-identified hero (recommendedHero from data.json), fall back to first image
  const heroFile    = bike.recommendedHero || bikeLatest.recommendedHero || null;
  const hero        = heroFile
    ? (okImages.find(i => i.original === heroFile) || okImages[0])
    : okImages[0];
  if (heroFile && hero?.original === heroFile) log(`Hero: ${heroFile} (AI-empfohlen)`, 'ok', 'importer');
  else if (heroFile) logWarn(`Hero-Bild "${heroFile}" nicht hochgeladen — verwende erstes Bild`, 'importer');
  const gallery     = okImages.filter(i => i !== hero);
  const videoDetail = result.videos.find(v => v.fileId && v.videoType === 'detail_view');
  // video_footer: prefer riding_outdoor (outside/driver video), fall back to any non-detail
  const videoFooter = result.videos.find(v => v.fileId && v.videoType === 'riding_outdoor')
                   || result.videos.find(v => v.fileId && v.videoType !== 'detail_view');
  const pdfOk       = result.pdf?.fileId ? result.pdf : null;

  const properties = {
    hs_name: `${bike.name} ${bike.year}`,
    url_slug: slug, modelljahr: bike.year,
    kategorie: bike.category,
    beschreibung: beschreibungDE || bike.description || '',
    beschreibung_en: bike.description || '',
    abmessungen: specsText || specsTextEN,
    abmessungen_en: specsTextEN,
    finanzierungsrechner: finanzierungsUrl, versicherungen: versicherungenUrl,
  };
  if (hero)                           properties.hero_bild    = String(hero.fileId);
  if (videoDetail)                    properties.video        = String(videoDetail.fileId);
  if (videoFooter)                    properties.video_footer = String(videoFooter.fileId);
  if (pdfOk)                          properties.broschure    = pdfOk.url || String(pdfOk.fileId);
  if (gallery.length)                 properties.galerie      = gallery.map(i => i.fileId).join(';');
  log(`Video mapping → video: ${videoDetail?.uploaded||'—'}  |  video_footer: ${videoFooter?.uploaded||'—'}`, 'info', 'importer');

  // Create or Update HubSpot object
  sendSSE({ type: 'importer_progress', step: 'hubspot', total: 1, done: 0 });
  let existingId = progress.hubspotId || null;
  try {
    let res;
    if (!existingId) {
      log(`Suche bestehendes HubSpot-Objekt für "${properties.hs_name}"…`, 'info', 'importer');
      existingId = await findHubSpotObjectByName(apiToken, objectTypeId, properties.hs_name);
      if (existingId) {
        log(`✓ Bestehendes Objekt gefunden (ID ${existingId}) – wird aktualisiert, kein Duplikat`, 'warn', 'importer');
        progress.hubspotId = existingId;
        saveProgress();
      }
    }
    if (existingId) {
      log(`HubSpot Custom Object aktualisieren (ID ${existingId})…`, 'info', 'importer');
      res = await apiRequest(apiToken, 'PATCH', `/crm/v3/objects/${objectTypeId}/${existingId}`, { properties });
      res.id = existingId;
      logOk(`Custom Object aktualisiert → ID ${existingId}`, 'importer');
    } else {
      log('HubSpot Custom Object anlegen…', 'info', 'importer');
      res = await apiRequest(apiToken, 'POST', `/crm/v3/objects/${objectTypeId}`, { properties });
      logOk(`Custom Object angelegt → ID ${res.id}`, 'importer');
    }
    result.hubspotId    = res.id;
    result.status       = 'success';
    progress.hubspotId  = res.id;
    saveProgress();

    // ── Create / update HubSpot site page ─────────────────────
    const { templatePath, pageSlugPrefix, moduleId, fieldName, createPages } = config;
    if (!createPages || !templatePath) {
      logWarn(`Seiten-Erstellung übersprungen – ${!createPages ? '"Seiten erstellen" nicht aktiviert' : 'kein Template Path angegeben'}`, 'importer');
    }
    if (createPages && templatePath && result.hubspotId) {
      const pageSlug = [(pageSlugPrefix || 'bikes').replace(/\/+$/, ''), bike.year, slug].join('/');
      log(`Seite erstellen/aktualisieren → /${pageSlug}`, 'info', 'importer');
      try {
        const page = await createOrUpdateHubSpotPage(apiToken, {
          name:            `${bike.name} ${bike.year}`,
          slug:            pageSlug,
          templatePath,
          htmlTitle:       `${bike.name} ${bike.year} | Harley-Davidson`,
          metaDescription: (bike.description || '').slice(0, 160),
          language:        'de',
          objectId:        result.hubspotId,
          moduleId:        moduleId || 'bike_auswahl',
          fieldName:       fieldName || 'bike',
        });
        logOk(`Seite ${page.action}: /${pageSlug} (ID ${page.id})`, 'importer');
        result.pageId  = page.id;
        result.pageUrl = page.url;
        sendSSE({ type: 'importer_page_created', folder: folderName, pageId: page.id, pageUrl: page.url, slug: pageSlug, action: page.action });
        const fresh = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        fresh.hubspotPageId  = page.id;
        fresh.hubspotPageUrl = page.url;
        fs.writeFileSync(dataPath, JSON.stringify(fresh, null, 2));
      } catch(e) {
        logWarn(`Seite konnte nicht erstellt werden: ${e.message}`, 'importer');
      }
    }
  } catch(e) {
    logErr(`Custom Object: ${e.message}`, 'importer');
    result.status = 'error';
    result.error  = e.message;
  }
  sendSSE({ type: 'importer_progress', step: 'hubspot', total: 1, done: 1 });
  sendSSE({ type: 'importer_bike_done', folder: folderName, status: result.status, hubspotId: result.hubspotId, pageUrl: result.pageUrl, error: result.error });
  return result;
}

// ── Bike Catalog ──────────────────────────────────────────────

const BIKE_CATALOG = [
  { year: '2026', category: 'Adventure Touring', name: 'Pan America 1250', code: 'ra1250', url: `${BASE_URL}/eu/bdp/?ra1250|2026` },
  { year: '2026', category: 'Adventure Touring', name: 'Pan America 1250 Special', code: 'ra1250s' },
  { year: '2026', category: 'Cruiser', name: 'Street Bob 114', code: 'fxbbs' },
  { year: '2026', category: 'Cruiser', name: 'Fat Bob 114', code: 'fxfbs' },
  { year: '2026', category: 'Cruiser', name: 'Low Rider S', code: 'fxlrs' },
  { year: '2026', category: 'Cruiser', name: 'Breakout 117', code: 'fxbr' },
  { year: '2026', category: 'Touring', name: 'Road Glide', code: 'fltrx' },
  { year: '2026', category: 'Touring', name: 'Road Glide Special', code: 'fltrxs' },
  { year: '2026', category: 'Touring', name: 'Street Glide', code: 'flhx' },
  { year: '2026', category: 'Touring', name: 'Street Glide Special', code: 'flhxs' },
  { year: '2026', category: 'Touring', name: 'Road King', code: 'flhr' },
  { year: '2026', category: 'Touring', name: 'Road King Special', code: 'flhrxs' },
  { year: '2026', category: 'Touring', name: 'Ultra Limited', code: 'flhtk' },
  { year: '2026', category: 'Touring', name: 'Electra Glide Ultra Classic', code: 'flhtcu' },
  { year: '2026', category: 'Sportster', name: 'Nightster', code: 'rh975' },
  { year: '2026', category: 'Sportster', name: 'Sportster S', code: 'rh1250s' },
  { year: '2026', category: 'CVO', name: 'CVO Road Glide', code: 'fltrxse' },
  { year: '2026', category: 'CVO', name: 'CVO Street Glide', code: 'flhxse' },
  { year: '2026', category: 'Trike', name: 'Tri Glide Ultra', code: 'flhtcutg' },
  { year: '2026', category: 'Trike', name: 'Freewheeler', code: 'flrt' },
];

// ── Discovery: parse bikes from a HD listing page ─────────────

function discoverBikesFromHtml(html) {
  const bikes = [];
  const seen  = new Set();

  // Build a category map: split HTML into sections by h2/h3 headings
  // so each bike link can be associated with the nearest preceding heading
  const sectionRe = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
  const sections  = [];
  let m;
  while ((m = sectionRe.exec(html)) !== null) {
    sections.push({ text: stripTags(m[1]).trim(), pos: m.index });
  }

  function categoryAt(pos) {
    let cat = '';
    for (const s of sections) {
      if (s.pos <= pos) cat = s.text;
      else break;
    }
    return cat;
  }

  // Match anchors containing BDP links: href="...bdp/?code|year..."
  const anchorRe = /<a[^>]+href="([^"]*bdp[^"?]*\?([a-z0-9]+)\|(\d{4})[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = anchorRe.exec(html)) !== null) {
    const code = m[2].toLowerCase();
    const year = m[3];
    const key  = `${code}|${year}`;
    if (!seen.has(key)) {
      seen.add(key);
      const name     = stripTags(m[4]).trim() || code;
      const category = categoryAt(m.index);
      const rawHref = m[1];
      const pageUrl  = rawHref.startsWith('http') ? rawHref : BASE_URL + (rawHref.startsWith('/') ? '' : '/') + rawHref;
      bikes.push({ code, year, name: cleanText(name), category, url: pageUrl });
    }
  }

  // Fallback: bare URL pattern (no anchor wrap)
  if (bikes.length === 0) {
    const re = /bdp[^"'<>\s]*\?([a-z0-9]+)\|(\d{4})/gi;
    while ((m = re.exec(html)) !== null) {
      const code = m[1].toLowerCase();
      const year = m[2];
      const key  = `${code}|${year}`;
      if (!seen.has(key)) {
        seen.add(key);
        bikes.push({ code, year, name: code, category: categoryAt(m.index), url: `${BASE_URL}/eu/bdp/?${code}|${year}` });
      }
    }
  }

  return bikes;
}

function findBikeFolders(inputDir, filterCode, filterYear) {
  const bikesDir = path.join(inputDir, 'bikes');
  if (!fs.existsSync(bikesDir)) return [];
  return fs.readdirSync(bikesDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(bikesDir, e.name, 'data.json')))
    .map(e => e.name)
    .filter(f => !filterCode || f.includes(filterCode))
    .filter(f => !filterYear || f.startsWith(filterYear + '_'));
}

// ── HTTP Server ───────────────────────────────────────────────

let scrapeRunning  = false;
let importRunning  = false;

const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(HTML_FILE));
    return;
  }

  if (pathname === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 1000\n\n');
    sseClients.push(res);
    req.on('close', () => {
      const idx = sseClients.indexOf(res);
      if (idx !== -1) sseClients.splice(idx, 1);
    });
    return;
  }

  // ── Scraper API ──

  if (pathname === '/api/discover' && req.method === 'GET') {
    const targetUrl = parsed.query.url;
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'url parameter required' }));
      return;
    }
    try {
      log(`Discovering bikes from ${targetUrl}...`, 'info', 'scraper');
      const html  = await fetchHTML(targetUrl);
      const bikes = discoverBikesFromHtml(html);
      log(`Found ${bikes.length} bike model(s)`, bikes.length > 0 ? 'ok' : 'warn', 'scraper');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ bikes, source: targetUrl, raw: bikes.length === 0 ? html.substring(0, 500) : undefined }));
    } catch(e) {
      logErr(`Discover failed: ${e.message}`, 'scraper');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname === '/api/env-config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      openaiKey:      process.env.OPENAI_API_KEY      || '',
      hubspotToken:   process.env.HUBSPOT_TOKEN        || '',
      objectTypeId:   process.env.HUBSPOT_OBJECT_TYPE_ID || '',
    }));
    return;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadState()));
    return;
  }

  if (pathname === '/api/state' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const patch = JSON.parse(body);
        const next  = saveState(patch);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, bikes: next.bikes.length }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/file' && req.method === 'GET') {
    const { outputDir = './hd-output', folder, file } = parsed.query;
    if (!folder || !file) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('folder and file parameters required');
      return;
    }
    const safePath = path.join(outputDir, 'bikes', folder, file);
    if (!fs.existsSync(safePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
      '.mp4': 'video/mp4', '.webm': 'video/webm',
      '.pdf': 'application/pdf',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(safePath).pipe(res);
    return;
  }

  if (pathname === '/api/bike-data' && req.method === 'GET') {
    const { outputDir = './hd-output', folder } = parsed.query;
    if (!folder) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'folder required' })); return; }
    const dataPath = path.join(outputDir, 'bikes', folder, 'data.json');
    if (!fs.existsSync(dataPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `data.json not found at ${dataPath}` }));
      return;
    }
    try {
      const d = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const bikeDir   = path.join(outputDir, 'bikes', folder);
      const images    = (d.images  || []).map((img, idx) => ({ file: img.localFile || '', size: img.localFile ? (() => { try { return fs.statSync(path.join(bikeDir, 'images', img.localFile)).size; } catch(e) { return 0; } })() : 0, analysis: img.analysis || null, imageIndex: idx })).filter(i => i.file);
      const videos    = (d.videos  || []).map((vid, idx) => { const sizeMB = vid.sizeMB || 0; const file = vid.localFile || vid.filename || ''; const heuristicType = guessVideoType(file, sizeMB); return { file, size: file ? (() => { try { return fs.statSync(path.join(bikeDir, 'videos', file)).size; } catch(e) { return 0; } })() : 0, thumbUrl: vid.thumbUrl || '', mp4Url: vid.mp4Url || '', sizeMB, heuristicType, analysis: vid.analysis || null, videoIndex: idx }; }).filter(v => v.file);
      const specs     = d.specs || {};
      const specsSections = d.specsSections || [];
      const specsList = specsSections.length > 0
        ? specsSections.flatMap(s => s.rows).slice(0, 20).map(r => ({ k: r.name, v: r.value, section: '' }))
        : Object.entries(specs).slice(0, 20).map(([k,v]) => ({ k, v }));
      const imgAnalyzedCount = (d.images||[]).filter(i => i.analysis).length;
      const imgTypeBreakdown = {};
      (d.images||[]).forEach(i => { if (i.analysis?.type) imgTypeBreakdown[i.analysis.type] = (imgTypeBreakdown[i.analysis.type]||0)+1; });
      const vidAnalyzedCount = (d.videos||[]).filter(v => v.analysis).length;
      const vidTypeBreakdown = {};
      (d.videos||[]).forEach(v => {
        const t = (v.analysis?.type) || guessVideoType(v.localFile||v.filename||'', v.sizeMB||0) || 'unknown';
        vidTypeBreakdown[t] = (vidTypeBreakdown[t]||0)+1;
      });
      const specsTextEN = formatSpecsTextEN(d.specsSections, d.specs);
      const specsTextDE = formatSpecsTextDE(d.specsSectionsDE, d.specsDE) || d.abmessungenDE || '';
      res.end(JSON.stringify({
        name:           d.name,
        year:           d.year,
        category:       d.category,
        code:           d.code,
        description:    d.description || '',
        beschreibung:   d.beschreibung || '',
        specsTextEN,
        specsTextDE,
        images,
        videos,
        specs:       specsList,
        specsSections,
        specsCount:  specsSections.length > 0 ? specsSections.reduce((a,s) => a + s.rows.length, 0) : Object.keys(specs).length,
        hasPdf:      !!d.pdfLocal,
        pdfLocal:    d.pdfLocal || '',
        recommendedHero: d.recommendedHero || null,
        folder,
        pipeline: {
          modelljahr:        d.year || '',
          hasDescription:    !!(d.description),
          hasTranslation:    !!(d.beschreibung),
          hasSpecsDE:        !!(d.abmessungenDE || d.specsSectionsDE?.length || d.specsDE),
          specsSectionsCount: (d.specsSections||[]).length,
          specsRowCount:     specsSections.length > 0 ? specsSections.reduce((a,s) => a + s.rows.length, 0) : Object.keys(specs).length,
          imagesTotal:       (d.images||[]).length,
          imagesAnalyzed:    imgAnalyzedCount,
          imageTypeBreakdown: imgTypeBreakdown,
          recommendedHero:   d.recommendedHero || null,
          videosTotal:       (d.videos||[]).length,
          videosAnalyzed:    vidAnalyzedCount,
          videoTypeBreakdown: vidTypeBreakdown,
          hasPdf:            !!d.pdfLocal,
          scrapedAt:         d.scrapedAt || null,
        },
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname === '/api/catalog' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(BIKE_CATALOG));
    return;
  }

  if (pathname === '/api/scrape' && req.method === 'POST') {
    if (scrapeRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Scraping läuft bereits' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let config;
      try { config = JSON.parse(body); } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: true }));

      scrapeRunning = true;
      const results = [];
      sendSSE({ type: 'scrape_start', bikes: config.bikes });

      for (const bike of config.bikes) {
        const result = await scrapeBike(config, bike);
        results.push(result);
      }

      const outputDir = config.outputDir || './hd-output';
      const logsDir   = path.join(outputDir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, 'scrape_results.json'), JSON.stringify(results, null, 2));
      sendSSE({ type: 'scrape_done', results });
      scrapeRunning = false;
      const crawledPatch = {};
      results.forEach(r => { crawledPatch[`${r.bike?.year}_${r.bike?.code}`] = { status: r.status, ts: new Date().toISOString(), folder: r.folder }; });
      saveState({ crawled: { ...loadState().crawled, ...crawledPatch } });
    });
    return;
  }

  // ── Importer API ──
  if (pathname === '/api/bikes' && req.method === 'GET') {
    const inputDir   = parsed.query.inputDir || './hd-output';
    const filterCode = parsed.query.code || null;
    const filterYear = parsed.query.year || null;
    const folders    = findBikeFolders(inputDir, filterCode, filterYear);
    const bikes = folders.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(inputDir, f, 'data.json'), 'utf8'));
        return { folder: f, name: data.name, year: data.year, category: data.category, code: data.code };
      } catch(e) { return { folder: f, name: f, error: e.message }; }
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(bikes));
    return;
  }

  if (pathname === '/api/test-hubspot' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { apiToken, objectTypeId } = JSON.parse(body);
        
        // Test API access with a simple request
        log('Testing HubSpot API access...', 'info', 'importer');
        await apiRequest(apiToken, 'GET', `/crm/v3/objects/${objectTypeId}?limit=1`);
        log('✓ API access confirmed', 'ok', 'importer');
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Connection successful' }));
      } catch(e) {
        log(`✗ HubSpot test failed: ${e.message}`, 'error', 'importer');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/create-listing-page' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { apiToken, templatePath, slug, title, language } = JSON.parse(body);
        if (!apiToken || !templatePath || !slug) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'apiToken, templatePath, slug required' }));
          return;
        }
        const page = await createOrUpdateHubSpotPage(apiToken, {
          name:         title || 'Motorrad Übersicht',
          slug:         slug,
          templatePath: templatePath,
          htmlTitle:    title || 'Alle Motorräder | Harley-Davidson',
          language:     language || 'de',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, page }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/reset-import' && req.method === 'POST') {
    importRunning = false;
    log('Import manually reset by user', 'warn', 'importer');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Import lock released' }));
    return;
  }

  if (pathname === '/api/import' && req.method === 'POST') {
    if (importRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Import läuft bereits' }));
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const config = JSON.parse(body);
      if (importRunning) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Import already running' })); return; }
      
      if (!config.apiToken) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'apiToken required' }));
        return;
      }
      
      importRunning = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      try {
        sendSSE({ type: 'import_start' });
        const results = [];

        for (const folder of config.folders) {
          try {
            const result = await importBike(config, folder);
            results.push(result);
          } catch(e) {
            logErr(`Import crashed for ${folder}: ${e.message}`, 'importer');
            results.push({ folder, status: 'error', error: e.message });
          }
        }

        const outputDir = config.inputDir || './hd-output';
        const logsDir   = path.join(outputDir, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        const logLines  = results.map(r => `[${r.folder}] ${r.status}`).join('\n');
        fs.writeFileSync(path.join(logsDir, 'import_log.txt'), logLines, 'utf8');
        fs.writeFileSync(path.join(logsDir, 'import_result.json'), JSON.stringify(results, null, 2));
        sendSSE({ type: 'import_done', results });
        const importedPatch = {};
        results.forEach(r => { importedPatch[r.folder] = { status: r.status, ts: new Date().toISOString() }; });
        saveState({ imported: { ...loadState().imported, ...importedPatch } });
      } catch(e) {
        logErr(`Import process failed: ${e.message}`, 'importer');
        sendSSE({ type: 'import_done', results: [], error: e.message });
      } finally {
        importRunning = false;
        log('Import process finished, lock released', 'info', 'importer');
      }
    });
    return;
  }

  if (pathname === '/api/analyze-images' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { outputDir = './hd-output', folder, openaiKey } = JSON.parse(body);
        if (!folder || !openaiKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'folder and openaiKey required' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'analyzing' }));
        log(`🖼️  Analyzing images for ${folder}…`, 'info', 'analyzer');
        sendSSE({ type: 'analyze_images_start', folder });
        try {
          const result = await analyzeImagesForBike(outputDir, folder, openaiKey);
          logOk(`Image analysis done for ${folder} → ${result.results.length} images, hero: ${result.recommendedHero || '—'}`, 'analyzer');
          sendSSE({ type: 'analyze_images_done', folder, results: result.results, validFiles: result.validFiles, recommendedHero: result.recommendedHero });
        } catch(e) {
          logErr(`Image analysis failed: ${e.message}`, 'analyzer');
          sendSSE({ type: 'analyze_images_error', folder, error: e.message });
        }
      } catch(e) {
        try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch {}
      }
    });
    return;
  }

  if (pathname === '/api/analyze-video' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { outputDir = './hd-output', folder, videoIndex = 0, openaiKey } = JSON.parse(body);
        if (!folder) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'folder required' }));
          return;
        }
        if (!openaiKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'openaiKey required' }));
          return;
        }
        const dataPath = path.join(outputDir, 'bikes', folder, 'data.json');
        if (!fs.existsSync(dataPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'data.json not found' }));
          return;
        }
        const bikeData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        const video = (bikeData.videos || [])[videoIndex];
        if (!video) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `No video at index ${videoIndex}` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'analyzing' }));
        log(`🎬 Analyzing video [${videoIndex}] for ${folder}: ${video.filename}`, 'info', 'analyzer');
        sendSSE({ type: 'analyze_start', folder, videoIndex, filename: video.filename });
        try {
          const frames = await extractVideoFrames(video.mp4Url, video.thumbUrl);
          if (!frames.length) throw new Error('No frames could be extracted');
          log(`Sending ${frames.length} frame(s) to OpenAI Vision…`, 'info', 'analyzer');
          const result = await analyzeFramesWithOpenAI(frames, openaiKey, bikeData.name, video.filename);
          const analysis = { ...result, frameCount: frames.length, analyzedAt: new Date().toISOString() };
          bikeData.videos[videoIndex].analysis = analysis;
          fs.writeFileSync(dataPath, JSON.stringify(bikeData, null, 2));
          logOk(`Video analysis complete for ${video.filename} → type: ${analysis.type || 'unknown'}`, 'analyzer');
          sendSSE({ type: 'analyze_done', folder, videoIndex, analysis });
        } catch(e) {
          logErr(`Video analysis failed: ${e.message}`, 'analyzer');
          sendSSE({ type: 'analyze_error', folder, videoIndex, error: e.message });
        }
      } catch(e) {
        logErr(`analyze-video route error: ${e.message}`, 'analyzer');
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        } catch {}
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  🏍️  HD Import Suite gestartet           ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  http://localhost:${PORT}                  ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  const { exec } = require('child_process');
  exec(`open http://localhost:${PORT}`);
});
