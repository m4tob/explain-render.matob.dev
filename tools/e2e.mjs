/*
 * Teste end-to-end da aplicacao usando Chrome headless via DevTools Protocol.
 * Nao precisa de dependencias: node >= 22 e o Google Chrome instalado.
 *
 *   node tools/e2e.mjs
 *
 * Sai com codigo 1 se algum teste falhar.
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
    } catch { /* chrome ainda subindo */ }
    await sleep(200);
  }
  throw new Error('Chrome nao respondeu na porta de debug');
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

// nenhum erro de console
const consoleErrors = events.filter((e) =>
  e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
check('sem erros de console', consoleErrors.length === 0,
  consoleErrors.map((e) => JSON.stringify(e.params).slice(0, 200)).join(' | '));

// diagrama inicial
const initial = JSON.parse(await evaluate(`JSON.stringify({
  content: document.querySelectorAll('#content path, #content text').length,
  hits: document.querySelectorAll('#hits > *').length,
  status: document.getElementById('status').textContent,
  empty: document.getElementById('empty-state').hidden
})`));
check('diagrama inicial desenhado', initial.content > 20, 'elementos=' + initial.content);
check('areas de hover criadas', initial.hits >= 2, 'hits=' + initial.hits);
check('estado vazio escondido', initial.empty === true);

// todos os exemplos
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
  check(`exemplo ${i} renderiza`, info.n > 10 && !/error/.test(info.cls), info.txt);
  dialects.add(info.txt.split(' -')[0]);
}

// recorte: 15px nas laterais, 10px em cima e embaixo
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
    esq: +(min[0] + dx).toFixed(1),
    topo: +(min[1] + dy).toFixed(1),
    dir: +(+bg.getAttribute('width') - (max[0] + dx)).toFixed(1),
    base: +(+bg.getAttribute('height') - (max[1] + dy)).toFixed(1)
  });
})()`));
const near = (v, alvo) => Math.abs(v - alvo) <= 1.01;
check('margens do recorte (15 x 10)',
  near(pad.esq, 15) && near(pad.dir, 15) && near(pad.topo, 10) && near(pad.base, 10),
  JSON.stringify(pad));

check('exemplos cobrem os dois dialetos',
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
check('tooltip aparece no hover', tip.hidden === false && tip.heads > 0, JSON.stringify(tip));

// zoom
const zoomBefore = await evaluate(`document.getElementById('zoom-label').textContent`);
await evaluate(`document.getElementById('btn-zoom-in').click()`);
const zoomAfter = await evaluate(`document.getElementById('zoom-label').textContent`);
check('zoom altera a escala', zoomBefore !== zoomAfter, `${zoomBefore} -> ${zoomAfter}`);
await evaluate(`document.getElementById('btn-fit').click()`);

// entradas invalidas
await evaluate(`(function () {
  document.getElementById('json-input').value = '{ isso nao e json';
  document.getElementById('btn-render').click();
})()`);
await sleep(250);
check('JSON invalido reportado',
  /error/.test(await evaluate(`document.getElementById('status').className`)),
  await evaluate(`document.getElementById('status').textContent`));

await evaluate(`(function () {
  document.getElementById('json-input').value = '{"algo": 1}';
  document.getElementById('btn-render').click();
})()`);
await sleep(250);
const noQueryBlock = await evaluate(`document.getElementById('status').textContent`);
check('JSON sem query_block reportado', /query_block/.test(noQueryBlock), noQueryBlock);

// saida colada direto do cliente mysql (com \G, cabecalho e rodape)
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
check('saida bruta do cliente mysql', !/error/.test(pasted.cls) && pasted.n > 5, pasted.txt);

// saida bruta do psql no formato alinhado (com o "+" de continuacao de linha)
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
  legenda: document.getElementById('legend-title').textContent
})`));
check('saida bruta do psql', !/error/.test(pgPasted.cls) && /PostgreSQL/.test(pgPasted.txt) &&
  pgPasted.n > 5, pgPasted.txt);
check('legenda acompanha o dialeto', /tipos de no/.test(pgPasted.legenda), pgPasted.legenda);

// exportacoes
await evaluate(`document.querySelectorAll('#samples .chip')[2].click()`);
await sleep(400);
await evaluate(`document.getElementById('btn-svg').click()`);
await sleep(700);
await evaluate(`document.getElementById('btn-png').click()`);
await sleep(1800);
const files = readdirSync(DOWNLOADS).filter((f) => !f.endsWith('.crdownload'));
const svgFile = files.find((f) => f.endsWith('.svg'));
const pngFile = files.find((f) => f.endsWith('.png'));
check('download do SVG', !!svgFile && statSync(join(DOWNLOADS, svgFile)).size > 1000,
  svgFile || files.join(','));
check('download do PNG', !!pngFile && statSync(join(DOWNLOADS, pngFile)).size > 5000,
  pngFile || files.join(','));

// tags de SEO e de compartilhamento
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

check('title e description presentes',
  meta.title.length > 20 && meta.title.length < 75 &&
  meta.desc.length > 80 && meta.desc.length < 175,
  `title ${meta.title.length} ch, description ${meta.desc.length} ch`);

// as entidades HTML tem que chegar decodificadas em quem le a pagina
check('acentos decodificados nas metatags',
  /execu\u00e7\u00e3o/.test(meta.desc) && /n\u00famero/.test(meta.ogDesc) &&
  !/&[a-z]+;/.test(meta.desc + meta.ogDesc + meta.title),
  meta.desc.slice(0, 60) + '...');

check('canonical e og:url apontam para o site',
  meta.canonical === SITE && meta.ogUrl === SITE, meta.canonical);

check('indexacao liberada',
  /index/.test(meta.robots) && !/noindex/.test(meta.robots) &&
  /max-image-preview:large/.test(meta.robots), meta.robots);

check('Open Graph completo',
  meta.ogType === 'website' && meta.ogLocale === 'pt_BR' &&
  !!meta.ogTitle && !!meta.ogDesc && meta.ogImage === SITE + 'og-image.png',
  `${meta.ogType}, ${meta.ogLocale}, ${meta.ogImage}`);

check('Twitter card com imagem grande',
  meta.twCard === 'summary_large_image' && meta.twImage === meta.ogImage, meta.twCard);

check('idioma declarado', meta.lang === 'pt-BR', meta.lang);

let ld = null;
try { ld = JSON.parse(meta.ld); } catch { /* invalido */ }
check('JSON-LD valido',
  !!ld && ld['@type'] === 'WebApplication' && ld.url === SITE &&
  Array.isArray(ld.featureList) && ld.featureList.length > 0,
  ld ? `${ld['@type']}, ${ld.featureList.length} itens em featureList` : 'nao e JSON valido');

// arquivos que as metatags e os robos referenciam
function pngSize(file) {
  const b = readFileSync(join(ROOT, file));
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
const og = existsSync(join(ROOT, 'og-image.png')) ? pngSize('og-image.png') : [0, 0];
const ogBytes = og[0] ? statSync(join(ROOT, 'og-image.png')).size : 0;
check('og-image.png com 1200x630 e leve o bastante',
  og[0] === 1200 && og[1] === 630 && ogBytes < 300 * 1024,
  `${og[0]}x${og[1]}, ${(ogBytes / 1024).toFixed(0)} KB`);

const touch = existsSync(join(ROOT, 'apple-touch-icon.png')) ? pngSize('apple-touch-icon.png') : [0, 0];
check('apple-touch-icon.png com 180x180',
  touch[0] === 180 && touch[1] === 180 && meta.touchIcon === 'apple-touch-icon.png',
  `${touch[0]}x${touch[1]}`);

const robots = existsSync(join(ROOT, 'robots.txt')) ? readFileSync(join(ROOT, 'robots.txt'), 'utf8') : '';
check('robots.txt libera o site e aponta o sitemap',
  /^User-agent:\s*\*/m.test(robots) && !/^Disallow:\s*\/\s*$/m.test(robots) &&
  robots.includes(SITE + 'sitemap.xml'), robots.trim().split('\n').join(' | '));

const sitemap = existsSync(join(ROOT, 'sitemap.xml')) ? readFileSync(join(ROOT, 'sitemap.xml'), 'utf8') : '';
check('sitemap.xml lista a URL canonica',
  sitemap.includes(`<loc>${SITE}</loc>`) && /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sitemap),
  (/<lastmod>(.*?)<\/lastmod>/.exec(sitemap) || [, '?'])[1]);

// a pagina de erro precisa existir na raiz: e a ausencia dela que faz o Cloudflare
// Pages responder 200 com a home para qualquer caminho (modo SPA)
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
    texto: (document.querySelector('h1') || {}).textContent || '',
    altura: document.querySelector('.card') ? document.querySelector('.card').offsetHeight : 0,
    estiloExterno: document.querySelectorAll('link[rel="stylesheet"]').length
  });
})()`));
check('404.html fora do indice e com volta para a home',
  /noindex/.test(page404.robots) && page404.home === '/' &&
  page404.altura > 200 && page404.estiloExterno === 0 &&
  /n\u00e3o existe/.test(page404.texto),
  `${page404.robots}, ${page404.altura}px de altura`);

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} testes passaram`);

ws.close();
chrome.kill();
rmSync(WORK, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
