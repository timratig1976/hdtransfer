/**
 * ============================================================
 * HD Scraper – TEST (1 Bike)
 * Pan America 1250 Special 2026
 * ============================================================
 * Terminal:
 *   node hd_scraper_test.js
 * ============================================================
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const BASE_URL   = 'https://h-dmediakit.com';
const OUTPUT_DIR = './hd-output';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sanitize(str) {
  return str.replace(/[^a-z0-9_-]/gi, '_').replace(/__+/g, '_').toLowerCase();
}
function cleanText(str) {
  return (str||'').replace(/\s+/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#160;/g,' ').replace(/&nbsp;/g,' ').trim();
}
function stripTags(html) {
  return cleanText(html.replace(/<[^>]+>/g,' '));
}

function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
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

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      resolve({ status: 'exists', size: fs.statSync(dest).size });
      return;
    }
    const tmp = dest + '.tmp';
    const mod = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(tmp);
    let totalBytes = 0;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
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

function extractDescription(html) {
  const m = html.match(/class="brief-copy"[^>]*>([\s\S]*?)<\/div>/);
  return m ? stripTags(m[1]) : '';
}

function extractImages(html) {
  const results = [];
  // Match S3 image URLs from preview thumbnails
  const re = /src="(https:\/\/s3-eu-west-2\.amazonaws\.com\/[^"]+\/images\/preview\/[^"]+\.jpg)"/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (!seen.has(url)) {
      seen.add(url);
      results.push({ previewUrl: url, caption: '' });
    }
  }
  // Extract captions
  const capRe = /<p class="caption">([^<]+)<\/p>/g;
  let ci = 0;
  while ((m = capRe.exec(html)) !== null && ci < results.length) {
    results[ci].caption = cleanText(m[1]);
    ci++;
  }
  return results;
}

function extractVideos(html) {
  const results = [];
  // Match S3 video preview thumbnail URLs
  const re = /src="(https:\/\/s3-eu-west-2\.amazonaws\.com\/[^"]+\/video\/preview\/([^"\/]+)\.jpg)"/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    const thumbUrl = m[1];
    const filename = m[2];
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
        if (!sectionName && thCells[0]) sectionName = thCells[0];
        continue;
      }

      // Data row — only <td> cells, ignore Notes column (cell[2])
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

function exportTSV(bikeData) {
  const KEY_SPECS = [
    ['Engine',           'Engine'],
    ['Displacement',     'Displacement (*Cert)'],
    ['Power',            'Power (Hp/kW) (*Cert)'],
    ['Torque',           'Engine Torque (*Cert)'],
    ['Transmission',     'Transmission'],
    ['Final Drive',      'Final Drive (*Cert)'],
    ['Weight (running)', 'Weight, In Running Order (*Cert)'],
    ['Seat Height Low',  'Seat Height, Laden (Low seat position)'],
    ['Wheelbase',        'Wheelbase (*Cert)'],
    ['Fuel Capacity',    'Fuel Capacity'],
    ['Fuel Economy',     'Fuel Economy'],
    ['Frame',            'Frame'],
    ['Front Fork',       'Front Fork'],
    ['Rear Shocks',      'Rear Shocks'],
    ['Front Tire',       'Tires, Front Specification'],
    ['Rear Tire',        'Tires, Rear Specification'],
    ['ABS',              'Brakes, Anti-Lock Braking System (ABS)'],
    ['Warranty',         'Warranty'],
  ];

  const esc = v => String(v||'').replace(/\t/g,' ').replace(/\r?\n/g,' | ');
  const s = bikeData.specs || {};

  const headers = ['Model Year','Category','Bike Name','Model Code','BDP URL','Description',
    ...KEY_SPECS.map(k=>k[0]),
    'Image Count','Video Count','Image Preview URLs','Video MP4 URLs','Specs PDF URL','Local Folder'
  ];

  const row = [
    bikeData.year, bikeData.category, bikeData.name, bikeData.code, bikeData.url, bikeData.description,
    ...KEY_SPECS.map(k => s[k[1]] || ''),
    (bikeData.images||[]).length,
    (bikeData.videos||[]).length,
    (bikeData.images||[]).map(i=>i.previewUrl).join(' | '),
    (bikeData.videos||[]).map(v=>v.mp4Url).join(' | '),
    bikeData.specsPdf || '',
    `./hd-output/${bikeData.year}_${sanitize(bikeData.name)}_${bikeData.code}`
  ].map(esc);

  const tsv = [headers.join('\t'), row.join('\t')].join('\n');
  const tsvPath = path.join(OUTPUT_DIR, 'hd_test_pan_america_2026.tsv');
  fs.writeFileSync(tsvPath, tsv, 'utf8');
  return tsvPath;
}

// ── MAIN ─────────────────────────────────────────────────────

async function main() {
  const year     = '2026';
  const category = 'Adventure Touring';
  const name     = 'Pan America 1250 Special';
  const code     = 'ra1250s';

  const url     = `${BASE_URL}/eu/bdp/?${code}|${year}`;
  const slug    = `${year}_${sanitize(name)}_${code}`;
  const bikeDir = path.join(OUTPUT_DIR, slug);
  const imgDir  = path.join(bikeDir, 'images');
  const vidDir  = path.join(bikeDir, 'videos');

  fs.mkdirSync(imgDir, { recursive: true });
  fs.mkdirSync(vidDir, { recursive: true });

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  🏍️  HD Scraper TEST – 1 Bike                   ║');
  console.log('║  Pan America 1250 Special 2026                  ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log(`  URL: ${url}\n`);

  // Fetch
  console.log('⬇️  Fetching page...');
  let html;
  try {
    html = await fetchHTML(url);
    console.log(`✅ Page loaded (${Math.round(html.length/1024)} KB)\n`);
  } catch(e) {
    console.error('❌ Error:', e.message); process.exit(1);
  }

  // Parse
  const description  = extractDescription(html);
  const specsResult  = extractSpecs(html);
  const specs        = specsResult.flat;
  const specsSections = specsResult.sections;
  const images       = extractImages(html);
  const videos       = extractVideos(html);
  const specsPdf     = extractSpecsPdfUrl(html);

  console.log('📝 Description:');
  console.log('  ', description, '\n');
  console.log(`🔧 Specs found: ${Object.keys(specs).length} fields in ${specsSections.length} sections`);
  specsSections.forEach(s => console.log(`   └ ${s.section}: ${s.rows.length} rows`));
  console.log(`🖼️  Images found: ${images.length}`);
  console.log(`🎬 Videos found: ${videos.length}`);
  console.log(`📄 Specs PDF: ${specsPdf}\n`);

  // Download images
  console.log('── Downloading images ──────────────────────────────');
  const imageResults = [];
  for (let i = 0; i < images.length; i++) {
    const img      = images[i];
    const filename = path.basename(img.previewUrl.split('?')[0]);
    const dest     = path.join(imgDir, filename);
    try {
      const r = await downloadFile(img.previewUrl, dest);
      const kb = Math.round((r.size||0)/1024);
      console.log(`  ✅ [${i+1}/${images.length}] ${filename} (${kb} KB)`);
      imageResults.push({ ...img, localFile: filename, status: r.status });
    } catch(e) {
      console.log(`  ❌ [${i+1}/${images.length}] ${filename}: ${e.message}`);
      imageResults.push({ ...img, localFile: '', status: 'error: '+e.message });
    }
    await sleep(150);
  }

  // Download videos
  console.log('\n── Downloading videos ──────────────────────────────');
  const videoResults = [];
  if (videos.length === 0) {
    console.log('  (no videos found on this page)');
  }
  for (const vid of videos) {
    const dest = path.join(vidDir, vid.filename);
    console.log(`  ⬇️  ${vid.filename}`);
    try {
      const r = await downloadFile(vid.mp4Url, dest);
      const mb = Math.round((r.size||0)/1024/1024);
      console.log(`  ✅ ${r.status} – ${mb} MB`);
      videoResults.push({ ...vid, localFile: vid.filename, status: r.status, sizeMB: mb });
    } catch(e) {
      console.log(`  ❌ Error: ${e.message}`);
      videoResults.push({ ...vid, localFile: '', status: 'error: '+e.message });
    }
  }

  // Download PDF
  console.log('\n── Downloading Specs PDF ───────────────────────────');
  let pdfLocal = '';
  if (specsPdf) {
    const pdfDest = path.join(bikeDir, `specs_${code}_${year}_eu.pdf`);
    try {
      const r = await downloadFile(specsPdf, pdfDest);
      pdfLocal = path.basename(pdfDest);
      const kb = Math.round((r.size||0)/1024);
      console.log(`  ✅ ${pdfLocal} (${kb} KB)`);
    } catch(e) {
      console.log(`  ❌ ${e.message}`);
    }
  } else {
    console.log('  (no PDF found)');
  }

  // Save JSON
  const bikeData = { year, category, name, code, url, description, specs, specsSections, images: imageResults, videos: videoResults, specsPdf, pdfLocal };
  fs.writeFileSync(path.join(bikeDir, 'data.json'), JSON.stringify(bikeData, null, 2));

  // Export TSV
  const tsvPath = exportTSV(bikeData);

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  ✅ FERTIG                                        ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Images  : ${String(imageResults.filter(i=>!i.status.startsWith('error')).length + ' / ' + images.length).padEnd(40)}║`);
  console.log(`║  Videos  : ${String(videoResults.filter(v=>!v.status.startsWith('error')).length + ' / ' + videos.length).padEnd(40)}║`);
  console.log(`║  Specs   : ${String(Object.keys(specs).length + ' fields / ' + specsSections.length + ' sections').padEnd(40)}║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  📁 ${path.resolve(bikeDir).substring(0,45).padEnd(45)}║`);
  console.log(`║  📊 hd_test_pan_america_2026.tsv                 ║`);
  console.log('╚══════════════════════════════════════════════════╝');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
