/*
 * explain.js - transforma o JSON do EXPLAIN em arvore de nos, calcula o layout
 * e desenha o resultado dentro de um grupo SVG.
 *
 * Porte client-side do renderer do MySQL Workbench (Visual Explain).
 * Original: Copyright (c) 2012, 2021, Oracle and/or its affiliates - GPL v2.
 */
(function (global) {
  'use strict';

  var g = global.VE.graphics;
  var n = global.VE.nodes;

  function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function keyCount(obj) { return Object.keys(obj).length; }

  function ExplainContext(json, options) {
    options = options || {};
    this._json = json;
    this.warnings = [];

    // constantes de layout (iguais as do Workbench)
    this.default_height = 65;
    this.vspacing = 50;
    this.hspacing = 50;
    this.small_vspacing = 30;
    this.small_hspacing = 30;
    this.frame_padding = 10;
    this.global_padding = 20;

    // margem da imagem final, depois de recortar o espaco em branco
    this.pad_x = 15;
    this.pad_y = 10;
    this.offset = [0, 0];

    this.displayed_cost_info = options.displayed_cost_info || null;
    this.cost_value_is_amount = false;
    this.size = null;

    var nodes = this.process_explain_output(json);
    this._root = nodes.length ? nodes[0] : null;
  }

  ExplainContext.prototype.dialect = 'mysql';

  ExplainContext.prototype.unexpected = function (node, context) {
    var msg = context
      ? 'no inesperado em ' + context + ': ' + node
      : 'no inesperado: ' + node;
    this.warnings.push(msg);
  };

  ExplainContext.prototype.fmt_cost = function (value) {
    if (this.cost_value_is_amount) return n.fmt_number(value);
    return String(Math.round(value * 100) / 100);
  };

  ExplainContext.prototype.show_cost_info_type = function (name) {
    this.cost_value_is_amount = name === 'data_read_per_join';
    this.displayed_cost_info = name;
  };

  /* ------------------------------------------------------------------ *
   * Parser do JSON
   * ------------------------------------------------------------------ */

  ExplainContext.prototype.handle_table = function (table) {
    var name = table.table_name || '';
    var materialized_from_subquery = table.materialized_from_subquery;
    var materialized_from_subquery_node = null;
    var materialized_attributes = {};

    if (materialized_from_subquery) {
      var res = this.handle_materialized_from_subquery('materialized_from_subquery',
        materialized_from_subquery);
      materialized_from_subquery_node = res[0];
      materialized_attributes = res[1];
    }

    var attached_subqueries = null;
    if (table.attached_subqueries) {
      attached_subqueries = this.handle_attached_subqueries('attached_subqueries',
        table.attached_subqueries);
    }

    if (!('rows_examined_per_scan' in table)) {
      table.rows_examined_per_scan = table.rows || 0;
    }
    if (!('rows_produced_per_join' in table)) {
      var filtered = parseFloat(table.filtered);
      if (isNaN(filtered)) filtered = 0;
      table.rows_produced_per_join = (table.rows || 0) * Math.trunc(filtered) / 100;
    }

    var opts = {
      attached_subqueries: attached_subqueries,
      access_type: table.access_type || '',
      key_name: table.key === undefined ? null : table.key,
      info: table,
      cost_info: table.cost_info,
      rows_examined: table.rows_examined_per_scan,
      rows_produced: table.rows_produced_per_join
    };

    // tabelas com materialized_from_subquery nao sao tabelas de verdade:
    // viram um container com a subquery que as gera
    if (materialized_from_subquery_node) {
      opts.materialized_from = materialized_from_subquery_node;
      opts.materialize_attributes = materialized_attributes;
      return new n.MaterializedTableNode(this, name, opts);
    }
    return new n.TableNode(this, name, opts);
  };

  ExplainContext.prototype.handle_nested_loop = function (data) {
    var parts = [];
    for (var i = 0; i < data.length; i++) {
      var node = data[i];
      if (isObject(node) && keyCount(node) === 1 && 'table' in node) {
        parts.push(this.handle_table(node.table));
        if (parts.length === 2) {
          var join_buffer = 'using_join_buffer' in node.table
            ? node.table.using_join_buffer : 'nested_loop';
          parts = [new n.NestedLoopNode(this, join_buffer, parts[0], parts[1])];
        }
      } else if (isObject(node) && keyCount(node) === 1 && 'duplicates_removal' in node) {
        parts.push(this.handle_query_block('duplicates_removal', node.duplicates_removal));
        if (parts.length === 2) {
          parts = [new n.NestedLoopNode(this, 'nested_loop', parts[0], parts[1])];
        }
      } else {
        this.unexpected(Object.keys(node || {}).join(', '), 'nested_loop');
      }
    }
    if (parts.length !== 1) {
      throw new Error('nested_loop com estrutura inesperada');
    }
    return parts[0];
  };

  ExplainContext.prototype.handle_optimized_away_subqueries = function (name, subquery_list) {
    var subqueries = [];
    for (var i = 0; i < subquery_list.length; i++) {
      var data = subquery_list[i];
      var qblock = null;
      var attributes = {};
      for (var key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        var value = data[key];
        if (key === 'query_block') {
          qblock = this.handle_query_block(key, value, true);
        } else if (key === 'dependent' || key === 'cacheable' || key === 'using_temporary_table') {
          attributes[key] = value;
        } else {
          this.unexpected(key, name);
        }
      }
      if (qblock) {
        if (qblock.set_attributes) qblock.set_attributes(attributes);
        subqueries.push(qblock);
      }
    }
    return new n.SubQueries(this, name, subqueries);
  };

  ExplainContext.prototype.handle_attached_subqueries = function (name, subquery_list) {
    var subqueries = [];
    for (var i = 0; i < subquery_list.length; i++) {
      var data = subquery_list[i];
      var qblock = null;
      var attributes = {};
      for (var key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        var value = data[key];
        if (key === 'query_block') {
          qblock = this.handle_query_block(key, value, true);
        } else if (key === 'dependent' || key === 'cacheable' || key === 'using_temporary_table') {
          attributes[key] = value;
        } else if (key === 'table') {
          qblock = this.handle_table(value);
        } else {
          this.unexpected(key, name);
        }
      }
      if (qblock) {
        if (keyCount(attributes) && qblock.set_attributes) qblock.set_attributes(attributes);
        subqueries.push(qblock);
      }
    }
    return new n.SubQueries(this, name, subqueries);
  };

  ExplainContext.prototype.handle_materialized_from_subquery = function (name, data) {
    var inner_qblock = null;
    var attributes = {};
    for (var key in data) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      var value = data[key];
      if (key === 'query_block') {
        inner_qblock = this.handle_query_block(key, value, true, true);
      } else if (key === 'dependent' || key === 'cacheable' || key === 'using_temporary_table') {
        attributes[key] = value;
      } else {
        this.unexpected(key, name);
      }
    }
    return [inner_qblock, attributes];
  };

  ExplainContext.prototype.handle_union_result = function (name, data) {
    var info = {};
    var qblocks = [];
    for (var key in data) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      var value = data[key];
      if (key === 'using_temporary_table' || key === 'access_type' || key === 'table_name') {
        info[key] = value;
      } else if (key === 'query_specifications') {
        for (var i = 0; i < value.length; i++) {
          qblocks.push(this.handle_query_block('query_block', value[i].query_block));
        }
      } else {
        this.unexpected(key, name);
      }
    }
    return new n.UnionResult(this, info, qblocks);
  };

  ExplainContext.prototype.handle_query_block = function (name, data, is_subquery, is_materialized) {
    var content = null;
    var cost_info = null;
    var attributes = {};
    var select_list_subqueries = null;
    var optimized_away_subqueries = null;

    for (var key in data) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      var value = data[key];
      if (key === 'nested_loop') {
        content = this.handle_nested_loop(value);
      } else if (key === 'table') {
        // no 5.6 um query_block podia ter uma tabela so com message: "No tables used"
        if ('message' in value && keyCount(value) === 1) {
          data.message = value.message;
        } else {
          content = this.handle_table(value);
        }
      } else if (key === 'optimized_away_subqueries') {
        optimized_away_subqueries = this.handle_optimized_away_subqueries(key, value);
      } else if (key === 'grouping_operation' || key === 'ordering_operation' ||
        key === 'duplicates_removal') {
        content = this.handle_query_block(key, value);
      } else if (key === 'using_temporary_table' || key === 'using_filesort' ||
        key === 'dependent') {
        attributes[key] = value;
      } else if (key === 'cost_info') {
        cost_info = value;
      } else if (key === 'select_id' || key === 'message') {
        /* usados diretamente pelo no */
      } else if (key === 'union_result') {
        // o query_block pai e redundante aqui, ele tem um unico filho
        content = this.handle_union_result(key, value);
      } else if (key === 'select_list_subqueries') {
        select_list_subqueries = this.handle_attached_subqueries(key, value);
      } else if (key === 'buffer_result') {
        content = this.handle_query_block(key, value);
      } else {
        this.unexpected(key, name);
      }
    }

    if (name === 'query_block') {
      if (is_materialized) return content;
      if (is_subquery) {
        return new n.SubQueryBlockNode(this, content, optimized_away_subqueries,
          select_list_subqueries, data, cost_info);
      }
      return new n.QueryBlockNode(this, content, optimized_away_subqueries,
        select_list_subqueries, data, cost_info);
    }
    if (name === 'buffer_result') {
      return new n.MaterializedJoinNode(this, name, content, data, cost_info, attributes);
    }
    return new n.OperationNode(this, name, content, cost_info, attributes,
      optimized_away_subqueries);
  };

  ExplainContext.prototype.process_explain_output = function (data) {
    var output = [];
    for (var key in data) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      if (key === 'query_block') output.push(this.handle_query_block(key, data[key]));
    }
    return output;
  };

  /* ------------------------------------------------------------------ *
   * Layout e desenho
   * ------------------------------------------------------------------ */

  ExplainContext.prototype.layout = function () {
    if (!this._root) return null;

    // o root recebe fundo cinza, como no Workbench
    this._root._figure.set_fill_color(0.8, 0.8, 0.8, 1);

    var measureGroup = document.createElementNS(g.SVGNS, 'g');
    var cr = new g.SvgContext(measureGroup);

    // duas passadas, como no original (uma em layout(), outra no repaint):
    // figuras com HFill - a barra do UNION, o quadro de attached_subqueries -
    // se esticam ate a largura total que a passada anterior calculou.
    this._root.do_relayout(cr);
    this._root.do_relayout(cr);
    this._root.move(this.global_padding, this.global_padding);

    var size = this._root.size;
    this.size = [Math.ceil(size[0] + this.global_padding * 2),
      Math.ceil(size[1] + this.global_padding * 2)];
    return this.size;
  };

  /**
   * Bounding box do que foi realmente desenhado, somando a espessura dos tracos.
   * O layout reserva mais espaco do que o desenho ocupa, entao e isso que define
   * o tamanho final da imagem.
   */
  function inkBounds(root) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var els = root.querySelectorAll('path, text, rect, line, polyline, polygon, circle, ellipse');

    for (var i = 0; i < els.length; i++) {
      var e = els[i], box;
      try {
        box = e.getBBox();
      } catch (err) {
        continue;
      }
      if (!box || (!box.width && !box.height)) continue;

      var margin = 0;
      var stroke = e.getAttribute('stroke');
      if (stroke && stroke !== 'none') {
        var sw = parseFloat(e.getAttribute('stroke-width'));
        if (!isNaN(sw)) margin = sw / 2;
      }
      minX = Math.min(minX, box.x - margin);
      minY = Math.min(minY, box.y - margin);
      maxX = Math.max(maxX, box.x + box.width + margin);
      maxY = Math.max(maxY, box.y + box.height + margin);
    }

    if (!isFinite(minX)) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /** Mede mesmo que o grupo ainda nao esteja no documento (getBBox exige render). */
  function measureInk(el) {
    if (el.isConnected) return inkBounds(el);

    var host = document.createElementNS(g.SVGNS, 'svg');
    host.setAttribute('style',
      'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden');
    var parent = el.parentNode;
    var next = el.nextSibling;
    document.body.appendChild(host);
    host.appendChild(el);

    var box = inkBounds(el);

    if (parent) parent.insertBefore(el, next);
    host.remove();
    return box;
  }

  /**
   * Desenha o diagrama dentro do grupo SVG informado, recortado no conteudo:
   * a arvore vai num subgrupo deslocado, o fundo branco cobre exatamente a
   * area final e `this.size` passa a valer o tamanho da imagem recortada.
   */
  ExplainContext.prototype.render = function (group) {
    if (!this._root) return;
    if (!this.size) this.layout();

    var inner = document.createElementNS(g.SVGNS, 'g');
    group.appendChild(inner);
    this._root.render(new g.SvgContext(inner));

    var box = measureInk(inner);
    if (box) {
      this.offset = [Math.round(this.pad_x - box.x), Math.round(this.pad_y - box.y)];
      this.size = [Math.ceil(box.width + this.pad_x * 2), Math.ceil(box.height + this.pad_y * 2)];
    } else {
      this.offset = [0, 0];
    }
    inner.setAttribute('transform',
      'translate(' + this.offset[0] + ',' + this.offset[1] + ')');

    var bg = document.createElementNS(g.SVGNS, 'rect');
    bg.setAttribute('x', 0);
    bg.setAttribute('y', 0);
    bg.setAttribute('width', this.size[0]);
    bg.setAttribute('height', this.size[1]);
    bg.setAttribute('fill', '#ffffff');
    group.insertBefore(bg, inner);
  };

  /** Lista de nos em pre-ordem, usada para tooltips e destaque. */
  ExplainContext.prototype.collectNodes = function () {
    var out = [];
    (function walk(node, depth) {
      if (!node) return;
      out.push({ node: node, depth: depth });
      var children = node.children;
      for (var i = 0; i < children.length; i++) walk(children[i], depth + 1);
    })(this._root, 0);
    return out;
  };

  /** Retangulo (absoluto) da figura interna do no, para hit testing. */
  function nodeRect(node) {
    return {
      x: node._figure.root_x,
      y: node._figure.root_y,
      w: node.inner_width,
      h: node.inner_height
    };
  }

  global.VE.ExplainContext = ExplainContext;
  global.VE.nodeRect = nodeRect;
})(window);
