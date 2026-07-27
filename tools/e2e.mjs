/*
 * End-to-end test of the app, driving headless Chrome over the DevTools Protocol.
 * No dependencies: node >= 22 and Google Chrome installed.
 *
 *   node tools/e2e.mjs
 *
 * Exits with code 1 if any check fails.
 */
import { spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, readdirSync, statSync, existsSync, readFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = pathToFileURL(join(ROOT, 'index.html')).href;
const WORK = mkdtempSync(join(tmpdir(), 'explain-render-e2e-'));
const DOWNLOADS = join(WORK, 'downloads');
const PORT = 9333;

mkdirSync(DOWNLOADS, { recursive: true });

const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1400,900',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(WORK, 'profile')}`,
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function debuggerUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = tabs.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* chrome still starting */ }
    await sleep(200);
  }
  throw new Error('Chrome did not answer on the debug port');
}

const ws = new WebSocket(await debuggerUrl());
await new Promise((r) => ws.addEventListener('open', r));

let nextId = 0;
const pending = new Map();
const events = [];

ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: ok, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : ok(msg.result);
  } else if (msg.method) {
    events.push(msg);
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((ok, reject) => pending.set(id, { resolve: ok, reject }));
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error('JS: ' + r.exceptionDetails.text);
  return r.result.value;
}

const results = [];
const check = (name, ok, detail = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}`);

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });

await send('Page.navigate', { url: APP });
await sleep(2500);

// no console errors
const consoleErrors = events.filter((e) =>
  e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
check('no console errors', consoleErrors.length === 0,
  consoleErrors.map((e) => JSON.stringify(e.params).slice(0, 200)).join(' | '));

// initial diagram
const initial = JSON.parse(await evaluate(`JSON.stringify({
  content: document.querySelectorAll('#content path, #content text').length,
  hits: document.querySelectorAll('#hits > *').length,
  status: document.getElementById('status').textContent,
  empty: document.getElementById('empty-state').hidden
})`));
check('initial diagram drawn', initial.content > 20, 'elements=' + initial.content);
check('hover areas created', initial.hits >= 2, 'hits=' + initial.hits);
check('empty state hidden', initial.empty === true);

// every sample
const dialects = new Set();
const total = await evaluate(`document.querySelectorAll('#samples .chip').length`);
for (let i = 0; i < total; i++) {
  await evaluate(`document.querySelectorAll('#samples .chip')[${i}].click()`);
  await sleep(250);
  const info = JSON.parse(await evaluate(`JSON.stringify({
    n: document.querySelectorAll('#content path, #content text').length,
    cls: document.getElementById('status').className,
    txt: document.getElementById('status').textContent
  })`));
  check(`sample ${i} renders`, info.n > 10 && !/error/.test(info.cls), info.txt);
  dialects.add(info.txt.split(' -')[0]);
}

// crop: 15px on the sides, 10px top and bottom
const pad = JSON.parse(await evaluate(`(function () {
  var inner = document.querySelector('#content > g');
  var bg = document.querySelector('#content > rect');
  var min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  inner.querySelectorAll('path, text, rect').forEach(function (e) {
    var b = e.getBBox();
    if (!b.width && !b.height) return;
    var m = 0, s = e.getAttribute('stroke');
    if (s && s !== 'none') {
      var sw = parseFloat(e.getAttribute('stroke-width'));
      if (!isNaN(sw)) m = sw / 2;
    }
    min[0] = Math.min(min[0], b.x - m); min[1] = Math.min(min[1], b.y - m);
    max[0] = Math.max(max[0], b.x + b.width + m); max[1] = Math.max(max[1], b.y + b.height + m);
  });
  var t = /translate\\(([-\\d.]+),([-\\d.]+)\\)/.exec(inner.getAttribute('transform'));
  var dx = +t[1], dy = +t[2];
  return JSON.stringify({
    left: +(min[0] + dx).toFixed(1),
    top: +(min[1] + dy).toFixed(1),
    right: +(+bg.getAttribute('width') - (max[0] + dx)).toFixed(1),
    bottom: +(+bg.getAttribute('height') - (max[1] + dy)).toFixed(1)
  });
})()`));
const near = (v, target) => Math.abs(v - target) <= 1.01;
check('crop margins (15 x 10)',
  near(pad.left, 15) && near(pad.right, 15) && near(pad.top, 10) && near(pad.bottom, 10),
  JSON.stringify(pad));

check('samples cover both dialects',
  dialects.has('MySQL') && dialects.has('PostgreSQL'), [...dialects].join(', '));

// tooltip
const box = JSON.parse(await evaluate(`(function () {
  var r = document.querySelectorAll('#hits > rect');
  var b = r[r.length - 1].getBoundingClientRect();
  return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
})()`));
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
await sleep(400);
const tip = JSON.parse(await evaluate(`JSON.stringify({
  hidden: document.getElementById('tooltip').hidden,
  heads: document.querySelectorAll('#tooltip .t-head').length
})`));
check('tooltip shows on hover', tip.hidden === false && tip.heads > 0, JSON.stringify(tip));

// zoom
const zoomBefore = await evaluate(`document.getElementById('zoom-label').textContent`);
await evaluate(`document.getElementById('btn-zoom-in').click()`);
const zoomAfter = await evaluate(`document.getElementById('zoom-label').textContent`);
check('zoom changes the scale', zoomBefore !== zoomAfter, `${zoomBefore} -> ${zoomAfter}`);
await evaluate(`document.getElementById('btn-fit').click()`);

// invalid input
await evaluate(`(function () {
  document.getElementById('json-input').value = '{ this is not json';
  document.getElementById('btn-render').click();
})()`);
await sleep(250);
check('invalid JSON reported',
  /error/.test(await evaluate(`document.getElementById('status').className`)),
  await evaluate(`document.getElementById('status').textContent`));

await evaluate(`(function () {
  document.getElementById('json-input').value = '{"something": 1}';
  document.getElementById('btn-render').click();
})()`);
await sleep(250);
const noQueryBlock = await evaluate(`document.getElementById('status').textContent`);
check('JSON without query_block reported', /query_block/.test(noQueryBlock), noQueryBlock);

// output pasted straight from the mysql client (with \G, header and footer)
const dirty = `*************************** 1. row ***************************
EXPLAIN: {
  "query_block": {
    "select_id": 1,
    "cost_info": { "query_cost": "1.00" },
    "table": {
      "table_name": "city",
      "access_type": "ALL",
      "rows_examined_per_scan": 1,
      "filtered": "100.00"
    }
  }
}
1 row in set, 1 warning (0,00 sec)`;
await evaluate(`(function () {
  document.getElementById('json-input').value = ${JSON.stringify(dirty)};
  document.getElementById('btn-render').click();
})()`);
await sleep(300);
const pasted = JSON.parse(await evaluate(`JSON.stringify({
  cls: document.getElementById('status').className,
  txt: document.getElementById('status').textContent,
  n: document.querySelectorAll('#content path, #content text').length
})`));
check('raw output from the mysql client', !/error/.test(pasted.cls) && pasted.n > 5, pasted.txt);

// raw psql output in aligned format (with the "+" line-continuation marker)
const psql = `                        QUERY PLAN
------------------------------------------------------------
 [                                                          +
   {                                                        +
     "Plan": {                                              +
       "Node Type": "Seq Scan",                             +
       "Relation Name": "city",                             +
       "Alias": "city",                                     +
       "Startup Cost": 0.00,                                +
       "Total Cost": 93.99,                                 +
       "Plan Rows": 237,                                    +
       "Plan Width": 49                                     +
     }                                                      +
   }                                                        +
 ]
(1 row)`;
await evaluate(`(function () {
  document.getElementById('json-input').value = ${JSON.stringify(psql)};
  document.getElementById('btn-render').click();
})()`);
await sleep(300);
const pgPasted = JSON.parse(await evaluate(`JSON.stringify({
  cls: document.getElementById('status').className,
  txt: document.getElementById('status').textContent,
  n: document.querySelectorAll('#content path, #content text').length,
  legend: document.getElementById('legend-title').textContent
})`));
check('raw output from psql', !/error/.test(pgPasted.cls) && /PostgreSQL/.test(pgPasted.txt) &&
  pgPasted.n > 5, pgPasted.txt);
check('legend follows the dialect', /node types/.test(pgPasted.legend), pgPasted.legend);

// exports
await evaluate(`document.querySelectorAll('#samples .chip')[2].click()`);
await sleep(400);
await evaluate(`document.getElementById('btn-svg').click()`);
await sleep(700);
await evaluate(`document.getElementById('btn-png').click()`);
await sleep(1800);
const files = readdirSync(DOWNLOADS).filter((f) => !f.endsWith('.crdownload'));
const svgFile = files.find((f) => f.endsWith('.svg'));
const pngFile = files.find((f) => f.endsWith('.png'));
check('SVG download', !!svgFile && statSync(join(DOWNLOADS, svgFile)).size > 1000,
  svgFile || files.join(','));
check('PNG download', !!pngFile && statSync(join(DOWNLOADS, pngFile)).size > 5000,
  pngFile || files.join(','));

// SEO and sharing tags
const SITE = 'https://explain-render.matob.dev/';
const meta = JSON.parse(await evaluate(`(function () {
  function attr(sel, name) {
    var e = document.querySelector(sel);
    return e ? e.getAttribute(name) : null;
  }
  var ld = document.querySelector('script[type="application/ld+json"]');
  return JSON.stringify({
    title: document.title,
    desc: attr('meta[name="description"]', 'content'),
    canonical: attr('link[rel="canonical"]', 'href'),
    robots: attr('meta[name="robots"]', 'content'),
    ogTitle: attr('meta[property="og:title"]', 'content'),
    ogDesc: attr('meta[property="og:description"]', 'content'),
    ogUrl: attr('meta[property="og:url"]', 'content'),
    ogImage: attr('meta[property="og:image"]', 'content'),
    ogType: attr('meta[property="og:type"]', 'content'),
    ogLocale: attr('meta[property="og:locale"]', 'content'),
    twCard: attr('meta[name="twitter:card"]', 'content'),
    twImage: attr('meta[name="twitter:image"]', 'content'),
    touchIcon: attr('link[rel="apple-touch-icon"]', 'href'),
    lang: document.documentElement.lang,
    ld: ld ? ld.textContent : null
  });
})()`));

check('title and description present',
  meta.title.length > 20 && meta.title.length < 75 &&
  meta.desc.length > 80 && meta.desc.length < 175,
  `title ${meta.title.length} ch, description ${meta.desc.length} ch`);

// the copy is plain English: no HTML entities and nothing outside ASCII left over
check('metatag copy is clean',
  !/&[a-z]+;/.test(meta.desc + meta.ogDesc + meta.title) &&
  !/[^\x00-\x7F]/.test(meta.desc + meta.ogDesc + meta.title),
  meta.desc.slice(0, 60) + '...');

check('canonical and og:url point at the site',
  meta.canonical === SITE && meta.ogUrl === SITE, meta.canonical);

check('indexing allowed',
  /index/.test(meta.robots) && !/noindex/.test(meta.robots) &&
  /max-image-preview:large/.test(meta.robots), meta.robots);

check('Open Graph complete',
  meta.ogType === 'website' && meta.ogLocale === 'en_US' &&
  !!meta.ogTitle && !!meta.ogDesc && meta.ogImage === SITE + 'og-image.png',
  `${meta.ogType}, ${meta.ogLocale}, ${meta.ogImage}`);

check('Twitter card with a large image',
  meta.twCard === 'summary_large_image' && meta.twImage === meta.ogImage, meta.twCard);

check('language declared', meta.lang === 'en', meta.lang);

let ld = null;
try { ld = JSON.parse(meta.ld); } catch { /* invalid */ }
check('JSON-LD valid',
  !!ld && ld['@type'] === 'WebApplication' && ld.url === SITE &&
  Array.isArray(ld.featureList) && ld.featureList.length > 0,
  ld ? `${ld['@type']}, ${ld.featureList.length} items in featureList` : 'not valid JSON');

// files the metatags and the robots point at
function pngSize(file) {
  const b = readFileSync(join(ROOT, file));
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
const og = existsSync(join(ROOT, 'og-image.png')) ? pngSize('og-image.png') : [0, 0];
const ogBytes = og[0] ? statSync(join(ROOT, 'og-image.png')).size : 0;
check('og-image.png is 1200x630 and light enough',
  og[0] === 1200 && og[1] === 630 && ogBytes < 300 * 1024,
  `${og[0]}x${og[1]}, ${(ogBytes / 1024).toFixed(0)} KB`);

const touch = existsSync(join(ROOT, 'apple-touch-icon.png')) ? pngSize('apple-touch-icon.png') : [0, 0];
check('apple-touch-icon.png is 180x180',
  touch[0] === 180 && touch[1] === 180 && meta.touchIcon === 'apple-touch-icon.png',
  `${touch[0]}x${touch[1]}`);

const robots = existsSync(join(ROOT, 'robots.txt')) ? readFileSync(join(ROOT, 'robots.txt'), 'utf8') : '';
check('robots.txt allows the site and points at the sitemap',
  /^User-agent:\s*\*/m.test(robots) && !/^Disallow:\s*\/\s*$/m.test(robots) &&
  robots.includes(SITE + 'sitemap.xml'), robots.trim().split('\n').join(' | '));

const sitemap = existsSync(join(ROOT, 'sitemap.xml')) ? readFileSync(join(ROOT, 'sitemap.xml'), 'utf8') : '';
check('sitemap.xml lists the canonical URL',
  sitemap.includes(`<loc>${SITE}</loc>`) && /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sitemap),
  (/<lastmod>(.*?)<\/lastmod>/.exec(sitemap) || [, '?'])[1]);

// the error page has to exist at the root: its absence is what makes Cloudflare
// Pages answer 200 with the home page for every path (single-page-app mode)
await send('Page.navigate', { url: pathToFileURL(join(ROOT, '404.html')).href });
await sleep(800);
const page404 = JSON.parse(await evaluate(`(function () {
  function attr(sel, name) {
    var e = document.querySelector(sel);
    return e ? e.getAttribute(name) : null;
  }
  return JSON.stringify({
    title: document.title,
    robots: attr('meta[name="robots"]', 'content'),
    home: attr('a.btn', 'href'),
    text: (document.querySelector('h1') || {}).textContent || '',
    height: document.querySelector('.card') ? document.querySelector('.card').offsetHeight : 0,
    externalStyles: document.querySelectorAll('link[rel="stylesheet"]').length
  });
})()`));
check('404.html is out of the index and links back home',
  /noindex/.test(page404.robots) && page404.home === '/' &&
  page404.height > 200 && page404.externalStyles === 0 &&
  /does not exist/.test(page404.text),
  `${page404.robots}, ${page404.height}px tall`);

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);

ws.close();
chrome.kill();
rmSync(WORK, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
