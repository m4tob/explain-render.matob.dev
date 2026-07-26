/*
 * nodes-pg.js - nos do plano do PostgreSQL.
 *
 * Reusa o layout e o desenho das figuras do dialeto MySQL (nodes.js), trocando
 * apenas a semantica: cores por Node Type, rotulos, custos e o texto de detalhe.
 *
 *   scans (Seq Scan, Index Scan, ...)      -> caixa colorida + relacao + indice
 *   joins (Nested Loop, Hash Join, ...)    -> losango
 *   operacoes (Sort, Aggregate, Hash, ...) -> caixa arredondada
 *   n-arios (Append, BitmapOr, ...)        -> barra com os filhos lado a lado
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
   * Tipos de no
   * ------------------------------------------------------------------ */

  var JOIN_TYPES = ['Nested Loop', 'Hash Join', 'Merge Join'];

  // [Node Type, cor, dica de custo]
  var SCAN_TYPES = [
    ['Seq Scan', RED,
      'Alto - le a tabela inteira. Um indice ajuda se o filtro for seletivo.'],
    ['Parallel Seq Scan', ORANGE,
      'Alto, porem dividido entre workers paralelos.'],
    ['Index Scan', GREEN,
      'Baixo - encontra as linhas pelo indice e busca cada uma na heap.'],
    ['Index Only Scan', BLUE,
      'Muito baixo - responde so com o indice, sem ler a heap (depende do visibility map).'],
    ['Bitmap Index Scan', GREEN,
      'Baixo - monta um bitmap dos blocos que interessam, sem ler a heap ainda.'],
    ['Bitmap Heap Scan', ORANGE,
      'Medio - le a heap em ordem de bloco a partir do bitmap. Comum quando o filtro pega muitas linhas.'],
    ['Tid Scan', BLUE, 'Muito baixo - acesso direto por ctid.'],
    ['CTE Scan', ORANGE, 'Le o resultado ja materializado de uma CTE.'],
    ['WorkTable Scan', ORANGE, 'Le a work table de uma CTE recursiva.'],
    ['Subquery Scan', ORANGE, 'Le o resultado de uma subquery.'],
    ['Function Scan', YELLOW, 'Le o retorno de uma funcao.'],
    ['Table Function Scan', YELLOW, 'Le o retorno de uma funcao de tabela.'],
    ['Values Scan', BLUE, 'Le uma lista VALUES constante.'],
    ['Named Tuplestore Scan', ORANGE, 'Le um tuplestore nomeado (tabela de transicao de trigger).'],
    ['Sample Scan', ORANGE, 'Le uma amostra da tabela (TABLESAMPLE).'],
    ['Foreign Scan', ORANGE, 'Le uma tabela externa via FDW. O custo depende do servidor remoto.']
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
    'Sort': 'Ordena o resultado. Em disco (external merge) custa bem mais que em memoria.',
    'Incremental Sort': 'Ordena aproveitando parte da ordem que ja vinha pronta.',
    'Aggregate': 'Calcula agregacoes.',
    'HashAggregate': 'Agrupa em uma hash table. Se estourar work_mem, vaza para disco.',
    'GroupAggregate': 'Agrupa aproveitando a entrada ja ordenada.',
    'Hash': 'Monta a hash table do lado interno do Hash Join. Mais de um batch significa disco.',
    'Materialize': 'Guarda o resultado do filho para poder reler sem recalcular.',
    'Memoize': 'Cacheia resultados do lado interno por chave, evitando repetir a busca.',
    'Unique': 'Remove duplicatas de uma entrada ordenada.',
    'WindowAgg': 'Aplica funcoes de janela.',
    'Limit': 'Interrompe a leitura depois de N linhas.',
    'Gather': 'Junta o resultado dos workers paralelos.',
    'Gather Merge': 'Junta o resultado dos workers preservando a ordenacao.',
    'Append': 'Concatena os filhos (UNION ALL, particoes).',
    'Merge Append': 'Concatena os filhos preservando a ordenacao.',
    'BitmapAnd': 'Cruza bitmaps de varios indices (AND).',
    'BitmapOr': 'Une bitmaps de varios indices (OR).',
    'Recursive Union': 'Executa a parte recursiva de uma CTE WITH RECURSIVE.',
    'Nested Loop': 'Para cada linha do lado externo, varre o lado interno. Bom quando o externo tem poucas linhas.',
    'Hash Join': 'Monta uma hash do lado interno e sonda com o externo. Bom para volumes maiores.',
    'Merge Join': 'Percorre os dois lados ja ordenados em paralelo.'
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

  /** Linhas que saem do no: o numero real quando houver ANALYZE, senao a estimativa. */
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
    ['Rows Removed by Filter', 'Linhas descartadas pelo filtro'],
    ['Rows Removed by Index Recheck', 'Linhas descartadas no recheck'],
    ['Heap Fetches', 'Heap Fetches'],
    ['Hash Batches', 'Hash Batches'],
    ['Peak Memory Usage', 'Pico de memoria (kB)'],
    ['Workers Planned', 'Workers planejados'],
    ['Workers Launched', 'Workers ativos'],
    ['Shared Hit Blocks', 'Blocos em cache'],
    ['Shared Read Blocks', 'Blocos lidos do disco']
  ];

  function line(label, value) {
    if (value === undefined || value === null || value === '') return '';
    if (Array.isArray(value)) value = value.join(',\n    ');
    return '  ' + label + ': ' + value + '\n';
  }

  function planHint(plan) {
    var text = '*' + (plan['Node Type'] || 'Plan') + '\n';

    var rel = relationLabel(plan);
    if (rel) text += line('Relacao', rel);
    if (plan['Index Name']) text += line('Indice', plan['Index Name']);
    if (plan['Join Type']) text += line('Join Type', plan['Join Type']);
    if (plan['Strategy']) text += line('Strategy', plan['Strategy']);
    if (plan['Parallel Aware']) text += line('Parallel Aware', 'sim');
    if (plan['Subplan Name']) text += line('Subplan', plan['Subplan Name']);

    var hint = OP_HINTS[plan['Node Type']] || scanStyle(plan['Node Type'])[2];
    if (hint) text += '  ' + hint + '\n';

    text += '\n*Estimativa do planner\n';
    text += line('Custo inicial', fmtNum(num(plan['Startup Cost'])));
    text += line('Custo total', fmtNum(num(plan['Total Cost'])));
    text += line('Linhas', fmtNum(num(plan['Plan Rows'])));
    text += line('Largura (bytes)', fmtNum(num(plan['Plan Width'])));

    var real = actualRows(plan);
    if (real !== null) {
      text += '\n*Execucao real\n';
      text += line('Tempo ate a 1a linha (ms)', fmtNum(num(plan['Actual Startup Time'])));
      text += line('Tempo total (ms)', fmtNum(num(plan['Actual Total Time'])));
      text += line('Linhas', fmtNum(real) +
        (num(plan['Actual Loops']) > 1 ? ' (' + plan['Actual Rows'] + ' x ' +
          plan['Actual Loops'] + ' loops)' : ''));

      var planned = num(plan['Plan Rows']);
      if (planned !== null && planned > 0) {
        var ratio = real / planned;
        var desc;
        if (ratio >= 10) desc = fmtNum(ratio) + 'x mais linhas que o previsto';
        else if (ratio <= 0.1) desc = fmtNum(1 / ratio) + 'x menos linhas que o previsto';
        else desc = 'proxima do previsto (' + fmtNum(ratio) + 'x)';
        text += line('Estimativa', desc);
        if (ratio >= 10 || ratio <= 0.1) {
          text += '    Estimativa muito errada costuma levar o planner a escolher\n' +
            '    o plano errado. Vale rodar ANALYZE na tabela.\n';
        }
      }
    }

    var conds = '';
    for (var i = 0; i < COND_FIELDS.length; i++) {
      conds += line(COND_FIELDS[i][1], plan[COND_FIELDS[i][0]]);
    }
    if (conds) text += '\n*Condicoes\n' + conds;

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

  /** Seta para o no pai, mais o custo e a contagem de linhas ao lado dela. */
  function renderArrowToParent(cr) {
    if (!this.parent) return;
    cr.save();
    cr.set_source_rgba(0, 0, 0, 1);
    if ((this.parent instanceof n.NestedLoopNode) && this.parent.child_aside === this) {
      // entra pela lateral do losango: linha em L
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
   * Scan: caixa colorida com relacao e indice (layout do TableNode)
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
    // nomes de relacao no PostgreSQL costumam ser longos (particoes, alias):
    // a caixa acompanha o rotulo mais largo em vez de deixar o texto transbordar
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

    // alinha a caixa com o ponto de conexao do filho, sem sair do lado esquerdo
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
   * Join: losango (layout do NestedLoopNode)
   * ------------------------------------------------------------------ */

  function PgJoinNode(context, plan, outer, inner) {
    n.NestedLoopNode.call(this, context, plan['Node Type'], outer, inner);
    this.plan = plan;
  }
  PgJoinNode.prototype = Object.create(n.NestedLoopNode.prototype);
  PgJoinNode.prototype.constructor = PgJoinNode;
  mixinPgNode(PgJoinNode.prototype);

  /* ------------------------------------------------------------------ *
   * Operacao: caixa arredondada (layout do OperationNode, sempre vertical)
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
    // ordenacao ou hash em disco custam bem mais: sobem de cor
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
   * N-ario: barra com os filhos lado a lado (layout do SubQueries)
   * ------------------------------------------------------------------ */

  function PgGroupNode(context, plan, children) {
    // o SubQueries posiciona da direita para a esquerda; invertendo, os filhos
    // aparecem na ordem do plano
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
    if (num(plan['Total Cost']) !== null) parts.push('Custo total: ' + fmtNum(plan['Total Cost']));
    if (num(this.info['Execution Time']) !== null) {
      parts.push('Execucao: ' + fmtNum(this.info['Execution Time']) + ' ms');
    }
    if (!parts.length) return;
    cr.set_source_rgba(0, 0, 0, 1);
    cr.set_font_size(10);
    cr.move_to(x, y);
    cr.show_text(parts.join('  |  '));
  };

  PgPlanNode.prototype.get_hint_text = function () {
    var text = '*Plano da query\n';
    var plan = this.info.Plan || {};
    text += line('Custo total estimado', fmtNum(num(plan['Total Cost'])));
    text += line('Linhas estimadas', fmtNum(num(plan['Plan Rows'])));
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
   * Legenda
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
