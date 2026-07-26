/*
 * Gera as imagens de compartilhamento e o icone de toque a partir do proprio
 * renderer: o diagrama do cartao e o mesmo SVG que a aplicacao exporta.
 * Nao precisa de dependencias: node >= 22 e o Google Chrome instalado.
 *
 *   node tools/og-image.mjs
 *
 * Escreve og-image.png (1200x630) e apple-touch-icon.png (180x180) na raiz.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = pathToFileURL(join(ROOT, 'index.html')).href;
const WORK = mkdtempSync(join(tmpdir(), 'explain-render-og-'));
const PORT = 9334;

// exemplo que aparece no cartao: mostra tabela, nested loop e ORDER num
// desenho que ainda cabe legivel em 1200x630
const SAMPLE = 'JOIN + ORDER BY';

const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=1400,900',
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

ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: ok, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : ok(msg.result);
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

async function shot(html, width, height, scale, out) {
  const file = join(WORK, out + '.html');
  writeFileSync(file, html);
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: scale, mobile: false
  });
  await send('Page.navigate', { url: pathToFileURL(file).href });
  await sleep(1200);
  const { data } = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale }
  });
  writeFileSync(join(ROOT, out), Buffer.from(data, 'base64'));
  console.log(`${out}  ${width * scale}x${height * scale}  ` +
    `${(Buffer.from(data, 'base64').length / 1024).toFixed(0)} KB`);
}

await send('Runtime.enable');
await send('Page.enable');

// 1. renderiza o exemplo na propria aplicacao e pega o SVG exportado
await send('Page.navigate', { url: APP });
await sleep(2500);

const clicked = await evaluate(`(function () {
  var chips = document.querySelectorAll('#samples .chip');
  for (var i = 0; i < chips.length; i++) {
    if (chips[i].textContent.trim() === ${JSON.stringify(SAMPLE)}) {
      chips[i].click();
      return true;
    }
  }
  return false;
})()`);
if (!clicked) throw new Error(`exemplo "${SAMPLE}" nao encontrado`);
await sleep(600);

const diagram = JSON.parse(await evaluate(`(function () {
  var content = document.getElementById('content');
  var bg = content.querySelector('rect');
  var w = +bg.getAttribute('width'), h = +bg.getAttribute('height');
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  var clone = content.cloneNode(true);
  clone.removeAttribute('id');
  svg.appendChild(clone);
  return JSON.stringify({
    w: w, h: h, svg: new XMLSerializer().serializeToString(svg)
  });
})()`));
console.log(`diagrama: ${SAMPLE}  ${diagram.w}x${diagram.h}`);

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ' +
  '"Helvetica Neue", Arial, sans-serif';

const LOGO = `<svg viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#2f6fb0"/>
  <rect x="6" y="5" width="20" height="7" rx="2" fill="#fff"/>
  <rect x="4" y="20" width="10" height="7" rx="2" fill="#fff" opacity=".85"/>
  <rect x="18" y="20" width="10" height="7" rx="2" fill="#fff" opacity=".85"/>
  <path d="M16 12v4M9 16h14M9 16v4M23 16v4" stroke="#fff" stroke-width="1.8" fill="none"/>
</svg>`;

// 2. cartao 1200x630 para Open Graph / Twitter
const card = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><style>
  * { box-sizing: border-box; }
  body {
    margin: 0; width: 1200px; height: 630px; display: flex;
    font-family: ${FONT}; color: #1b2430;
    background: linear-gradient(135deg, #f7f9fc 0%, #e8eef6 100%);
  }
  .left {
    width: 620px; padding: 66px 24px 58px 68px;
    display: flex; flex-direction: column;
  }
  .brand { display: flex; align-items: center; gap: 20px; }
  .brand svg { width: 66px; height: 66px; flex: none; }
  .brand h1 { margin: 0; font-size: 54px; letter-spacing: -1.4px; font-weight: 700; }
  .tagline {
    margin: 30px 0 0; font-size: 27px; line-height: 1.42;
    color: #46525f; max-width: 490px;
  }
  .tagline b { color: #1b2430; font-weight: 600; }
  /* max-width segura a quebra em 2 + 2, que fica mais equilibrado que 3 + 1 */
  .badges { display: flex; flex-wrap: wrap; gap: 11px; margin-top: 34px; max-width: 365px; }
  .badge {
    font-size: 19px; font-weight: 600; padding: 8px 16px; border-radius: 999px;
    background: #fff; border: 1px solid #d3dce7; color: #46525f;
  }
  .badge.accent { background: #2f6fb0; border-color: #2f6fb0; color: #fff; }
  .url {
    margin-top: auto; font-size: 25px; font-weight: 600; color: #2f6fb0;
    letter-spacing: -.2px;
  }
  .right { flex: 1; display: flex; align-items: center; justify-content: center; padding-right: 60px; }
  .panel {
    background: #fff; border: 1px solid #dde3ea; border-radius: 22px;
    box-shadow: 0 18px 44px rgba(16, 24, 40, .13);
    padding: 30px; display: flex; align-items: center; justify-content: center;
  }
  .panel svg { display: block; width: ${Math.round(diagram.w * 1.22)}px; height: auto; }
</style></head><body>
  <div class="left">
    <div class="brand">${LOGO}<h1>EXPLAIN Render</h1></div>
    <p class="tagline">O plano de execu&ccedil;&atilde;o da sua query, em JSON,
      vira <b>diagrama</b> - e sai em <b>SVG</b>.</p>
    <div class="badges">
      <span class="badge accent">MySQL</span>
      <span class="badge accent">PostgreSQL</span>
      <span class="badge">SVG + PNG</span>
      <span class="badge">100% no navegador</span>
    </div>
    <div class="url">explain-render.matob.dev</div>
  </div>
  <div class="right"><div class="panel">${diagram.svg}</div></div>
</body></html>`;

await shot(card, 1200, 630, 1, 'og-image.png');

// 3. icone de toque: o mesmo logo, sem canto arredondado (iOS aplica a mascara)
const icon = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  body { margin: 0; width: 180px; height: 180px; background: #2f6fb0; }
  svg { display: block; width: 180px; height: 180px; }
  svg > rect:first-child { fill: #2f6fb0; }
</style></head><body>
${LOGO.replace('rx="7"', 'rx="0"')}
</body></html>`;

await shot(icon, 180, 180, 1, 'apple-touch-icon.png');

ws.close();
chrome.kill();
rmSync(WORK, { recursive: true, force: true });
