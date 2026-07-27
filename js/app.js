/*
 * app.js - UI: JSON input, zoom/pan, tooltips and SVG/PNG export.
 */
(function (global) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var STORAGE_KEY = 've-last-json';
  var THEME_KEY = 've-theme';

  var el = {
    input: document.getElementById('json-input'),
    render: document.getElementById('btn-render'),
    format: document.getElementById('btn-format'),
    clear: document.getElementById('btn-clear'),
    status: document.getElementById('status'),
    samples: document.getElementById('samples'),
    legend: document.getElementById('legend'),
    legendTitle: document.getElementById('legend-title'),
    optCost: document.getElementById('opt-cost'),
    optTooltip: document.getElementById('opt-tooltip'),
    optAuto: document.getElementById('opt-auto'),
    wrap: document.getElementById('canvas-wrap'),
    svg: document.getElementById('diagram'),
    viewport: document.getElementById('viewport'),
    content: document.getElementById('content'),
    hits: document.getElementById('hits'),
    empty: document.getElementById('empty-state'),
    tooltip: document.getElementById('tooltip'),
    zoomLabel: document.getElementById('zoom-label'),
    zoomIn: document.getElementById('btn-zoom-in'),
    zoomOut: document.getElementById('btn-zoom-out'),
    fit: document.getElementById('btn-fit'),
    reset: document.getElementById('btn-reset'),
    copy: document.getElementById('btn-copy'),
    png: document.getElementById('btn-png'),
    svgDl: document.getElementById('btn-svg'),
    theme: document.getElementById('btn-theme')
  };

  var state = {
    ctx: null,
    nodes: [],
    size: [0, 0],
    scale: 1,
    tx: 0,
    ty: 0,
    dialect: null
  };

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  function setStatus(msg, kind) {
    el.status.textContent = msg || '';
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 250);
    }, 1800);
  }

  function cssColor(c) {
    return 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' +
      Math.round(c[2] * 255) + ')';
  }

  function timestamp() {
    var d = new Date();
    function p(v) { return String(v).padStart(2, '0'); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ------------------------------------------------------------------ *
   * Input: normalize whatever was pasted
   * ------------------------------------------------------------------ */

  /**
   * Extracts the first complete JSON object/array from the text, ignoring
   * whatever comes before (e.g. "EXPLAIN: ") and after (e.g. "1 row in set").
   */
  function extractJson(text) {
    var start = -1, open = '', close = '';
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (c === '{' || c === '[') {
        start = i;
        open = c;
        close = c === '{' ? '}' : ']';
        break;
      }
    }
    if (start < 0) return text.trim();

    var depth = 0, inString = false, escaped = false;
    for (var j = start; j < text.length; j++) {
      var ch = text.charAt(j);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return text.slice(start, j + 1);
      }
    }
    return text.slice(start);
  }

  /** Cleans up psql's aligned output: pipes and the "+" continuation marker. */
  function cleanPsql(text) {
    return text.split('\n').map(function (l) {
      return l.replace(/^\s*\|/, '').replace(/\s*\+\s*$/, '');
    }).join('\n');
  }

  /** MySQL: object with query_block. PostgreSQL: array (or object) with Plan. */
  function detectDialect(data) {
    if (data && typeof data === 'object') {
      if (data.query_block) return 'mysql';
      var root = Array.isArray(data) ? data[0] : data;
      if (root && typeof root === 'object' && root.Plan) return 'postgres';
    }
    return null;
  }

  /** Some clients return the JSON inside a column: { "EXPLAIN": "{...}" }. */
  function unwrap(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) {
      var v = data[keys[i]];
      if (typeof v === 'string' && /query_block|"Plan"/.test(v)) {
        try {
          var parsed = JSON.parse(v);
          if (detectDialect(parsed)) return parsed;
        } catch (e) { /* segue tentando */ }
      }
      if (v && typeof v === 'object' && detectDialect(v)) return v;
    }
    return null;
  }

  function parseInput(text) {
    var trimmed = text.trim();
    if (!trimmed) throw new Error('Paste the EXPLAIN output in JSON.');

    // command line clients bring headers, pipes and footers along with the JSON
    var candidate = extractJson(trimmed);

    var data;
    try {
      data = JSON.parse(candidate);
    } catch (e) {
      try {
        data = JSON.parse(extractJson(cleanPsql(trimmed)));
      } catch (e2) {
        throw new Error('Invalid JSON: ' + e.message);
      }
    }

    // JSON nested inside a string (as in the old Flask endpoint)
    var guard = 0;
    while (typeof data === 'string' && guard++ < 3) data = JSON.parse(data);

    var dialect = detectDialect(data);
    if (!dialect) {
      var inner = unwrap(data);
      if (inner) {
        data = inner;
        dialect = detectDialect(data);
      }
    }

    if (!dialect) {
      throw new Error('Unrecognized JSON: missing "query_block" (MySQL) or "Plan" ' +
        '(PostgreSQL). Use EXPLAIN FORMAT=JSON or EXPLAIN (FORMAT JSON).');
    }
    return { data: data, dialect: dialect };
  }

  /* ------------------------------------------------------------------ *
   * Diagram generation
   * ------------------------------------------------------------------ */

  function clearDiagram() {
    el.content.textContent = '';
    el.hits.textContent = '';
    state.ctx = null;
    state.nodes = [];
    state.size = [0, 0];
    el.empty.hidden = false;
    hideTooltip();
    setExportEnabled(false);
  }

  function setExportEnabled(enabled) {
    [el.copy, el.png, el.svgDl, el.fit, el.reset, el.zoomIn, el.zoomOut].forEach(function (b) {
      b.disabled = !enabled;
    });
  }

  function renderDiagram(text, opts) {
    opts = opts || {};
    var parsed;
    try {
      parsed = parseInput(text);
    } catch (e) {
      if (!opts.quiet) setStatus(e.message, 'error');
      return false;
    }

    var Context = parsed.dialect === 'postgres'
      ? global.VE.PgExplainContext : global.VE.ExplainContext;

    var ctx;
    try {
      ctx = new Context(parsed.data, {
        displayed_cost_info: el.optCost.checked ? 'read_eval_cost' : null
      });
      if (!ctx._root) throw new Error('Could not read the EXPLAIN JSON.');
      ctx.layout();
    } catch (e) {
      setStatus('Error building the diagram: ' + e.message, 'error');
      return false;
    }

    setDialect(parsed.dialect);

    el.content.textContent = '';
    el.hits.textContent = '';
    ctx.render(el.content);

    state.ctx = ctx;
    state.size = ctx.size;
    state.nodes = ctx.collectNodes();
    buildHitAreas();

    el.empty.hidden = true;
    setExportEnabled(true);

    var msg = DIALECTS[parsed.dialect].name + ' - ' + state.nodes.length + ' nodes - ' +
      ctx.size[0] + ' x ' + ctx.size[1] + ' px';
    if (ctx.warnings.length) {
      msg += ' - ' + ctx.warnings.length + ' warning(s): ' + ctx.warnings.slice(0, 3).join('; ');
      setStatus(msg, '');
    } else {
      setStatus(msg, 'ok');
    }

    if (opts.keepView) applyTransform();
    else fitToScreen();
    return true;
  }

  function buildHitAreas() {
    // the areas follow the same offset the crop applies to the drawing
    var offset = (state.ctx && state.ctx.offset) || [0, 0];
    el.hits.setAttribute('transform', 'translate(' + offset[0] + ',' + offset[1] + ')');

    if (!el.optTooltip.checked) return;
    var frag = document.createDocumentFragment();
    state.nodes.forEach(function (entry, index) {
      var node = entry.node;
      if (!node._figure) return;
      var r = global.VE.nodeRect(node);
      if (!(r.w > 0 && r.h > 0)) return;
      var rect = document.createElementNS(SVGNS, 'rect');
      rect.setAttribute('class', 'hit-rect');
      rect.setAttribute('x', r.x);
      rect.setAttribute('y', r.y);
      rect.setAttribute('width', r.w);
      rect.setAttribute('height', r.h);
      rect.setAttribute('rx', 3);
      rect.setAttribute('data-index', index);
      frag.appendChild(rect);
    });
    el.hits.appendChild(frag);
  }

  /* ------------------------------------------------------------------ *
   * Zoom e pan
   * ------------------------------------------------------------------ */

  function applyTransform() {
    el.viewport.setAttribute('transform',
      'translate(' + state.tx + ',' + state.ty + ') scale(' + state.scale + ')');
    el.zoomLabel.textContent = Math.round(state.scale * 100) + '%';
  }

  function fitToScreen() {
    if (!state.size[0]) return;
    var w = el.wrap.clientWidth, h = el.wrap.clientHeight;
    var margin = 32;
    var scale = Math.min((w - margin) / state.size[0], (h - margin) / state.size[1], 1);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    state.scale = scale;
    state.tx = (w - state.size[0] * scale) / 2;
    state.ty = (h - state.size[1] * scale) / 2;
    applyTransform();
  }

  function zoomAt(factor, cx, cy) {
    var next = Math.min(Math.max(state.scale * factor, 0.05), 8);
    var k = next / state.scale;
    state.tx = cx - (cx - state.tx) * k;
    state.ty = cy - (cy - state.ty) * k;
    state.scale = next;
    applyTransform();
  }

  function setupInteractions() {
    el.wrap.addEventListener('wheel', function (ev) {
      if (!state.ctx) return;
      ev.preventDefault();
      var rect = el.wrap.getBoundingClientRect();
      var factor = Math.pow(0.999, ev.deltaY * (ev.deltaMode === 1 ? 16 : 1));
      zoomAt(factor, ev.clientX - rect.left, ev.clientY - rect.top);
    }, { passive: false });

    var dragging = false, lastX = 0, lastY = 0;

    el.wrap.addEventListener('pointerdown', function (ev) {
      if (!state.ctx || ev.button !== 0) return;
      dragging = true;
      lastX = ev.clientX;
      lastY = ev.clientY;
      el.wrap.classList.add('panning');
      el.wrap.setPointerCapture(ev.pointerId);
      hideTooltip();
    });

    el.wrap.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      state.tx += ev.clientX - lastX;
      state.ty += ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      applyTransform();
    });

    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (type) {
      el.wrap.addEventListener(type, function (ev) {
        if (!dragging) return;
        dragging = false;
        el.wrap.classList.remove('panning');
        if (el.wrap.hasPointerCapture && el.wrap.hasPointerCapture(ev.pointerId)) {
          el.wrap.releasePointerCapture(ev.pointerId);
        }
      });
    });

    el.wrap.addEventListener('dblclick', function () { fitToScreen(); });

    el.zoomIn.addEventListener('click', function () {
      zoomAt(1.2, el.wrap.clientWidth / 2, el.wrap.clientHeight / 2);
    });
    el.zoomOut.addEventListener('click', function () {
      zoomAt(1 / 1.2, el.wrap.clientWidth / 2, el.wrap.clientHeight / 2);
    });
    el.fit.addEventListener('click', fitToScreen);
    el.reset.addEventListener('click', function () {
      var k = 1 / state.scale;
      zoomAt(k, el.wrap.clientWidth / 2, el.wrap.clientHeight / 2);
    });
  }

  /* ------------------------------------------------------------------ *
   * Tooltip
   * ------------------------------------------------------------------ */

  function hideTooltip() {
    el.tooltip.hidden = true;
    el.tooltip.textContent = '';
  }

  function buildTooltip(text) {
    el.tooltip.textContent = '';
    var buffer = [];

    function flush() {
      var body = buffer.join('\n').replace(/\n+$/, '');
      buffer = [];
      if (!body.trim()) return;
      var p = document.createElement('p');
      p.className = 't-body';
      p.textContent = body;
      el.tooltip.appendChild(p);
    }

    text.split('\n').forEach(function (line) {
      if (line.charAt(0) === '*') {
        flush();
        var h = document.createElement('div');
        h.className = 't-head';
        h.textContent = line.slice(1).trim();
        el.tooltip.appendChild(h);
      } else {
        buffer.push(line);
      }
    });
    flush();
  }

  function showTooltipFor(index, ev) {
    var entry = state.nodes[index];
    if (!entry) return;
    var text = entry.node.get_hint_text ? entry.node.get_hint_text() : null;
    if (!text) return;

    buildTooltip(text);
    el.tooltip.hidden = false;
    positionTooltip(ev);
  }

  function positionTooltip(ev) {
    var pad = 16;
    var rect = el.tooltip.getBoundingClientRect();
    var x = ev.clientX + pad;
    var y = ev.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = ev.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    el.tooltip.style.left = x + 'px';
    el.tooltip.style.top = y + 'px';
  }

  function setupTooltip() {
    el.hits.addEventListener('mouseover', function (ev) {
      if (!el.optTooltip.checked) return;
      var target = ev.target;
      if (!target.classList || !target.classList.contains('hit-rect')) return;
      showTooltipFor(parseInt(target.getAttribute('data-index'), 10), ev);
    });
    el.hits.addEventListener('mousemove', function (ev) {
      if (!el.tooltip.hidden) positionTooltip(ev);
    });
    el.hits.addEventListener('mouseout', function (ev) {
      var target = ev.target;
      if (target.classList && target.classList.contains('hit-rect')) hideTooltip();
    });
  }

  /* ------------------------------------------------------------------ *
   * Export
   * ------------------------------------------------------------------ */

  function buildStandaloneSvg() {
    if (!state.ctx) return null;
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('xmlns', SVGNS);
    svg.setAttribute('version', '1.1');
    svg.setAttribute('width', state.size[0]);
    svg.setAttribute('height', state.size[1]);
    svg.setAttribute('viewBox', '0 0 ' + state.size[0] + ' ' + state.size[1]);
    var clone = el.content.cloneNode(true);
    clone.removeAttribute('id');
    svg.appendChild(clone);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      new XMLSerializer().serializeToString(svg);
  }

  function exportSvg() {
    var text = buildStandaloneSvg();
    if (!text) return;
    download(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }),
      'explain-' + timestamp() + '.svg');
  }

  function exportPng() {
    var text = buildStandaloneSvg();
    if (!text) return;
    var scale = 2;
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(state.size[0] * scale);
      canvas.height = Math.round(state.size[1] * scale);
      var c = canvas.getContext('2d');
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        if (blob) download(blob, 'explain-' + timestamp() + '.png');
        else setStatus('Could not generate the PNG in this browser.', 'error');
      }, 'image/png');
    };
    img.onerror = function () {
      setStatus('Could not convert the SVG to PNG.', 'error');
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  }

  function copySvg() {
    var text = buildStandaloneSvg();
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('SVG copied to the clipboard');
      }, function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('SVG copied to the clipboard');
    } catch (e) {
      setStatus('Could not copy automatically.', 'error');
    }
    ta.remove();
  }

  /* ------------------------------------------------------------------ *
   * Side panel
   * ------------------------------------------------------------------ */

  var DIALECTS = {
    mysql: {
      name: 'MySQL',
      command: 'EXPLAIN FORMAT=JSON <your query>;',
      legendTitle: 'Legend (access cost)',
      legend: function () {
        return global.VE.nodes.COL_JOIN_TYPES
          .filter(function (e) { return e[0] !== 'UNKNOWN'; })
          .map(function (e) { return [e[0], e[1], e[2].split('\n').join(' ')]; });
      }
    },
    postgres: {
      name: 'PostgreSQL',
      command: 'EXPLAIN (FORMAT JSON, ANALYZE) <your query>;',
      legendTitle: 'Legend (node types)',
      legend: function () {
        return global.VE.pgNodes.legend().map(function (e) { return [e[0], e[1], '']; });
      }
    }
  };

  /** Legend and its title follow the detected dialect. */
  function setDialect(dialect) {
    if (state.dialect === dialect) return;
    state.dialect = dialect;

    var info = DIALECTS[dialect];
    el.legendTitle.textContent = info.legendTitle;
    el.legend.textContent = '';

    var seen = {};
    info.legend().forEach(function (entry) {
      var key = entry[0], color = entry[1], label = entry[2];
      var id = (label || key) + '|' + cssColor(color);
      if (seen[id]) {
        seen[id].keys.push(key);
        seen[id].node.querySelector('.key').textContent = seen[id].keys.join(', ');
        return;
      }
      var li = document.createElement('li');
      var sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = cssColor(color);
      var txt = document.createElement('span');
      txt.textContent = label || key;
      var k = document.createElement('span');
      k.className = 'key';
      k.textContent = label ? key : '';
      li.appendChild(sw);
      li.appendChild(txt);
      li.appendChild(k);
      el.legend.appendChild(li);
      seen[id] = { keys: [key], node: li };
    });
  }

  function buildSamples() {
    Object.keys(DIALECTS).forEach(function (dialect) {
      var group = global.VE.samples.filter(function (s) { return s.dialect === dialect; });
      if (!group.length) return;

      var title = document.createElement('p');
      title.className = 'chip-group';
      title.textContent = DIALECTS[dialect].name;
      el.samples.appendChild(title);

      var row = document.createElement('div');
      row.className = 'chips';
      group.forEach(function (sample) {
        var b = document.createElement('button');
        b.className = 'chip';
        b.type = 'button';
        b.textContent = sample.name;
        b.title = sample.sql;
        b.addEventListener('click', function () {
          clearActiveSample();
          b.classList.add('active');
          el.input.value = JSON.stringify(sample.json, null, 2);
          persist();
          renderDiagram(el.input.value);
        });
        row.appendChild(b);
      });
      el.samples.appendChild(row);
    });
  }

  function clearActiveSample() {
    Array.prototype.forEach.call(el.samples.querySelectorAll('.chip'), function (c) {
      c.classList.remove('active');
    });
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, el.input.value); } catch (e) { /* ignora */ }
  }

  /* ------------------------------------------------------------------ *
   * Theme
   * ------------------------------------------------------------------ */

  function setupTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* ignora */ }
    if (saved) document.documentElement.setAttribute('data-theme', saved);

    el.theme.addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme');
      if (!current) {
        var prefersDark = window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: dark)').matches;
        current = prefersDark ? 'dark' : 'light';
      }
      var next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignora */ }
    });
  }

  /* ------------------------------------------------------------------ *
   * Startup
   * ------------------------------------------------------------------ */

  function setupEvents() {
    var timer = null;
    el.input.addEventListener('input', function () {
      persist();
      if (!el.optAuto.checked) return;
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (el.input.value.trim()) renderDiagram(el.input.value, { quiet: true });
        else { clearDiagram(); setStatus(''); }
      }, 450);
    });

    el.input.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        renderDiagram(el.input.value);
      }
    });

    el.render.addEventListener('click', function () { renderDiagram(el.input.value); });

    el.clear.addEventListener('click', function () {
      el.input.value = '';
      persist();
      clearDiagram();
      setStatus('');
      clearActiveSample();
    });

    el.format.addEventListener('click', function () {
      try {
        el.input.value = JSON.stringify(parseInput(el.input.value).data, null, 2);
        persist();
        setStatus('JSON formatted.', 'ok');
      } catch (e) {
        setStatus(e.message, 'error');
      }
    });

    el.optCost.addEventListener('change', function () {
      if (state.ctx) renderDiagram(el.input.value, { keepView: true });
    });

    el.optTooltip.addEventListener('change', function () {
      if (!state.ctx) return;
      el.hits.textContent = '';
      if (el.optTooltip.checked) buildHitAreas();
      else hideTooltip();
    });

    el.copy.addEventListener('click', copySvg);
    el.png.addEventListener('click', exportPng);
    el.svgDl.addEventListener('click', exportSvg);

    window.addEventListener('resize', function () {
      if (!state.ctx) return;
      applyTransform();
    });
  }

  function init() {
    buildSamples();
    setDialect('mysql');
    setupEvents();
    setupInteractions();
    setupTooltip();
    setupTheme();
    setExportEnabled(false);

    var saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignora */ }

    if (saved && saved.trim()) {
      el.input.value = saved;
      renderDiagram(saved, { quiet: true });
    } else {
      var chips = el.samples.querySelectorAll('.chip');
      if (chips.length > 1) chips[1].click();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
