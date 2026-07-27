/*
 * explain-pg.js - reads PostgreSQL's EXPLAIN (FORMAT JSON) output and builds the
 * node tree. Inherits from ExplainContext: layout, cropping, drawing and node
 * collection are the same as in the MySQL dialect.
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
   * A plan node becomes:
   *   diamond - a join with exactly 2 inputs
   *   bar     - any other node with 2 or more inputs (Append, BitmapOr, ...)
   *   box     - 0 or 1 input (a colored scan or a rounded operation)
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
      // this includes a join that arrived with subplans next to its two inputs
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
        ' plans; only the first one was drawn');
    }
    return [new pg.PgPlanNode(this, this.handle_plan(root.Plan), root)];
  };

  global.VE.PgExplainContext = PgExplainContext;
})(window);
