/*
 * nodes.js - nos do diagrama do EXPLAIN (tabelas, nested loops, operacoes,
 * query blocks, subqueries, materializacoes) com layout e desenho.
 *
 * Porte client-side do renderer do MySQL Workbench (Visual Explain).
 * Original: Copyright (c) 2012, 2021, Oracle and/or its affiliates - GPL v2.
 */
(function (global) {
  'use strict';

  var g = global.VE.graphics;
  var VBoxFigure = g.VBoxFigure;
  var TextFigure = g.TextFigure;
  var RectangleShapeFigure = g.RectangleShapeFigure;
  var DiamondShapeFigure = g.DiamondShapeFigure;
  var draw_varrow = g.draw_varrow;
  var draw_harrow = g.draw_harrow;
  var HFill = g.HFill;

  /* ------------------------------------------------------------------ *
   * Formatacao
   * ------------------------------------------------------------------ */

  function fmtNum(n) {
    var r = Math.round(n * 100) / 100;
    return String(r);
  }

  function fmt_number(c) {
    if (c >= 1000 * 1000 * 1000) return (c / 1e9).toFixed(2) + 'G';
    if (c >= 1000 * 1000) return (c / 1e6).toFixed(2) + 'M';
    if (c >= 1000) return (c / 1000).toFixed(0) + 'K';
    return String(c);
  }

  function fmt_rows(r) {
    if (r === 1) return '1 row';
    if (r > 1000000000) return (r / 1e9).toFixed(2) + 'G rows';
    if (r > 1000000) return (r / 1e6).toFixed(2) + 'M rows';
    if (r > 1000) return (r / 1000).toFixed(2) + 'K rows';
    return fmtNum(r) + ' rows';
  }

  function toNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var f = parseFloat(v);
    return isNaN(f) ? null : f;
  }

  /* ------------------------------------------------------------------ *
   * Cores (0..1 como no cairo)
   * ------------------------------------------------------------------ */

  var BLUE = [0.25, 0.5, 0.75, 1];
  var GREEN = [0.0, 0.5, 0.0, 1];
  var YELLOW = [0.75, 0.75, 0.0, 1];
  var ORANGE = [0.75, 0.5, 0.0, 1];
  var RED = [0.75, 0.25, 0.25, 1];
  var BLACK = [0, 0, 0, 1];

  var COL_JOIN_TYPES = [
    ['system', BLUE, 'Single Row\n(system constant)', 'Very low cost'],
    ['const', BLUE, 'Single Row\n(constant)', 'Very low cost'],
    ['eq_ref', GREEN, 'Unique Key Lookup',
      'Low - The optimizer is able to find an index that it can use to retrieve required records.\n' +
      'Fast because the index search leads directly to the page with all the row data'],
    ['ref', GREEN, 'Non-Unique Key Lookup',
      'Low-medium - Low if number of matching rows is small, higher as the number of rows increases.'],
    ['fulltext', YELLOW, 'Fulltext Index Search',
      'Specialized FULL TEXT search. Low - for this specialized search requirement.'],
    ['ref_or_null', GREEN, 'Key Lookup +\nFetch NULL Values',
      'Low-medium - if number of matching rows is small, higher as the number of rows increases.'],
    ['index_merge', GREEN, 'Index Merge',
      'Medium - may want to look for better index selection in the query to improve performance.'],
    ['unique_subquery', ORANGE, 'Unique Key Lookup\ninto table of subquery',
      'Low - Used for efficient Subquery processing'],
    ['index_subquery', ORANGE, 'Non-Unique Key Lookup\ninto table of subquery',
      'Low - Used for efficient Subquery processing'],
    ['range', ORANGE, 'Index Range Scan', 'Medium - partial index scan'],
    ['index', RED, 'Full Index Scan', 'High - especially for large indexes'],
    ['ALL', RED, 'Full Table Scan',
      'Very High - very costly for large tables (not so much for small ones).\n' +
      'No usable indexes were found for the table and the optimizer must search every row.\n' +
      'This could also mean the search range is so broad that the index would be useless.'],
    ['UNKNOWN', BLACK, 'unknown', '']
  ];

  /* ------------------------------------------------------------------ *
   * ExplainNode (base)
   * ------------------------------------------------------------------ */

  function ExplainNode(context) {
    VBoxFigure.call(this);
    this._context = context;
    this.parent = null;
    this.cost_info = null;
    this._figure = null;
    this.is_operation = false;
    this.is_container = false;
  }
  ExplainNode.prototype = Object.create(VBoxFigure.prototype);
  ExplainNode.prototype.constructor = ExplainNode;

  Object.defineProperties(ExplainNode.prototype, {
    children: { get: function () { return []; }, configurable: true },
    inner_width: { get: function () { return this._figure.width; }, configurable: true },
    inner_height: { get: function () { return this._figure.height; }, configurable: true },
    varrow_source: {
      get: function () {
        return [Math.trunc(this.root_x + this.vconnect_pos_offset) + 0.5, this._figure.root_y];
      }, configurable: true
    },
    varrow_target: {
      get: function () {
        return [Math.trunc(this.root_x + this.vconnect_pos_offset) + 0.5,
          this._figure.root_y + this.inner_height];
      }, configurable: true
    },
    harrow_target: {
      get: function () {
        return [this._figure.root_x, Math.trunc(this.root_y + this.hconnect_pos_offset) + 0.5];
      }, configurable: true
    },
    harrow_target_right: {
      get: function () {
        return [Math.trunc(this._figure.root_x + this._figure.width) + 0.5,
          Math.trunc(this.root_y + this.hconnect_pos_offset) + 0.5];
      }, configurable: true
    },
    harrow_source: {
      get: function () {
        return [this._figure.root_x + this.inner_width,
          Math.trunc(this.root_y + this.hconnect_pos_offset) + 0.5];
      }, configurable: true
    },
    vconnect_pos_offset: {
      get: function () { return this._figure.x + this.inner_width / 2; }, configurable: true
    },
    hconnect_pos_offset: {
      get: function () { return this._figure.y + this._figure.height / 2; }, configurable: true
    },
    cost_value: {
      get: function () {
        var cost_value = null;
        if (this._context.displayed_cost_info === 'read_eval_cost') {
          cost_value = this.get_read_eval_cost();
        }
        if (cost_value === null || cost_value === undefined) return null;
        if (typeof cost_value === 'number') return cost_value;
        var f = parseFloat(cost_value);
        if (!isNaN(f) && /^[\d.+-eE]+$/.test(String(cost_value).trim())) return f;
        var value = parseFloat(String(cost_value).slice(0, -1));
        var unit = String(cost_value).slice(-1);
        if (isNaN(value)) return null;
        if (unit === 'K') return value * 1000;
        if (unit === 'M') return value * 1000 * 1000;
        if (unit === 'G') return value * 1000 * 1000 * 1000;
        return value;
      }, configurable: true
    },
    rows_count: { get: function () { return null; }, configurable: true },
    hint_pos_x: { get: function () { return this.root_x + this.width; }, configurable: true }
  });

  ExplainNode.prototype.get_read_eval_cost = function () { return null; };
  ExplainNode.prototype.get_hint_text = function () { return null; };
  ExplainNode.prototype.label = function () { return 'node'; };

  ExplainNode.prototype.get_line_width = function () {
    var rows_count = this.rows_count;
    var line_width = 1;
    if (rows_count) {
      line_width = Math.max(
        Math.min(Math.trunc(Math.log(rows_count) / Math.log(20) + 0.5), 20), 1);
    }
    return line_width;
  };

  /**
   * `limit_x`: se informado, o texto e empurrado para a esquerda ate caber antes
   * dessa coordenada. Serve para o custo nao encostar na contagem de linhas
   * quando a figura e estreita (o losango do nested loop) ou o valor e longo.
   */
  ExplainNode.prototype.render_cost = function (cr, x, y, limit_x) {
    var cost = this.cost_value;
    if (cost !== null && cost !== undefined) {
      var text = this._context.fmt_cost(cost);
      cr.set_font_size(10);
      if (limit_x !== undefined) {
        x = Math.min(x, limit_x - cr.text_extents(text).x_advance);
      }
      cr.set_source_rgba(0, 0, 0, 1);
      cr.move_to(x, y);
      cr.show_text(text);
    }
  };

  ExplainNode.prototype.render_row_count = function (cr, x, y) {
    var rows_count = this.rows_count;
    if (rows_count !== null && rows_count !== undefined) {
      cr.set_source_rgba(0, 0, 0, 1);
      cr.move_to(x, y);
      cr.set_font_size(10);
      cr.show_text(fmt_rows(rows_count));
    }
  };

  ExplainNode.prototype.do_render_extras = function (cr) { };

  ExplainNode.prototype.render_extras = function (cr) {
    this.do_render_extras(cr);
    var children = this.children;
    for (var i = 0; i < children.length; i++) children[i].render_extras(cr);
  };

  ExplainNode.prototype.render = function (cr) {
    this.do_render(cr);
    this.render_extras(cr);
  };

  ExplainNode.prototype.do_render = function (cr) {
    VBoxFigure.prototype.render.call(this, cr);
    cr.save();
    cr.translate(this.x, this.y);
    var children = this.children;
    for (var i = 0; i < children.length; i++) children[i].do_render(cr);
    cr.restore();
  };

  ExplainNode.prototype.do_relayout = function (ctx) {
    VBoxFigure.prototype.do_relayout.call(this, ctx);

    var children = this.children;
    if (children.length) {
      var child = children[0];
      child.do_relayout(ctx);

      var child_align_x = child.vconnect_pos_offset;
      var child_width = child.width;

      this._width = child_width;
      this._height = this.inner_height + this._context.vspacing + child.height;

      child.move(0, this.inner_height + this._context.vspacing);
      this._figure.move(child_align_x - this.inner_width / 2, this._figure.y);
    }
  };

  ExplainNode.prototype.draw_varrow = function (cr, x, y1, y2) {
    var lw = this.get_line_width();
    cr.set_line_width(lw);
    cr.move_to(x, y1);
    cr.line_to(x, y2 + 6 + lw);
    cr.stroke();
    draw_varrow(cr, [x, y2], 10 + lw, 6 + lw);
    cr.fill();
  };

  ExplainNode.prototype.draw_harrow = function (cr, x1, x2, y, w, h) {
    w = w === undefined ? 10 : w;
    h = h === undefined ? 6 : h;
    var lw = this.get_line_width();
    cr.set_line_width(lw);
    cr.move_to(x1, y);
    cr.line_to(x2 - (w + lw), y);
    cr.stroke();
    draw_harrow(cr, [x2, y], w + lw, h + lw);
    cr.fill();
  };

  /* ------------------------------------------------------------------ *
   * NestedLoopNode
   * ------------------------------------------------------------------ */

  function NestedLoopNode(context, join_buffer, left_child, right_child) {
    ExplainNode.call(this, context);
    this.is_operation = true;
    this.join_buffer = join_buffer;

    left_child.parent = this;
    right_child.parent = this;
    this.child_aside = left_child;
    this.child_below = right_child;

    var caption;
    if (join_buffer === 'nested_loop') caption = 'nested\nloop';
    else if (join_buffer === 'Block Nested Loop') caption = 'block\nnested\nloop';
    else if (join_buffer === 'Batched Key Access') caption = 'batched\nkey\naccess';
    else if (join_buffer === 'Batched Key Access (unique)') caption = 'batched\nkey\naccess (u)';
    else caption = String(join_buffer).split(' ').join('\n');

    this._figure = new DiamondShapeFigure(caption);
    this._figure.set_layout_flags(0);
    this._figure.set_color(0.5, 0.5, 0.5, 1);
    this._figure.set_text_color(0, 0, 0, 1);
    this._figure.set_line_width(2);
    this._figure.set_font_size(11);
    this._figure.set_usize(this._context.default_height, this._context.default_height);
    this.add(this._figure);
  }
  NestedLoopNode.prototype = Object.create(ExplainNode.prototype);
  NestedLoopNode.prototype.constructor = NestedLoopNode;

  Object.defineProperties(NestedLoopNode.prototype, {
    children: { get: function () { return [this.child_aside, this.child_below]; } },
    vconnect_pos_offset: {
      get: function () {
        // o ponto de conexao do filho de baixo, e nao a metade da largura dele:
        // ele pode ter recentralizado a propria figura sobre um filho mais largo
        return this.child_aside.width + this._context.hspacing +
          this.child_below.vconnect_pos_offset;
      }
    },
    rows_count: { get: function () { return this.child_below.rows_produced; } }
  });

  NestedLoopNode.prototype.get_read_eval_cost = function () {
    return this.child_below.cost_info
      ? toNumber(this.child_below.cost_info.prefix_cost || 0) : null;
  };

  NestedLoopNode.prototype.label = function () { return this.join_buffer; };

  NestedLoopNode.prototype.do_render_extras = function (cr) {
    if (this.parent) {
      var is_inside_a_box = (this.parent instanceof MaterializedTableNode) ||
        (this.parent instanceof MaterializedJoinNode);

      cr.save();
      cr.set_source_rgba(0, 0, 0, 1);
      if (this.parent instanceof NestedLoopNode) {
        if (!is_inside_a_box) {
          this.draw_harrow(cr, this.harrow_source[0], this.parent.harrow_target[0],
            this.parent.harrow_target[1]);
        }
        this.render_row_count(cr, this.harrow_source[0] + 4, this.harrow_source[1] - 8);
      } else {
        if (!is_inside_a_box) {
          this.draw_varrow(cr, this.varrow_source[0], this.varrow_source[1],
            this.parent.varrow_target[1]);
        }
        // mesma linha de base do custo, como nas tabelas
        this.render_row_count(cr, this.varrow_source[0] + 4, this.varrow_source[1] - 5);
      }
      this.render_cost(cr, this._figure.root_x, this.varrow_source[1] - 5,
        this.varrow_source[0] - 4);
      cr.restore();
    }
  };

  NestedLoopNode.prototype.do_relayout = function (ctx) {
    var below = this.child_below;
    var aside = this.child_aside;

    this._figure.do_relayout(ctx);
    below.do_relayout(ctx);
    aside.do_relayout(ctx);

    var total_width = below.width + aside.width + this._context.hspacing;
    this._width = Math.max(this.inner_width, total_width);

    if (aside instanceof NestedLoopNode) {
      this._height = Math.max(
        this._figure.height + this._context.vspacing + below.height, aside.height);
      this._figure.move(this.vconnect_pos_offset - this.inner_width / 2, 0);
      aside.move(0, this._figure.y);
    } else {
      this._height = this._figure.height + this._context.vspacing +
        Math.max(below.height, aside.height);
      this._figure.move(this.vconnect_pos_offset - this.inner_width / 2, 0);
      aside.move(0, this._figure.height + this._context.vspacing);
    }
    below.move(aside.width + this._context.hspacing,
      this._figure.height + this._context.vspacing);
  };

  NestedLoopNode.prototype.get_hint_text = function () {
    var text = '*' + this.join_buffer + '\n\n';
    if (this.child_below.cost_info && this.child_below.cost_info.prefix_cost !== undefined) {
      text += 'Prefix Cost: ' + this.child_below.cost_info.prefix_cost;
    }
    return text;
  };

  /* ------------------------------------------------------------------ *
   * TableNode
   * ------------------------------------------------------------------ */

  function TableNode(context, name, opts) {
    ExplainNode.call(this, context);
    opts = opts || {};
    this.name = name;
    this.key_name = opts.key_name;
    this.access_type = opts.access_type;
    this.info = opts.info || {};
    this.cost_info = opts.cost_info || null;
    this.rows_examined = opts.rows_examined;
    this.rows_produced = opts.rows_produced;

    this.child_attached_subqueries = opts.attached_subqueries || null;
    if (this.child_attached_subqueries) this.child_attached_subqueries.parent = this;

    var entry = COL_JOIN_TYPES[COL_JOIN_TYPES.length - 1];
    for (var i = 0; i < COL_JOIN_TYPES.length; i++) {
      if (COL_JOIN_TYPES[i][0] === this.access_type) { entry = COL_JOIN_TYPES[i]; break; }
    }
    // opts.color/label/hint permitem outro dialeto reusar a figura (ver nodes-pg.js)
    var color = opts.color || entry[1];
    var label = opts.label || entry[2];
    var hint = opts.hint !== undefined ? opts.hint : entry[3];

    this.info._hint = hint;
    this.info._access_type = label;

    this.set_spacing(4);

    this._figure = new RectangleShapeFigure(label);
    this._figure.set_layout_flags(0);
    this._figure.set_font_size(11);
    this._figure.set_font_bold(true);
    this._figure.set_fill_color.apply(this._figure, color);
    this._figure.set_text_color(1, 1, 1, 1);
    this._figure.set_padding(10, 10, 10, 10);
    this.add(this._figure);

    this._figure_name = new RectangleShapeFigure(this.name);
    this._figure_name.set_layout_flags(0);
    this._figure_name.set_color(1, 1, 1, 0);
    this._figure_name.set_font_size(11);
    this._figure_name.set_text_color(0, 0, 0, 1);
    this._figure_name.set_alignment(0.5, 0);
    this.add(this._figure_name);

    if (this.key_name) {
      this._figure_key = new TextFigure(this.key_name);
      this._figure_key.set_layout_flags(0);
      this._figure_key.set_font_size(10);
      this._figure_key.set_font_bold(true);
      this._figure_key.set_text_color(0, 0, 0, 1);
      this._figure_key.set_alignment(0.5, 0);
      this.add(this._figure_key);
    } else {
      this._figure_key = null;
    }
  }
  TableNode.prototype = Object.create(ExplainNode.prototype);
  TableNode.prototype.constructor = TableNode;

  Object.defineProperties(TableNode.prototype, {
    children: {
      get: function () {
        return this.child_attached_subqueries ? [this.child_attached_subqueries] : [];
      }, configurable: true
    },
    rows_count: { get: function () { return this.rows_examined; }, configurable: true },
    vconnect_pos_offset: {
      get: function () {
        if (this.child_attached_subqueries) {
          return this._figure.x + this._figure.width / 2;
        }
        return this._figure.x + this.inner_width / 2;
      }, configurable: true
    },
    inner_height: {
      get: function () {
        var h = this._figure.height;
        if (this._figure_name) h += 4 + this._figure_name.height;
        if (this._figure_key) h += 4 + this._figure_key.height;
        return h;
      }, configurable: true
    },
    hint_pos_x: {
      get: function () { return this._figure.root_x + this._figure.width; }, configurable: true
    }
  });

  TableNode.prototype.get_read_eval_cost = function () {
    if (this.cost_info) {
      return (toNumber(this.cost_info.read_cost) || 0) + (toNumber(this.cost_info.eval_cost) || 0);
    }
    return null;
  };

  TableNode.prototype.label = function () {
    return '<table: ' + this.name + ' (' + this.access_type + ')>';
  };

  TableNode.prototype._hint_line = function (label, key, always_show, value_format) {
    var has = Object.prototype.hasOwnProperty.call(this.info, key);
    if (has || always_show) {
      var value;
      if (value_format && has) value = value_format.replace('%s', this.info[key]);
      else value = has ? this.info[key] : '-';
      if (Array.isArray(value)) value = value.join(',\n    ');
      return label + '  ' + value + '\n';
    }
    return '';
  };

  TableNode.prototype.get_hint_text = function () {
    var info = this.info;
    var text = '*' + (info.table_name || this.name) + '\n' +
      '  Access Type: ' + (info.access_type || '-') + '\n' +
      '      ' + String(info._access_type).split('\n').join(' ') + '\n' +
      '      Cost Hint: ' + info._hint + '\n';

    text += this._hint_line('  Used Columns:', 'used_columns');
    text += '\n';
    text += this._hint_line('*Key/Index:', 'key', true);
    text += this._hint_line('  Ref.:', 'ref');
    text += this._hint_line('  Used Key Parts:', 'used_key_parts');
    text += this._hint_line('  Possible Keys:', 'possible_keys');
    if ('used_columns' in info || 'used_key_parts' in info || 'possible_keys' in info) {
      text += '\n';
    }

    if (!('attached_condition_fmt' in info) && 'attached_condition' in info) {
      info.attached_condition_fmt = info.attached_condition;
    }
    text += this._hint_line('*Attached Condition:\n', 'attached_condition_fmt');
    if ('attached_condition' in info) text += '\n';

    text += this._hint_line('Using Join Buffer:', 'using_join_buffer');
    text += this._hint_line('Rows Examined per Scan:', 'rows_examined_per_scan');
    text += this._hint_line('Rows Produced per Join:', 'rows_produced_per_join');
    text += this._hint_line('Filtered (ratio of rows produced per rows examined):',
      'filtered', false, '%s%');
    text += '    Hint: 100% is best, <= 1% is worst\n';
    text += '    A low value means the query examines a lot of rows that are not returned.\n';
    if (this.cost_info) {
      text += '*Cost Info\n' +
        '  Read: ' + (this.cost_info.read_cost !== undefined ? this.cost_info.read_cost : '-') + '\n' +
        '  Eval: ' + (this.cost_info.eval_cost !== undefined ? this.cost_info.eval_cost : '-') + '\n' +
        '  Prefix: ' + (this.cost_info.prefix_cost !== undefined ? this.cost_info.prefix_cost : '-') + '\n' +
        '  Data Read: ' + (this.cost_info.data_read_per_join !== undefined ? this.cost_info.data_read_per_join : '-') + '\n';
    }
    return text;
  };

  TableNode.prototype.do_render_extras = function (cr) {
    if (this.parent && !(this.parent instanceof MaterializedTableNode)) {
      cr.save();
      cr.set_source_rgba(0, 0, 0, 1);
      if ((this.parent instanceof NestedLoopNode) && this.parent.child_aside === this) {
        // caso especial: linha em L
        cr.move_to(this.varrow_source[0], this.varrow_source[1]);
        cr.line_to(this.varrow_source[0], this.parent.harrow_target[1]);
        this.draw_harrow(cr, this.varrow_source[0], this.parent.harrow_target[0],
          this.parent.harrow_target[1]);
      } else {
        this.draw_varrow(cr, this.varrow_source[0], this.varrow_source[1],
          this.parent.varrow_target[1]);
      }
      this.render_cost(cr, this._figure.root_x, this.varrow_source[1] - 5,
        this.varrow_source[0] - 4);
      this.render_row_count(cr, this.varrow_source[0] + 4, this.varrow_source[1] - 5);
      cr.restore();
    }
  };

  TableNode.prototype.do_relayout = function (ctx) {
    this._figure.set_usize(null, null);
    this._figure.do_relayout(ctx);
    this._figure.set_usize(Math.max(this._figure.width, 90), this._figure._uheight);
    if (this._figure_name) {
      this._figure_name.set_usize(Math.max(this._figure.width, 90), this._figure_name._uheight);
    }
    if (this._figure_key) {
      this._figure_key.set_usize(Math.max(this._figure.width, 90), this._figure_key._uheight);
    }

    this._height = this.inner_height;

    VBoxFigure.prototype.do_relayout.call(this, ctx);

    // subselects no WHERE: ficam a direita da tabela
    var child = this.child_attached_subqueries;
    if (child) {
      child.do_relayout(ctx);

      this._figure.move(0, this._figure.y);
      if (this._figure_name) this._figure_name.move(0, this._figure_name.y);
      if (this._figure_key) this._figure_key.move(0, this._figure_key.y);
      child.move(this._figure.x + this._figure.width + this._context.hspacing, this._figure.y);
      this._width = this._figure.width + this._context.hspacing + child.width;
      this._height = Math.max(this._height, child.height);
    }
  };

  /* ------------------------------------------------------------------ *
   * MaterializedTableNode
   * ------------------------------------------------------------------ */

  function MaterializedTableNode(context, name, opts) {
    TableNode.call(this, context, name, opts);
    this.is_container = true;

    this.set_spacing(0);

    var fill = this._figure._fill_color;
    this._figure.set_color(fill[0], fill[1], fill[2], 0.8);
    this._figure.set_fill_color(fill[0], fill[1], fill[2], 0.8);

    this._figure_name.set_color(0.9, 0.9, 0.9, 0.9);
    if (name.charAt(0) === '<' && name.charAt(name.length - 1) === '>') {
      this._figure_name.set_text(name);
    } else {
      this._figure_name.set_text(name + ' (materialized)');
    }
    this._figure_name.set_fill_color(0.9, 0.9, 0.9, 0.9);
    this._figure_name.set_padding(4, 4, 4, 4);

    this.materialize_attributes = opts.materialize_attributes || {};

    this.child_materialized_from = opts.materialized_from;
    this.child_materialized_from.parent = this;
  }
  MaterializedTableNode.prototype = Object.create(TableNode.prototype);
  MaterializedTableNode.prototype.constructor = MaterializedTableNode;

  Object.defineProperties(MaterializedTableNode.prototype, {
    children: {
      get: function () {
        var base = this.child_attached_subqueries ? [this.child_attached_subqueries] : [];
        return base.concat([this.child_materialized_from]);
      }
    },
    inner_width: { get: function () { return this.width; } }
  });

  MaterializedTableNode.prototype.label = function () {
    return '<materialized table: ' + this.name + ' (' + this.access_type + ')>';
  };

  MaterializedTableNode.prototype.do_relayout = function (ctx) {
    this.child_materialized_from.do_relayout(ctx);
    var width = this.child_materialized_from.width + this._context.frame_padding * 2;

    VBoxFigure.prototype.do_relayout.call(this, ctx);

    // largura minima do container: o cabecalho (tipo de acesso, nome, chave)
    // nao pode transbordar a caixa
    for (var j = 0; j < this._items.length; j++) {
      width = Math.max(width, this._items[j].width);
    }

    for (var i = 0; i < this._items.length; i++) {
      this._items[i].move(0, this._items[i].y);
      this._items[i]._width = width;
    }

    this._width = width;
    this._height = Math.max(this._height, Math.trunc(this.inner_height +
      this.child_materialized_from.height + this._context.frame_padding * 2));

    if (this.width <= this.child_materialized_from.width) {
      this.child_materialized_from.move(this._context.frame_padding,
        this.inner_height + this._context.frame_padding);
    } else {
      this.child_materialized_from.move((width - this.child_materialized_from.width) / 2,
        this.inner_height + this._context.frame_padding);
    }

    var child = this.child_attached_subqueries;
    if (child) {
      child.do_relayout(ctx);
      child.move(width + this._context.hspacing, this._figure.y);
      this._width = width + this._context.hspacing + child.width;
      this._height = Math.max(this._height, child.height);
    }
  };

  MaterializedTableNode.prototype.do_render = function (ctx) {
    TableNode.prototype.do_render.call(this, ctx);
    ctx.save();
    ctx.translate(this.x, this.y);
    // moldura tracejada simetrica em torno do conteudo materializado
    ctx.rectangle(0.5, 0.5,
      Math.trunc(this.child_materialized_from.width + this.child_materialized_from.x * 2),
      Math.trunc(this.child_materialized_from.height + this.child_materialized_from.y +
        this._context.frame_padding));
    ctx.set_line_width(1);
    ctx.set_dash([4.0, 2.0], 0);
    ctx.set_source_rgba(0.5, 0.5, 0.5, 0.9);
    ctx.stroke();
    ctx.restore();
  };

  MaterializedTableNode.prototype.get_hint_text = function () {
    var a = this.materialize_attributes || {};
    var text = '*Materialized from Subquery\n' +
      'Using Temporary Table: ' + (a.using_temporary_table ? 'True' : 'False') + '\n' +
      'Dependent: ' + (a.dependent ? 'True' : 'False') + '\n' +
      'Cacheable: ' + (a.cacheable ? 'True' : 'False') + '\n';
    return text + '\n' + TableNode.prototype.get_hint_text.call(this);
  };

  /* ------------------------------------------------------------------ *
   * OperationNode (GROUP / ORDER / DISTINCT)
   * ------------------------------------------------------------------ */

  /**
   * `opts` (opcional) permite que outro dialeto reuse a figura com legenda, cor e
   * rotulo proprios, no lugar do mapeamento das operacoes do MySQL. Ver nodes-pg.js.
   */
  function OperationNode(context, operation, child, cost_info, attributes,
    optimized_away_subnode, opts) {
    ExplainNode.call(this, context);
    opts = opts || {};
    this.is_operation = true;
    this.operation = operation;
    if (child) child.parent = this;
    this.child = child;
    this.cost_info = cost_info || null;
    this.attributes = attributes || {};
    this.child_optimized_away = optimized_away_subnode || null;

    var operation_caption, score;
    if (opts.caption !== undefined) {
      operation_caption = opts.caption;
      score = 0;
    } else if (operation === 'grouping_operation') {
      operation_caption = 'GROUP';
      score = 0;
      if (this.attributes.using_temporary_table) score += 1;
      if (this.attributes.using_filesort) score += 1;
    } else if (operation === 'duplicates_removal') {
      operation_caption = 'DISTINCT';
      score = 0;
      if (this.attributes.using_filesort) score += 2;
    } else if (operation === 'ordering_operation') {
      operation_caption = 'ORDER';
      score = 0;
      if (this.attributes.using_filesort) score += 2;
    } else {
      operation_caption = operation;
      score = 0;
    }

    var fill_color = opts.color || YELLOW;
    if (!opts.color) {
      if (score === 1) fill_color = ORANGE;
      else if (score === 2) fill_color = RED;
    }

    this.set_spacing(4);

    this._figure = new RectangleShapeFigure(operation_caption);
    this._figure.set_layout_flags(0);
    this._figure.set_corner_radius(20);
    this._figure.set_color(0.0, 0.0, 0.0, 1);
    this._figure.set_color.apply(this._figure, fill_color);
    this._figure.set_line_width(2);
    this._figure.set_padding(15, 20, 15, 20);
    this.add(this._figure);

    var attrs = opts.attrs;
    if (!attrs) {
      attrs = [];
      if (this.attributes.using_temporary_table) attrs.push('tmp table');
      if (this.attributes.using_filesort) attrs.push('filesort');
    }
    if (attrs.length) {
      this._figure_message = new TextFigure(attrs.join(','));
      this._figure_message.set_font_bold(true);
      this._figure_message.set_font_size(10);
      // centralizado sob a figura, como o nome/chave das tabelas: a seta que
      // chega no no aponta para o conjunto (figura + rotulo), nao para o lado dele
      this._figure_message.set_layout_flags(0);
      this._figure_message.set_alignment(0.5, 0);
      this.add(this._figure_message);
    } else {
      this._figure_message = null;
    }
  }
  OperationNode.prototype = Object.create(ExplainNode.prototype);
  OperationNode.prototype.constructor = OperationNode;

  Object.defineProperties(OperationNode.prototype, {
    varrow_target: {
      get: function () {
        if (this._figure_message) {
          return [Math.trunc(this.root_x + this.vconnect_pos_offset) + 0.5,
            this._figure.root_y + this._figure_message.height + this.inner_height + 5];
        }
        return [Math.trunc(this.root_x + this.vconnect_pos_offset) + 0.5,
          this._figure.root_y + this.inner_height + 1];
      }
    },
    children: { get: function () { return this.child ? [this.child] : []; } },
    rows_count: {
      get: function () {
        var children = this.children;
        return children.length ? children[0].rows_count : 0;
      }
    }
  });

  OperationNode.prototype.label = function () { return this.operation; };

  OperationNode.prototype.do_render_extras = function (cr) {
    if (this.parent && !(this.parent instanceof MaterializedTableNode) &&
      !(this.parent instanceof MaterializedJoinNode)) {
      cr.save();
      cr.set_source_rgba(0, 0, 0, 1);
      if ((this.parent instanceof NestedLoopNode) && this.parent.child_aside === this) {
        this.draw_harrow(cr, this.varrow_source[0], this.parent.harrow_target[0],
          this.parent.harrow_target[1]);
      } else if (this.parent instanceof OperationNode) {
        this.draw_harrow(cr, this.harrow_source[0], this.parent.harrow_target[0],
          this.harrow_source[1]);
      } else {
        this.draw_varrow(cr, this.varrow_source[0], this.varrow_source[1],
          this.parent.varrow_target[1]);
      }
      cr.restore();
    }
  };

  OperationNode.prototype.do_relayout = function (ctx) {
    VBoxFigure.prototype.do_relayout.call(this, ctx);

    var child = this.child;
    if (!child) return;
    child.do_relayout(ctx);

    if ((child instanceof NestedLoopNode) || (child instanceof MaterializedJoinNode) ||
      (child instanceof TableNode)) {
      this._width = Math.max(child.width, this.width);
      this._height = child.height + this._context.vspacing + this.inner_height;
      if (child.width > this._figure.width) {
        this._figure.move(child.vconnect_pos_offset - this._figure.width / 2, 0);
        child.move(0, this._figure.height + this._context.vspacing);
      } else {
        this._figure.move(0, 0);
        child.move((this._figure.width - child.width) / 2,
          this._figure.height + this._context.vspacing);
      }
    } else {
      this._width = child.width + this._context.hspacing + this.inner_width;
      this._height = Math.max(child.height, this.inner_height);
      this._figure.move(child.width + this._context.hspacing, 0);
      child.move(0, 0);
    }
    if (this._figure_message) {
      this._figure_message.set_usize(this._figure.width, null);
      this._figure_message.move(this._figure.x, this._figure.y + this._figure.height + 4);
    }
  };

  OperationNode.prototype.get_hint_text = function () {
    var text;
    if (this.operation === 'grouping_operation') text = '*Grouping Operation\n';
    else if (this.operation === 'ordering_operation') text = '*Ordering Operation\n';
    else if (this.operation === 'duplicates_removal') text = '*Duplicates Removal\n';
    else text = this.operation + '\n';
    text += '\n';
    if ('using_temporary_table' in this.attributes) {
      text += 'Using Temporary Table:  ' + this.attributes.using_temporary_table + '\n';
    }
    if ('using_filesort' in this.attributes) {
      text += 'Using Filesort:  ' + this.attributes.using_filesort + '\n';
    }
    if (this.cost_info && 'sort_cost' in this.cost_info) {
      text += 'Sort Cost: ' + this.cost_info.sort_cost + '\n';
    }
    return text;
  };

  /* ------------------------------------------------------------------ *
   * QueryBlockNode / SubQueryBlockNode
   * ------------------------------------------------------------------ */

  function QueryBlockNode(context, nested_loop, optimized_away_subnode, select_list_subqueries,
    info, cost_info) {
    ExplainNode.call(this, context);
    if (nested_loop) nested_loop.parent = this;
    this.info = info || {};
    this.cost_info = cost_info || null;
    this.child = nested_loop;
    this.child_optimized_away = optimized_away_subnode || null;
    if (this.child_optimized_away) this.child_optimized_away.parent = this;

    this.select_list_subqueries = select_list_subqueries || null;
    if (this.select_list_subqueries) this.select_list_subqueries.parent = this;

    this.set_spacing(8);

    if (info && 'select_id' in info) {
      this._figure = new RectangleShapeFigure('query_block #' + info.select_id);
    } else {
      this._figure = new RectangleShapeFigure('query_block');
    }
    this._figure.set_layout_flags(0);
    this._figure.set_padding(10, 10, 10, 10);
    this.add(this._figure);

    if (info && 'message' in info) {
      this._figure_message = new TextFigure(info.message);
      this._figure_message.set_font_size(11);
      this._figure_message.set_text_color(0, 0, 0, 1);
      this._figure_message.set_alignment(0.5, 0);
      this.add(this._figure_message);
    } else {
      this._figure_message = null;
    }
  }
  QueryBlockNode.prototype = Object.create(ExplainNode.prototype);
  QueryBlockNode.prototype.constructor = QueryBlockNode;

  Object.defineProperties(QueryBlockNode.prototype, {
    inner_height: {
      get: function () {
        var h = this._figure.height;
        if (this._figure_message) h += this._figure_message.height;
        return h;
      }, configurable: true
    },
    children: {
      get: function () {
        var result = [];
        if (this.child) result.push(this.child);
        if (this.select_list_subqueries) result.push(this.select_list_subqueries);
        return result;
      }, configurable: true
    }
  });

  QueryBlockNode.prototype.label = function () { return 'query_block'; };

  QueryBlockNode.prototype.do_relayout = function (ctx) {
    VBoxFigure.prototype.do_relayout.call(this, ctx);

    var child = this.child;
    if (child) {
      child.do_relayout(ctx);

      var voffset = 20; // espaco extra para o custo no topo
      var child_align_x = child.vconnect_pos_offset;

      this._width = child.width;
      this._height = this.inner_height + this._context.vspacing + child.height + voffset;

      child.move(0, this.inner_height + this._context.vspacing);
      this._figure.move(child_align_x - this.inner_width / 2, voffset);
    }

    child = this.select_list_subqueries;
    if (child) {
      child.do_relayout(ctx);
      child.move(this.width + this._context.small_hspacing,
        this._figure.y + this._context.frame_padding);
      this._width += this._context.small_hspacing + child.width;
      this._height = Math.max(this._height, child.y + child.height);
    }

    this._width += this._context.frame_padding * 2;
    this._height += this._context.frame_padding;
  };

  QueryBlockNode.prototype.get_hint_text = function () {
    var text = 'Select ID: ' + (this.info.select_id !== undefined ? this.info.select_id : '-') + '\n';
    if (this.cost_info && this.cost_info.query_cost !== undefined) {
      text += 'Query Cost: ' + this.cost_info.query_cost + '\n';
    }
    if (this.info.message) text += '\n' + this.info.message + '\n';
    return text;
  };

  QueryBlockNode.prototype.render_cost = function (cr, x, y) {
    if (this.cost_info) {
      var cost = this.cost_info.query_cost;
      if (cost !== undefined && cost !== null) {
        cr.set_source_rgba(0, 0, 0, 1);
        cr.move_to(x, y);
        cr.set_font_size(10);
        cr.show_text('Query cost: ' + cost);
      }
    }
  };

  QueryBlockNode.prototype.do_render_extras = function (cr) {
    cr.save();
    cr.set_source_rgba(0, 0, 0, 1);
    this.render_cost(cr, this._figure.root_x, this._figure.root_y - 5);
    if (this.parent && !(this.parent instanceof MaterializedTableNode)) {
      this.draw_varrow(cr, this.varrow_source[0], this.varrow_source[1],
        this.parent.varrow_target[1]);
    }
    cr.restore();
  };

  function SubQueryBlockNode(context, nested_loop, optimized_away_subnode, select_list_subqueries,
    info, cost_info) {
    QueryBlockNode.call(this, context, nested_loop, optimized_away_subnode,
      select_list_subqueries, info, cost_info);
    this.attributes = {};
    if (info && 'select_id' in info) this._figure.set_text('subquery #' + info.select_id);
    else this._figure.set_text('subquery');
  }
  SubQueryBlockNode.prototype = Object.create(QueryBlockNode.prototype);
  SubQueryBlockNode.prototype.constructor = SubQueryBlockNode;

  SubQueryBlockNode.prototype.set_attributes = function (attributes) {
    this.attributes = attributes || {};
  };

  SubQueryBlockNode.prototype.label = function () { return 'subquery'; };

  SubQueryBlockNode.prototype.get_hint_text = function () {
    var text = 'Subquery\n';
    if ('select_id' in this.info) text += 'Select ID: ' + this.info.select_id + '\n';
    if (this.cost_info && this.cost_info.query_cost !== undefined) {
      text += 'Query Cost: ' + this.cost_info.query_cost + '\n';
    }
    text += '\n';
    var a = this.attributes || {};
    if ('using_temporary_table' in a) text += 'Using Temporary Table:  ' + a.using_temporary_table + '\n';
    if ('dependent' in a) text += 'Dependent:  ' + a.dependent + '\n';
    if ('cacheable' in a) text += 'Cacheable:  ' + a.cacheable + '\n';
    return text;
  };

  /* ------------------------------------------------------------------ *
   * MaterializedJoinNode (buffer_result)
   * ------------------------------------------------------------------ */

  function MaterializedJoinNode(context, name, nested_loop, info, cost_info, attributes) {
    ExplainNode.call(this, context);
    this.is_container = true;
    this.name = name;

    this.set_spacing(0);
    this.set_padding(10, 10, 10, 10);

    this._figure = new RectangleShapeFigure(name);
    this._figure.set_layout_flags(HFill);
    this._figure.set_line_width(1);
    this._figure.set_color(0.5, 0.5, 0.5, 0.8);
    this._figure.set_fill_color(0.5, 0.5, 0.5, 0.8);
    this._figure.set_font_bold(true);
    this._figure.set_padding(6, 4, 6, 4);
    this.add(this._figure);

    this.attributes = attributes || {};
    var attrs = [];
    if (this.attributes.using_temporary_table) attrs.push('tmp table');
    if (attrs.length) {
      this._figure_message = new TextFigure(attrs.join(','));
      this._figure_message.set_font_bold(true);
      this._figure_message.set_font_size(10);
      this.add(this._figure_message);
    } else {
      this._figure_message = null;
    }

    this.nested_loop = nested_loop;
    nested_loop.parent = this;

    this.info = info || {};
    this.cost_info = cost_info || null;
    this.child = nested_loop;
  }
  MaterializedJoinNode.prototype = Object.create(ExplainNode.prototype);
  MaterializedJoinNode.prototype.constructor = MaterializedJoinNode;

  Object.defineProperties(MaterializedJoinNode.prototype, {
    inner_height: { get: function () { return this._figure.height; } },
    inner_width: { get: function () { return this.width; } },
    vconnect_pos_offset: { get: function () { return this.width / 2; } },
    children: { get: function () { return this.child ? [this.child] : []; } }
  });

  MaterializedJoinNode.prototype.label = function () { return '<' + this.name + '>'; };

  MaterializedJoinNode.prototype.get_hint_text = function () {
    return '*Buffered Join Result\nUsing Temporary Table: ' +
      (this.attributes.using_temporary_table ? 'True' : 'False') + '\n';
  };

  MaterializedJoinNode.prototype.do_relayout = function (ctx) {
    ExplainNode.prototype.do_relayout.call(this, ctx);

    var child = this.child;
    if (child) {
      child.do_relayout(ctx);
      this._width = child.width + this.padding_left + this.padding_right;
      this._height = this.inner_height + this._context.vspacing + child.height +
        this.padding_top + this.padding_bottom;
      child.move(this.padding_left, this.inner_height + this._context.vspacing);
      this._figure.move(0, 0);
    }
  };

  MaterializedJoinNode.prototype.do_render = function (ctx) {
    ExplainNode.prototype.do_render.call(this, ctx);
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rectangle(0.5, 0.5, Math.trunc(this._width), Math.trunc(this._height) - 1);
    ctx.set_line_width(2);
    ctx.set_dash([4.0, 2.0], 0);
    ctx.set_source_rgba(0.5, 0.5, 0.5, 0.9);
    ctx.stroke();
    ctx.restore();
  };

  MaterializedJoinNode.prototype.do_render_extras = function (cr) {
    if (this.parent && !(this.parent instanceof MaterializedTableNode)) {
      cr.save();
      cr.set_source_rgba(0, 0, 0, 1);
      if (this.parent instanceof NestedLoopNode) {
        this.draw_harrow(cr, this.harrow_source[0], this.parent.harrow_target[0],
          this.parent.harrow_target[1]);
        this.render_row_count(cr, this.harrow_source[0] + 4, this.harrow_source[1] - 8);
      } else {
        this.draw_varrow(cr, this.varrow_source[0], this.varrow_source[1],
          this.parent.varrow_target[1]);
        this.render_row_count(cr, this.varrow_source[0] + 4, this.varrow_source[1]);
      }
      cr.restore();
    }
  };

  /* ------------------------------------------------------------------ *
   * SubQueries / UnionResult
   * ------------------------------------------------------------------ */

  function SubQueries(context, what, nodes) {
    ExplainNode.call(this, context);
    this.what = what;
    for (var i = 0; i < nodes.length; i++) nodes[i].parent = this;
    this._children = nodes;

    this._figure = new RectangleShapeFigure(what);
    this._figure.set_line_dash([2.0, 2.0], 0);
    this._figure.set_padding(8, 10, 8, 10);
    this._figure.set_line_width(1);
    this.add(this._figure);
  }
  SubQueries.prototype = Object.create(ExplainNode.prototype);
  SubQueries.prototype.constructor = SubQueries;

  Object.defineProperties(SubQueries.prototype, {
    children: { get: function () { return this._children; }, configurable: true },
    inner_height: { get: function () { return this._figure.height; }, configurable: true }
  });

  SubQueries.prototype.label = function () { return this.what; };

  SubQueries.prototype.do_relayout = function (ctx) {
    VBoxFigure.prototype.do_relayout.call(this, ctx);

    var max_height = 0;
    var total_width = 0;
    var children = this.children;

    for (var i = children.length - 1; i >= 0; i--) {
      var child = children[i];
      child.do_relayout(ctx);
      child.move(total_width, this.inner_height + this._context.small_vspacing);
      total_width += child.width + this._context.small_hspacing;
      max_height = Math.max(max_height, child.height);
    }
    if (children.length) total_width -= this._context.small_hspacing;

    this._width = total_width;
    this._height = this.inner_height + this._context.small_vspacing + max_height;
  };

  SubQueries.prototype.do_render_extras = function (cr) {
    cr.save();
    cr.set_source_rgba(0, 0, 0, 1);
    this.render_cost(cr, this._figure.root_x, this._figure.root_y - 5);

    if (this.what === 'select_list_subqueries' || this.what === 'attached_subqueries') {
      var target_x = this.parent._figure.root_x + this.parent._figure.width;
      this.draw_harrow(cr, this.root_x, target_x, this.harrow_source[1], -10, 6);
    } else if (this.parent && !(this.parent instanceof MaterializedTableNode)) {
      this.draw_varrow(cr, this.varrow_source[0], this.varrow_source[1],
        this.parent.varrow_target[1]);
    }
    cr.restore();
  };

  SubQueries.prototype.get_hint_text = function () {
    if (this.what === 'attached_subqueries') return '*Attached Subqueries\n';
    if (this.what === 'select_list_subqueries') return '*Subqueries no SELECT\n';
    if (this.what === 'optimized_away_subqueries') return '*Optimized Away Subqueries\n';
    return '*' + this.what + '\n';
  };

  function UnionResult(context, info, queries) {
    SubQueries.call(this, context, 'UNION', queries);

    this.set_spacing(4);
    this._figure.set_line_dash(null, null);
    this._figure.set_color(0, 0, 0, 1);
    this._figure.set_fill_color(0.7, 0.7, 0.7, 1);

    if (info && 'table_name' in info) {
      this._figure_name = new TextFigure(info.table_name);
      this._figure_name.set_font_size(11);
      this._figure_name.set_text_color(0, 0, 0, 1);
      this._figure_name.set_alignment(0.5, 0);
      this.add(this._figure_name);
    } else {
      this._figure_name = null;
    }
    this.info = info || {};
  }
  UnionResult.prototype = Object.create(SubQueries.prototype);
  UnionResult.prototype.constructor = UnionResult;

  Object.defineProperties(UnionResult.prototype, {
    inner_height: {
      get: function () {
        var h = this._figure.height;
        if (this._figure_name) h += 4 + this._figure_name.height;
        return h;
      }
    }
  });

  UnionResult.prototype.set_attributes = function () { /* pertencem ao no materializado */ };

  UnionResult.prototype.get_hint_text = function () {
    var info = this.info;
    return '*' + (info.table_name || 'UNION Result') + '\n' +
      'Access Type: ' + (info.access_type || '-') + '\n\n' +
      'Using Temporary Table: ' + (info.using_temporary_table ? 'True' : 'False') + '\n';
  };

  global.VE.nodes = {
    fmt_number: fmt_number,
    fmt_rows: fmt_rows,
    COL_JOIN_TYPES: COL_JOIN_TYPES,
    ExplainNode: ExplainNode,
    NestedLoopNode: NestedLoopNode,
    TableNode: TableNode,
    MaterializedTableNode: MaterializedTableNode,
    OperationNode: OperationNode,
    QueryBlockNode: QueryBlockNode,
    SubQueryBlockNode: SubQueryBlockNode,
    MaterializedJoinNode: MaterializedJoinNode,
    SubQueries: SubQueries,
    UnionResult: UnionResult
  };
})(window);
