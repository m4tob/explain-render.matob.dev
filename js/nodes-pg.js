/*
 * nodes-pg.js - PostgreSQL plan nodes.
 *
 * Reuses the layout and the figure drawing of the MySQL dialect (nodes.js) and
 * only swaps the semantics: colors per Node Type, labels, costs and hint text.
 *
 *   scans (Seq Scan, Index Scan, ...)      -> colored box + relation + index
 *   joins (Nested Loop, Hash Join, ...)    -> diamond
 *   operations (Sort, Aggregate, Hash, ...) -> rounded box
 *   n-ary (Append, BitmapOr, ...)          -> bar with the children side by side
 */
(function (global) {
  'use strict';

  var g = global.VE.graphics;
  var n = global.VE.nodes;
  var VBoxFigure = g.VBoxFigure;

  var BLUE = [0.25, 0.5, 0.75, 1];
  var GREEN = [0.0, 0.5, 0.0, 1];
  var YELLOW = [0.75, 0.75, 0.0, 1];
  var ORANGE = [0.75, 0.5, 0.0, 1];
  var RED = [0.75, 0.25, 0.25, 1];
  var GRAY = [0.4, 0.4, 0.4, 1];

  /* ------------------------------------------------------------------ *
   * Node types
   * ------------------------------------------------------------------ */

  var JOIN_TYPES = ['Nested Loop', 'Hash Join', 'Merge Join'];

  // [Node Type, color, cost hint]
  var SCAN_TYPES = [
    ['Seq Scan', RED,
      'High - reads the whole table. An index helps if the filter is selective.'],
    ['Parallel Seq Scan', ORANGE,
      'High, but split across parallel workers.'],
    ['Index Scan', GREEN,
      'Low - finds the rows through the index and fetches each one from the heap.'],
    ['Index Only Scan', BLUE,
      'Very low - answers from the index alone, without reading the heap (depends on the visibility map).'],
    ['Bitmap Index Scan', GREEN,
      'Low - builds a bitmap of the interesting blocks, without touching the heap yet.'],
    ['Bitmap Heap Scan', ORANGE,
      'Medium - reads the heap in block order from the bitmap. Common when the filter matches many rows.'],
    ['Tid Scan', BLUE, 'Very low - direct access by ctid.'],
    ['CTE Scan', ORANGE, 'Reads the already materialized result of a CTE.'],
    ['WorkTable Scan', ORANGE, 'Reads the work table of a recursive CTE.'],
    ['Subquery Scan', ORANGE, 'Reads the result of a subquery.'],
    ['Function Scan', YELLOW, 'Reads the output of a function.'],
    ['Table Function Scan', YELLOW, 'Reads the output of a table function.'],
    ['Values Scan', BLUE, 'Reads a constant VALUES list.'],
    ['Named Tuplestore Scan', ORANGE, 'Reads a named tuplestore (a trigger transition table).'],
    ['Sample Scan', ORANGE, 'Reads a sample of the table (TABLESAMPLE).'],
    ['Foreign Scan', ORANGE, 'Reads a foreign table through an FDW. The cost depends on the remote server.']
  ];

  var OP_COLORS = {
    'Sort': YELLOW,
    'Incremental Sort': YELLOW,
    'Aggregate': YELLOW,
    'HashAggregate': YELLOW,
    'GroupAggregate': YELLOW,
    'MixedAggregate': YELLOW,
    'Group': YELLOW,
    'Hash': YELLOW,
    'Materialize': YELLOW,
    'Memoize': GREEN,
    'Unique': YELLOW,
    'WindowAgg': YELLOW,
    'SetOp': YELLOW,
    'Limit': GREEN,
    'LockRows': YELLOW,
    'ProjectSet': YELLOW,
    'Result': GREEN,
    'Gather': YELLOW,
    'Gather Merge': YELLOW,
    'ModifyTable': ORANGE,
    'Insert': ORANGE,
    'Update': ORANGE,
    'Delete': ORANGE
  };

  var OP_HINTS = {
    'Sort': 'Sorts the result. On disk (external merge) it costs far more than in memory.',
    'Incremental Sort': 'Sorts by taking advantage of the ordering the input already had.',
    'Aggregate': 'Computes aggregates.',
    'HashAggregate': 'Groups into a hash table. If it exceeds work_mem, it spills to disk.',
    'GroupAggregate': 'Groups by relying on the already sorted input.',
    'Hash': 'Builds the hash table for the inner side of a Hash Join. More than one batch means disk.',
    'Materialize': 'Keeps the child result so it can be re-read without recomputing.',
    'Memoize': 'Caches inner side results per key, avoiding repeated lookups.',
    'Unique': 'Removes duplicates from a sorted input.',
    'WindowAgg': 'Applies window functions.',
    'Limit': 'Stops reading after N rows.',
    'Gather': 'Collects the results of the parallel workers.',
    'Gather Merge': 'Collects the results of the workers while preserving the ordering.',
    'Append': 'Concatenates the children (UNION ALL, partitions).',
    'Merge Append': 'Concatenates the children while preserving the ordering.',
    'BitmapAnd': 'Intersects bitmaps from several indexes (AND).',
    'BitmapOr': 'Unions bitmaps from several indexes (OR).',
    'Recursive Union': 'Runs the recursive part of a WITH RECURSIVE CTE.',
    'Nested Loop': 'For each outer row, scans the inner side. Good when the outer side has few rows.',
    'Hash Join': 'Builds a hash of the inner side and probes it with the outer side. Good for larger volumes.',
    'Merge Join': 'Walks both already sorted sides in step.'
  };

  function isJoin(type) { return JOIN_TYPES.indexOf(type) >= 0; }

  function isScan(type) { return /Scan$/.test(type || ''); }

  function scanStyle(type) {
    for (var i = 0; i < SCAN_TYPES.length; i++) {
      if (SCAN_TYPES[i][0] === type) return SCAN_TYPES[i];
    }
    return [type, GRAY, ''];
  }

  /* ------------------------------------------------------------------ *
   * Leitura do plano
   * ------------------------------------------------------------------ */

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function fmtNum(v) {
    if (v === null || v === undefined) return '-';
    return String(Math.round(v * 100) / 100);
  }

  function actualRows(plan) {
    var rows = num(plan['Actual Rows']);
    if (rows === null) return null;
    var loops = num(plan['Actual Loops']);
    return loops === null ? rows : rows * loops;
  }

  /** Rows leaving the node: the actual count with ANALYZE, the estimate otherwise. */
  function rowsOf(plan) {
    var real = actualRows(plan);
    return real === null ? num(plan['Plan Rows']) : real;
  }

  function relationLabel(plan) {
    var name = plan['Relation Name'] || plan['CTE Name'] || plan['Function Name'] ||
      plan['Table Function Name'] || plan['Tuplestore Name'] || '';
    var alias = plan.Alias;
    if (!name) return alias || plan['Subplan Name'] || '';
    if (alias && alias !== name) return name + ' (' + alias + ')';
    return name;
  }

  function indexLabel(plan) {
    return plan['Index Name'] || null;
  }

  /* ------------------------------------------------------------------ *
   * Texto de detalhe (tooltip)
   * ------------------------------------------------------------------ */

  var COND_FIELDS = [
    ['Index Cond', 'Index Cond'],
    ['Recheck Cond', 'Recheck Cond'],
    ['Hash Cond', 'Hash Cond'],
    ['Merge Cond', 'Merge Cond'],
    ['Join Filter', 'Join Filter'],
    ['Filter', 'Filter'],
    ['One-Time Filter', 'One-Time Filter'],
    ['TID Cond', 'TID Cond'],
    ['Cache Key', 'Cache Key']
  ];

  var EXTRA_FIELDS = [
    ['Sort Key', 'Sort Key'],
    ['Group Key', 'Group Key'],
    ['Hash Key', 'Hash Key'],
    ['Sort Method', 'Sort Method'],
    ['Sort Space Used', 'Sort Space (kB)'],
    ['Rows Removed by Filter', 'Rows removed by filter'],
    ['Rows Removed by Index Recheck', 'Rows removed by recheck'],
    ['Heap Fetches', 'Heap Fetches'],
    ['Hash Batches', 'Hash Batches'],
    ['Peak Memory Usage', 'Peak memory (kB)'],
    ['Workers Planned', 'Workers planned'],
    ['Workers Launched', 'Workers launched'],
    ['Shared Hit Blocks', 'Blocks from cache'],
    ['Shared Read Blocks', 'Blocks read from disk']
  ];

  function line(label, value) {
    if (value === undefined || value === null || value === '') return '';
    if (Array.isArray(value)) value = value.join(',\n    ');
    return '  ' + label + ': ' + value + '\n';
  }

  function planHint(plan) {
    var text = '*' + (plan['Node Type'] || 'Plan') + '\n';

    var rel = relationLabel(plan);
    if (rel) text += line('Relation', rel);
    if (plan['Index Name']) text += line('Index', plan['Index Name']);
    if (plan['Join Type']) text += line('Join Type', plan['Join Type']);
    if (plan['Strategy']) text += line('Strategy', plan['Strategy']);
    if (plan['Parallel Aware']) text += line('Parallel Aware', 'yes');
    if (plan['Subplan Name']) text += line('Subplan', plan['Subplan Name']);

    var hint = OP_HINTS[plan['Node Type']] || scanStyle(plan['Node Type'])[2];
    if (hint) text += '  ' + hint + '\n';

    text += '\n*Planner estimate\n';
    text += line('Startup cost', fmtNum(num(plan['Startup Cost'])));
    text += line('Total cost', fmtNum(num(plan['Total Cost'])));
    text += line('Rows', fmtNum(num(plan['Plan Rows'])));
    text += line('Width (bytes)', fmtNum(num(plan['Plan Width'])));

    var real = actualRows(plan);
    if (real !== null) {
      text += '\n*Actual execution\n';
      text += line('Time to first row (ms)', fmtNum(num(plan['Actual Startup Time'])));
      text += line('Total time (ms)', fmtNum(num(plan['Actual Total Time'])));
      text += line('Rows', fmtNum(real) +
        (num(plan['Actual Loops']) > 1 ? ' (' + plan['Actual Rows'] + ' x ' +
          plan['Actual Loops'] + ' loops)' : ''));

      var planned = num(plan['Plan Rows']);
      if (planned !== null && planned > 0) {
        var ratio = real / planned;
        var desc;
        if (ratio >= 10) desc = fmtNum(ratio) + 'x more rows than estimated';
        else if (ratio <= 0.1) desc = fmtNum(1 / ratio) + 'x fewer rows than estimated';
        else desc = 'close to the estimate (' + fmtNum(ratio) + 'x)';
        text += line('Estimate', desc);
        if (ratio >= 10 || ratio <= 0.1) {
          text += '    A badly wrong estimate usually leads the planner to the wrong\n' +
            '    plan. Worth running ANALYZE on the table.\n';
        }
      }
    }

    var conds = '';
    for (var i = 0; i < COND_FIELDS.length; i++) {
      conds += line(COND_FIELDS[i][1], plan[COND_FIELDS[i][0]]);
    }
    if (conds) text += '\n*Conditions\n' + conds;

    var extra = '';
    for (var j = 0; j < EXTRA_FIELDS.length; j++) {
      extra += line(EXTRA_FIELDS[j][1], plan[EXTRA_FIELDS[j][0]]);
    }
    if (extra) text += '\n*Detalhes\n' + extra;

    if (plan['Output']) text += '\n' + line('Output', plan['Output']);

    return text;
  }

  /* ------------------------------------------------------------------ *
   * Comportamento comum aos nos do PostgreSQL
   * ------------------------------------------------------------------ */

  function costOf(plan) { return num(plan['Total Cost']); }

  /** Arrow to the parent node, with the cost and row count alongside it. */
  function renderArrowToParent(cr) {
    if (!this.parent) return;
    cr.save();
    cr.set_source_rgba(0, 0, 0, 1);
    if ((this.parent instanceof n.NestedLoopNode) && this.parent.child_aside === this) {
      // enters through the side of the diamond: an L shaped line
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

  function mixinPgNode(proto) {
    proto.get_read_eval_cost = function () { return costOf(this.plan); };
    proto.get_hint_text = function () { return planHint(this.plan); };
    proto.label = function () {
      return '<' + this.plan['Node Type'] + (this.plan['Relation Name']
        ? ': ' + this.plan['Relation Name'] : '') + '>';
    };
    Object.defineProperty(proto, 'rows_count', {
      get: function () { return rowsOf(this.plan); }, configurable: true
    });
  }

  /* ------------------------------------------------------------------ *
   * Scan: colored box with relation and index (TableNode layout)
   * ------------------------------------------------------------------ */

  function PgScanNode(context, plan, child) {
    var style = scanStyle(plan['Node Type']);
    n.TableNode.call(this, context, relationLabel(plan), {
      access_type: plan['Node Type'],
      label: plan['Node Type'],
      color: style[1],
      hint: style[2],
      key_name: indexLabel(plan),
      info: plan,
      rows_examined: rowsOf(plan),
      rows_produced: rowsOf(plan)
    });
    this.plan = plan;
    this.child = child || null;
    if (this.child) this.child.parent = this;
  }
  PgScanNode.prototype = Object.create(n.TableNode.prototype);
  PgScanNode.prototype.constructor = PgScanNode;
  mixinPgNode(PgScanNode.prototype);

  Object.defineProperty(PgScanNode.prototype, 'children', {
    get: function () { return this.child ? [this.child] : []; }
  });

  PgScanNode.prototype.do_render_extras = renderArrowToParent;

  PgScanNode.prototype.do_relayout = function (ctx) {
    // relation names in PostgreSQL tend to be long (partitions, aliases): the box
    // grows with the widest label instead of letting the text overflow
    var i, width = 90;
    for (i = 0; i < this._items.length; i++) {
      this._items[i].set_usize(null, this._items[i]._uheight);
      this._items[i].do_relayout(ctx);
      width = Math.max(width, this._items[i].width);
    }
    for (i = 0; i < this._items.length; i++) {
      this._items[i].set_usize(width, this._items[i]._uheight);
    }
    this._height = this.inner_height;
    VBoxFigure.prototype.do_relayout.call(this, ctx);

    var child = this.child;
    if (!child) return;
    child.do_relayout(ctx);

    // aligns the box with the child's connection point, without leaving the left edge
    var innerW = this.inner_width;
    var figX = child.vconnect_pos_offset - innerW / 2;
    var childX = 0;
    if (figX < 0) { childX = -figX; figX = 0; }

    var dx = figX - this._figure.x;
    for (var i = 0; i < this._items.length; i++) {
      this._items[i].move(this._items[i].x + dx, this._items[i].y);
    }
    child.move(childX, this.inner_height + this._context.vspacing);

    this._width = Math.max(childX + child.width, figX + innerW);
    this._height = this.inner_height + this._context.vspacing + child.height;
  };

  /* ------------------------------------------------------------------ *
   * Join: diamond (NestedLoopNode layout)
   * ------------------------------------------------------------------ */

  function PgJoinNode(context, plan, outer, inner) {
    n.NestedLoopNode.call(this, context, plan['Node Type'], outer, inner);
    this.plan = plan;
  }
  PgJoinNode.prototype = Object.create(n.NestedLoopNode.prototype);
  PgJoinNode.prototype.constructor = PgJoinNode;
  mixinPgNode(PgJoinNode.prototype);

  /* ------------------------------------------------------------------ *
   * Operation: rounded box (OperationNode layout, always vertical)
   * ------------------------------------------------------------------ */

  function opAttrs(plan) {
    var attrs = [];
    var type = plan['Node Type'];
    if (type === 'Sort' || type === 'Incremental Sort') {
      if (plan['Sort Method']) attrs.push(plan['Sort Method']);
    }
    if (num(plan['Hash Batches']) > 1) attrs.push(plan['Hash Batches'] + ' batches');
    if (num(plan['Workers Launched']) > 0) attrs.push(plan['Workers Launched'] + ' workers');
    if (plan['Partial Mode'] && plan['Partial Mode'] !== 'Simple') {
      attrs.push(String(plan['Partial Mode']).toLowerCase());
    }
    if (plan['Operation'] && type === 'ModifyTable') attrs.push(String(plan.Operation).toLowerCase());
    return attrs;
  }

  function opColor(plan) {
    var type = plan['Node Type'];
    // sorting or hashing on disk costs far more: bump the color up
    if ((type === 'Sort' || type === 'Incremental Sort') &&
      /disk/i.test(plan['Sort Method'] || '')) return RED;
    if (type === 'Hash' && num(plan['Hash Batches']) > 1) return ORANGE;
    if (type === 'HashAggregate' && num(plan['Disk Usage']) > 0) return ORANGE;
    return OP_COLORS[type] || YELLOW;
  }

  function PgOpNode(context, plan, child) {
    n.OperationNode.call(this, context, plan['Node Type'], child || null, null, {}, null, {
      caption: plan['Node Type'],
      color: opColor(plan),
      attrs: opAttrs(plan)
    });
    this.plan = plan;
  }
  PgOpNode.prototype = Object.create(n.OperationNode.prototype);
  PgOpNode.prototype.constructor = PgOpNode;
  mixinPgNode(PgOpNode.prototype);

  PgOpNode.prototype.do_render_extras = renderArrowToParent;

  PgOpNode.prototype.do_relayout = function (ctx) {
    VBoxFigure.prototype.do_relayout.call(this, ctx);

    var child = this.child;
    if (child) {
      child.do_relayout(ctx);
      var figW = this._figure.width;
      if (child.width > figW) {
        var figX = child.vconnect_pos_offset - figW / 2;
        if (figX < 0) figX = 0;
        this._figure.move(figX, 0);
        child.move(0, this._figure.height + this._context.vspacing);
        this._width = Math.max(child.width, figX + figW);
      } else {
        this._figure.move(0, 0);
        child.move((figW - child.width) / 2, this._figure.height + this._context.vspacing);
        this._width = figW;
      }
      this._height = child.height + this._context.vspacing + this.inner_height;
    }

    if (this._figure_message) {
      this._figure_message.set_usize(this._figure.width, null);
      this._figure_message.move(this._figure.x, this._figure.y + this._figure.height + 4);
    }
  };

  /* ------------------------------------------------------------------ *
   * N-ary: bar with the children side by side (SubQueries layout)
   * ------------------------------------------------------------------ */

  function PgGroupNode(context, plan, children) {
    // SubQueries places children right to left; reversing keeps them
    // in plan order
    n.SubQueries.call(this, context, plan['Node Type'], children.slice().reverse());
    this.plan = plan;
    this.set_spacing(4);
    this._figure.set_line_dash(null, null);
    this._figure.set_color(0, 0, 0, 1);
    this._figure.set_fill_color(0.78, 0.78, 0.78, 1);
    this._figure.set_font_bold(true);
  }
  PgGroupNode.prototype = Object.create(n.SubQueries.prototype);
  PgGroupNode.prototype.constructor = PgGroupNode;
  mixinPgNode(PgGroupNode.prototype);

  PgGroupNode.prototype.do_render_extras = renderArrowToParent;

  /* ------------------------------------------------------------------ *
   * Raiz do plano
   * ------------------------------------------------------------------ */

  function PgPlanNode(context, child, info) {
    n.QueryBlockNode.call(this, context, child, null, null, info || {}, null);
    this._figure.set_text('query plan');
  }
  PgPlanNode.prototype = Object.create(n.QueryBlockNode.prototype);
  PgPlanNode.prototype.constructor = PgPlanNode;

  PgPlanNode.prototype.label = function () { return 'query plan'; };

  PgPlanNode.prototype.render_cost = function (cr, x, y) {
    var plan = this.info.Plan || {};
    var parts = [];
    if (num(plan['Total Cost']) !== null) parts.push('Total cost: ' + fmtNum(plan['Total Cost']));
    if (num(this.info['Execution Time']) !== null) {
      parts.push('Execution: ' + fmtNum(this.info['Execution Time']) + ' ms');
    }
    if (!parts.length) return;
    cr.set_source_rgba(0, 0, 0, 1);
    cr.set_font_size(10);
    cr.move_to(x, y);
    cr.show_text(parts.join('  |  '));
  };

  PgPlanNode.prototype.get_hint_text = function () {
    var text = '*Query plan\n';
    var plan = this.info.Plan || {};
    text += line('Estimated total cost', fmtNum(num(plan['Total Cost'])));
    text += line('Estimated rows', fmtNum(num(plan['Plan Rows'])));
    if (num(this.info['Planning Time']) !== null) {
      text += line('Planning Time (ms)', fmtNum(this.info['Planning Time']));
    }
    if (num(this.info['Execution Time']) !== null) {
      text += line('Execution Time (ms)', fmtNum(this.info['Execution Time']));
    }
    if (this.info['Triggers'] && this.info['Triggers'].length) {
      text += '\n*Triggers\n';
      for (var i = 0; i < this.info['Triggers'].length; i++) {
        var t = this.info['Triggers'][i];
        text += line(t['Trigger Name'] || 'trigger',
          fmtNum(num(t.Time)) + ' ms / ' + t.Calls + ' chamadas');
      }
    }
    return text;
  };

  /* ------------------------------------------------------------------ *
   * Legend
   * ------------------------------------------------------------------ */

  function legend() {
    var items = [];
    for (var i = 0; i < SCAN_TYPES.length; i++) {
      items.push([SCAN_TYPES[i][0], SCAN_TYPES[i][1], SCAN_TYPES[i][0]]);
    }
    return items;
  }

  global.VE.pgNodes = {
    isJoin: isJoin,
    isScan: isScan,
    rowsOf: rowsOf,
    PgScanNode: PgScanNode,
    PgJoinNode: PgJoinNode,
    PgOpNode: PgOpNode,
    PgGroupNode: PgGroupNode,
    PgPlanNode: PgPlanNode,
    legend: legend
  };
})(window);
