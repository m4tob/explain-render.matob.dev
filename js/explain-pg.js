/*
 * explain-pg.js - le a saida de EXPLAIN (FORMAT JSON) do PostgreSQL e monta a
 * arvore de nos. Herda de ExplainContext: layout, recorte, desenho e coleta de
 * nos sao os mesmos do dialeto MySQL.
 */
(function (global) {
  'use strict';

  var pg = global.VE.pgNodes;
  var ExplainContext = global.VE.ExplainContext;

  function PgExplainContext(json, options) {
    ExplainContext.call(this, json, options);
  }
  PgExplainContext.prototype = Object.create(ExplainContext.prototype);
  PgExplainContext.prototype.constructor = PgExplainContext;

  PgExplainContext.prototype.dialect = 'postgres';

  /**
   * Um no do plano vira:
   *   losango  - join com exatamente 2 entradas
   *   barra    - qualquer outro no com 2 ou mais entradas (Append, BitmapOr, ...)
   *   caixa    - 0 ou 1 entrada (scan colorido ou operacao arredondada)
   */
  PgExplainContext.prototype.handle_plan = function (plan) {
    var subplans = plan.Plans || [];
    var children = [];
    for (var i = 0; i < subplans.length; i++) {
      children.push(this.handle_plan(subplans[i]));
    }

    var type = plan['Node Type'];
    if (!type) {
      this.unexpected('no sem "Node Type"', 'Plan');
      type = plan['Node Type'] = 'Plan';
    }

    if (pg.isJoin(type) && children.length === 2) {
      return new pg.PgJoinNode(this, plan, children[0], children[1]);
    }
    if (children.length >= 2) {
      // inclui um join que veio com subplans junto das duas entradas
      return new pg.PgGroupNode(this, plan, children);
    }
    if (pg.isScan(type)) {
      return new pg.PgScanNode(this, plan, children[0]);
    }
    return new pg.PgOpNode(this, plan, children[0]);
  };

  PgExplainContext.prototype.process_explain_output = function (data) {
    var root = Array.isArray(data) ? data[0] : data;
    if (!root || typeof root !== 'object' || !root.Plan) {
      this.unexpected('JSON sem a chave "Plan"', 'EXPLAIN');
      return [];
    }
    if (Array.isArray(data) && data.length > 1) {
      this.warnings.push('o JSON traz ' + data.length +
        ' planos; apenas o primeiro foi desenhado');
    }
    return [new pg.PgPlanNode(this, this.handle_plan(root.Plan), root)];
  };

  global.VE.PgExplainContext = PgExplainContext;
})(window);
