/*
 * graphics.js - camada grafica (medicao de texto, contexto tipo cairo que emite SVG
 * e as figuras basicas: caixas, diamantes, textos).
 *
 * Porte client-side do renderer do MySQL Workbench (Visual Explain).
 * Original: Copyright (c) 2012, 2021, Oracle and/or its affiliates - GPL v2.
 */
(function (global) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var FONT_STACK = 'Helvetica, Arial, "Liberation Sans", "Nimbus Sans", sans-serif';

  /* ------------------------------------------------------------------ *
   * Medicao de texto (equivalente a cairo_text_extents)
   * ------------------------------------------------------------------ */

  var measureCanvas = document.createElement('canvas');
  var measureCtx = measureCanvas.getContext('2d');
  var extentsCache = new Map();

  function num(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }

  function fontSpec(size, bold) {
    return (bold ? 'bold ' : '') + size + 'px ' + FONT_STACK;
  }

  /**
   * Devolve extents no mesmo formato do cairo:
   * x_bearing, y_bearing, width, height (tinta), x_advance, y_advance.
   */
  function textExtents(text, size, bold) {
    var key = size + '|' + (bold ? 1 : 0) + '|' + text;
    var cached = extentsCache.get(key);
    if (cached) return cached;

    measureCtx.font = fontSpec(size, bold);
    var m = measureCtx.measureText(text);
    var ascent = num(m.actualBoundingBoxAscent, size * 0.75);
    var descent = num(m.actualBoundingBoxDescent, size * 0.25);
    var left = num(m.actualBoundingBoxLeft, 0);
    var right = num(m.actualBoundingBoxRight, m.width);

    var ext = {
      x_bearing: -left,
      y_bearing: -ascent,
      width: left + right,
      height: ascent + descent,
      x_advance: m.width,
      y_advance: 0
    };
    extentsCache.set(key, ext);
    return ext;
  }

  /* ------------------------------------------------------------------ *
   * Contexto de desenho: mesma API usada pelo renderer original (cairo),
   * porem emitindo elementos SVG.
   * ------------------------------------------------------------------ */

  function fmt(v) {
    return Math.round(v * 100) / 100;
  }

  function rgb(state) {
    return 'rgb(' + Math.round(state.r * 255) + ',' + Math.round(state.g * 255) + ',' +
      Math.round(state.b * 255) + ')';
  }

  function SvgContext(group) {
    this.group = group;
    this.state = {
      tx: 0, ty: 0, sx: 1, sy: 1,
      r: 0, g: 0, b: 0, a: 1,
      lineWidth: 1,
      dash: null, dashOffset: 0,
      fontSize: 12, bold: false
    };
    this.stack = [];
    this.path = [];
  }

  SvgContext.prototype.save = function () {
    this.stack.push(Object.assign({}, this.state));
  };

  SvgContext.prototype.restore = function () {
    if (this.stack.length) this.state = this.stack.pop();
  };

  SvgContext.prototype.translate = function (x, y) {
    this.state.tx += x * this.state.sx;
    this.state.ty += y * this.state.sy;
  };

  SvgContext.prototype.scale = function (sx, sy) {
    this.state.sx *= sx;
    this.state.sy *= sy;
  };

  SvgContext.prototype._x = function (x) { return fmt(this.state.tx + x * this.state.sx); };
  SvgContext.prototype._y = function (y) { return fmt(this.state.ty + y * this.state.sy); };

  SvgContext.prototype.set_source_rgba = function (r, g, b, a) {
    this.state.r = r; this.state.g = g; this.state.b = b;
    this.state.a = a === undefined ? 1 : a;
  };

  SvgContext.prototype.set_source_rgb = function (r, g, b) {
    this.set_source_rgba(r, g, b, 1);
  };

  SvgContext.prototype.set_line_width = function (w) { this.state.lineWidth = w; };

  SvgContext.prototype.set_dash = function (dash, offset) {
    this.state.dash = dash && dash.length ? dash.slice() : null;
    this.state.dashOffset = offset || 0;
  };

  SvgContext.prototype.set_font = function (family, italic, bold) {
    this.state.bold = !!bold;
  };

  SvgContext.prototype.set_font_size = function (size) { this.state.fontSize = size; };

  SvgContext.prototype.text_extents = function (text) {
    return textExtents(text, this.state.fontSize, this.state.bold);
  };

  SvgContext.prototype.new_path = function () { this.path = []; };
  SvgContext.prototype.new_sub_path = function () { /* nada a fazer no SVG */ };

  SvgContext.prototype.move_to = function (x, y) {
    this.path.push('M' + this._x(x) + ' ' + this._y(y));
  };

  SvgContext.prototype.line_to = function (x, y) {
    if (!this.path.length) return this.move_to(x, y);
    this.path.push('L' + this._x(x) + ' ' + this._y(y));
  };

  SvgContext.prototype.curve_to = function (x1, y1, x2, y2, x3, y3) {
    this.path.push('C' + this._x(x1) + ' ' + this._y(y1) + ' ' + this._x(x2) + ' ' +
      this._y(y2) + ' ' + this._x(x3) + ' ' + this._y(y3));
  };

  SvgContext.prototype.close_path = function () { this.path.push('Z'); };

  SvgContext.prototype.rectangle = function (x, y, w, h) {
    this.move_to(x, y);
    this.line_to(x + w, y);
    this.line_to(x + w, y + h);
    this.line_to(x, y + h);
    this.close_path();
  };

  SvgContext.prototype.rounded_rect = function (x, y, w, h, r) {
    this.move_to(x + r, y);
    this.line_to(x + w - r, y);
    this.curve_to(x + w, y, x + w, y, x + w, y + r);
    this.line_to(x + w, y + h - r);
    this.curve_to(x + w, y + h, x + w, y + h, x + w - r, y + h);
    this.line_to(x + r, y + h);
    this.curve_to(x, y + h, x, y + h, x, y + h - r);
    this.line_to(x, y + r);
    this.curve_to(x, y, x, y, x + r, y);
  };

  SvgContext.prototype._pathElement = function () {
    var el = document.createElementNS(SVGNS, 'path');
    el.setAttribute('d', this.path.join(' '));
    return el;
  };

  SvgContext.prototype.fill_preserve = function () {
    if (!this.path.length) return;
    var el = this._pathElement();
    el.setAttribute('fill', rgb(this.state));
    if (this.state.a < 1) el.setAttribute('fill-opacity', fmt(this.state.a));
    el.setAttribute('stroke', 'none');
    this.group.appendChild(el);
  };

  SvgContext.prototype.fill = function () {
    this.fill_preserve();
    this.new_path();
  };

  SvgContext.prototype.stroke_preserve = function () {
    if (!this.path.length) return;
    var el = this._pathElement();
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', rgb(this.state));
    if (this.state.a < 1) el.setAttribute('stroke-opacity', fmt(this.state.a));
    el.setAttribute('stroke-width', fmt(this.state.lineWidth * this.state.sx));
    if (this.state.dash) {
      el.setAttribute('stroke-dasharray', this.state.dash.map(fmt).join(' '));
      if (this.state.dashOffset) el.setAttribute('stroke-dashoffset', fmt(this.state.dashOffset));
    }
    this.group.appendChild(el);
  };

  SvgContext.prototype.stroke = function () {
    this.stroke_preserve();
    this.new_path();
  };

  SvgContext.prototype.show_text = function (text) {
    if (text === null || text === undefined || text === '') return;
    // o desenho usa sempre move_to imediatamente antes de show_text
    var last = this.path[this.path.length - 1];
    if (!last || last[0] !== 'M') return;
    var coords = last.substring(1).split(' ');
    var el = document.createElementNS(SVGNS, 'text');
    el.setAttribute('x', coords[0]);
    el.setAttribute('y', coords[1]);
    el.setAttribute('font-family', FONT_STACK);
    el.setAttribute('font-size', fmt(this.state.fontSize * this.state.sx));
    if (this.state.bold) el.setAttribute('font-weight', 'bold');
    el.setAttribute('fill', rgb(this.state));
    if (this.state.a < 1) el.setAttribute('fill-opacity', fmt(this.state.a));
    el.setAttribute('xml:space', 'preserve');
    el.textContent = text;
    this.group.appendChild(el);
    this.new_path();
  };

  /* ------------------------------------------------------------------ *
   * Setas
   * ------------------------------------------------------------------ */

  function draw_varrow(cr, tip, ah, aw) {
    ah = ah === undefined ? 4 : ah;
    aw = aw === undefined ? 4 : aw;
    cr.new_path();
    var x = tip[0], y = tip[1];
    cr.move_to(x, y);
    cr.line_to(x - aw / 2, y + ah - 0.5);
    cr.line_to(x + aw / 2, y + ah - 0.5);
    cr.close_path();
  }

  function draw_harrow(cr, tip, ah, aw) {
    ah = ah === undefined ? 4 : ah;
    aw = aw === undefined ? 4 : aw;
    cr.new_path();
    var x = tip[0], y = tip[1];
    cr.move_to(x, y);
    cr.line_to(x - ah - 0.5, y - aw / 2);
    cr.line_to(x - ah - 0.5, y + aw / 2);
    cr.close_path();
  }

  /* ------------------------------------------------------------------ *
   * Figuras
   * ------------------------------------------------------------------ */

  var HFill = 1 << 0;
  var VFill = 1 << 1;

  function Element_() {
    this.parent = null;
    this._layout_dirty = false;
    this._color = [0, 0, 0, 1];
  }

  Element_.prototype.do_relayout = function (cr) { };
  Element_.prototype.render = function (cr) { };
  Element_.prototype.invalidate = function () { };
  Element_.prototype.set_color = function (r, g, b, a) {
    this._color = [r, g, b, a === undefined ? 1 : a];
  };

  function Figure() {
    Element_.call(this);
    this._x = 0;
    this._y = 0;
    this._width = 0;
    this._height = 0;
    this._uwidth = null;
    this._uheight = null;
    this._fill_color = [1, 1, 1, 1];
    this._line_width = 1;
    this._dash = [null, null];
    this._padding = [0, 0, 0, 0]; // t, l, b, r
    this._layout_flags = HFill | VFill;
  }
  Figure.prototype = Object.create(Element_.prototype);
  Figure.prototype.constructor = Figure;

  Object.defineProperties(Figure.prototype, {
    x: { get: function () { return this._x; } },
    y: { get: function () { return this._y; } },
    root_x: { get: function () { return this.x + (this.parent ? this.parent.root_x : 0); } },
    root_y: { get: function () { return this.y + (this.parent ? this.parent.root_y : 0); } },
    width: { get: function () { return this._uwidth === null ? this._width : this._uwidth; } },
    height: { get: function () { return this._uheight === null ? this._height : this._uheight; } },
    pos: { get: function () { return [this._x, this._y]; } },
    size: { get: function () { return [this.width, this.height]; } },
    bounds: { get: function () { return [0, 0, this.width, this.height]; } },
    frame: { get: function () { return [this.x, this.y, this.width, this.height]; } },
    padding_top: { get: function () { return this._padding[0]; } },
    padding_left: { get: function () { return this._padding[1]; } },
    padding_bottom: { get: function () { return this._padding[2]; } },
    padding_right: { get: function () { return this._padding[3]; } }
  });

  Figure.prototype.move = function (x, y) { this._x = x; this._y = y; };
  Figure.prototype.set_padding = function (t, l, b, r) { this._padding = [t, l, b, r]; };
  Figure.prototype.set_layout_flags = function (flags) { this._layout_flags = flags; };
  Figure.prototype.set_line_dash = function (dash, offset) { this._dash = [dash, offset]; };
  Figure.prototype.set_line_width = function (w) { this._line_width = w; };
  Figure.prototype.set_fill_color = function (r, g, b, a) {
    this._fill_color = [r, g, b, a === undefined ? 1 : a];
  };
  Figure.prototype.set_usize = function (w, h) { this._uwidth = w; this._uheight = h; };
  Figure.prototype.apply_attributes = function (c) {
    c.set_source_rgba.apply(c, this._color);
    if (this._dash[0]) c.set_dash(this._dash[0], this._dash[1]);
    c.set_line_width(this._line_width);
  };
  Figure.prototype.apply_fill_attributes = function (c) {
    c.set_source_rgba.apply(c, this._fill_color);
  };

  function Container() {
    Figure.call(this);
    this._items = [];
  }
  Container.prototype = Object.create(Figure.prototype);
  Container.prototype.constructor = Container;

  Container.prototype.add = function (item) {
    item.parent = this;
    this._items.push(item);
  };

  Container.prototype.render = function (cr) {
    cr.save();
    cr.translate(this.x, this.y);
    for (var i = 0; i < this._items.length; i++) this._items[i].render(cr);
    cr.restore();
  };

  function VBoxFigure() {
    Container.call(this);
    this._spacing = 0;
  }
  VBoxFigure.prototype = Object.create(Container.prototype);
  VBoxFigure.prototype.constructor = VBoxFigure;

  VBoxFigure.prototype.set_spacing = function (sp) { this._spacing = sp; };

  VBoxFigure.prototype.do_relayout = function (cr) {
    var lp = this._padding[0], tp = this._padding[1];
    var rp = this._padding[2], bp = this._padding[3];
    var y = tp;
    var x = lp;
    var max_width = this._width;
    var i, item;

    for (i = 0; i < this._items.length; i++) {
      item = this._items[i];
      item.do_relayout(cr);
      item.move(x, y);
      max_width = Math.max(max_width, item.width);
      y += Math.trunc(item.height) + this._spacing;
    }
    if (this._items.length) y -= this._spacing;

    for (i = 0; i < this._items.length; i++) {
      item = this._items[i];
      if (item._layout_flags & HFill) {
        item.set_usize(max_width, item._uheight);
        item.do_relayout(cr);
      } else {
        item.move((max_width - item.width) / 2, item.y);
      }
    }

    this._width = max_width + lp + rp;
    this._height = y + bp;
  };

  function TextFigure(text) {
    Figure.call(this);
    this._text = text === undefined ? '' : text;
    this._font_size = 12;
    this._text_color = [0, 0, 0, 1];
    this._line_spacing = 2;
    this._bold = false;
    this._xalignment = 0.0;
    this._yalignment = 0.0;
    this._line_height = 14;
    this._text_height = 0;
  }
  TextFigure.prototype = Object.create(Figure.prototype);
  TextFigure.prototype.constructor = TextFigure;

  TextFigure.prototype.set_text_color = function (r, g, b, a) {
    this._text_color = [r, g, b, a === undefined ? 1 : a];
  };
  TextFigure.prototype.set_font_size = function (s) { this._font_size = s; };
  TextFigure.prototype.set_font_bold = function (s) { this._bold = s; };
  TextFigure.prototype.set_alignment = function (x, y) {
    this._xalignment = x;
    this._yalignment = y;
  };
  TextFigure.prototype.set_text = function (text) { this._text = text; };

  TextFigure.prototype.do_relayout = function (ctx) {
    ctx.save();
    ctx.set_font(null, false, this._bold);
    ctx.set_font_size(this._font_size);

    var t = this._padding[0], l = this._padding[1];
    var b = this._padding[2], r = this._padding[3];

    if (this._text.indexOf('\n') >= 0) {
      var lines = this._text.split('\n');
      var w = 0, lh = 0;
      this._text_height = 0;
      for (var i = 0; i < lines.length; i++) {
        var ext = ctx.text_extents(lines[i]);
        w = Math.max(w, Math.trunc(ext.x_bearing + ext.x_advance));
        lh = Math.max(lh, Math.trunc(ext.height + ext.height + ext.y_bearing));
        this._text_height += ext.height + this._line_spacing;
      }
      if (lines.length) this._text_height -= this._line_spacing;
      this._line_height = Math.trunc(lh);
      this._width = w + r + l;
      this._height = this._text_height + t + b;
    } else {
      var e = ctx.text_extents(this._text);
      this._extents = e;
      this._line_height = Math.trunc(e.height) + Math.trunc(e.height + e.y_bearing);
      this._width = Math.trunc(e.x_bearing + e.x_advance) + r + l;
      this._height = this._line_height + t + b;
      this._text_height = this._line_height;
    }
    ctx.restore();
  };

  TextFigure.prototype.render = function (ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.set_source_rgba.apply(ctx, this._text_color);
    ctx.set_font(null, false, this._bold);
    ctx.set_font_size(this._font_size);

    var t = this._padding[0], l = this._padding[1];
    var b = this._padding[2], r = this._padding[3];

    var x = Math.trunc(l) + 0.5;
    var y = Math.trunc(t) + 0.5 +
      Math.trunc((this.height - t - b - this._text_height) * this._yalignment);

    var lines = this._text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var extents = ctx.text_extents(lines[i]);
      ctx.move_to(
        x + Math.trunc((this.width - l - r - extents.width) * this._xalignment),
        y + Math.trunc(extents.height - (extents.height + extents.y_bearing))
      );
      ctx.show_text(lines[i]);
      y += extents.height + this._line_spacing;
    }
    ctx.restore();
  };

  function ShapeFigure(caption) {
    TextFigure.call(this, caption);
    this.set_alignment(0.5, 0.5);
    this.set_line_width(1);
  }
  ShapeFigure.prototype = Object.create(TextFigure.prototype);
  ShapeFigure.prototype.constructor = ShapeFigure;

  ShapeFigure.prototype.make_path = function (ctx) {
    ctx.rectangle.apply(ctx, this.bounds);
  };

  ShapeFigure.prototype.render = function (ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    this.make_path(ctx);
    this.apply_fill_attributes(ctx);
    ctx.fill_preserve();
    this.apply_attributes(ctx);
    ctx.stroke();
    ctx.restore();

    TextFigure.prototype.render.call(this, ctx);
  };

  function DiamondShapeFigure(caption) { ShapeFigure.call(this, caption); }
  DiamondShapeFigure.prototype = Object.create(ShapeFigure.prototype);
  DiamondShapeFigure.prototype.constructor = DiamondShapeFigure;
  DiamondShapeFigure.prototype.make_path = function (ctx) {
    ctx.move_to(0, this.height / 2);
    ctx.line_to(this.width / 2, 0);
    ctx.line_to(this.width, this.height / 2);
    ctx.line_to(this.width / 2, this.height);
    ctx.close_path();
  };

  function RectangleShapeFigure(caption) {
    ShapeFigure.call(this, caption);
    this._corner_radius = 0;
  }
  RectangleShapeFigure.prototype = Object.create(ShapeFigure.prototype);
  RectangleShapeFigure.prototype.constructor = RectangleShapeFigure;
  RectangleShapeFigure.prototype.set_corner_radius = function (r) { this._corner_radius = r; };
  RectangleShapeFigure.prototype.make_path = function (ctx) {
    if (this._corner_radius === 0) {
      ctx.rectangle(0.5, 0.5, this.width, this.height);
    } else {
      ctx.rounded_rect(0.5, 0.5, this.width, this.height, this._corner_radius);
    }
  };

  global.VE = global.VE || {};
  global.VE.graphics = {
    SVGNS: SVGNS,
    FONT_STACK: FONT_STACK,
    textExtents: textExtents,
    SvgContext: SvgContext,
    draw_varrow: draw_varrow,
    draw_harrow: draw_harrow,
    HFill: HFill,
    VFill: VFill,
    Figure: Figure,
    Container: Container,
    VBoxFigure: VBoxFigure,
    TextFigure: TextFigure,
    ShapeFigure: ShapeFigure,
    DiamondShapeFigure: DiamondShapeFigure,
    RectangleShapeFigure: RectangleShapeFigure
  };
})(window);
