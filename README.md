# EXPLAIN Render

Transforma o plano de execucao de uma query, em JSON, em um diagrama - e exporta em
**SVG** (vetorial) ou PNG. Roda inteiramente no navegador, em HTML, CSS e JavaScript
puros: sem backend, sem build, sem dependencias.

Entende dois dialetos, detectados automaticamente pela forma do JSON:

| Banco | Comando | Raiz do JSON |
|---|---|---|
| MySQL | `EXPLAIN FORMAT=JSON <query>;` | objeto com `query_block` |
| PostgreSQL | `EXPLAIN (FORMAT JSON) <query>;` | array com `Plan` |

O ponto de partida foi o `mysql-visual-explain-server` (Flask + cairo + um CLI em
Python): o mesmo diagrama do Visual Explain do MySQL Workbench, reescrito para o
navegador e depois estendido para o PostgreSQL.

## O que ele faz

- Desenha a arvore de execucao com cores por custo, espessura de seta proporcional ao
  numero de linhas, e o custo e a contagem de linhas em cada aresta.
- **MySQL**: tabelas, nested loops (incluindo block nested loop e batched key access),
  `GROUP` / `ORDER` / `DISTINCT`, subqueries anexadas, subqueries no SELECT, tabelas
  materializadas, joins materializados (`buffer_result`) e `UNION`.
- **PostgreSQL**: scans (Seq, Index, Index Only, Bitmap, CTE, Function, Foreign, ...),
  joins (Nested Loop, Hash Join, Merge Join), operacoes (Sort, Aggregate, Hash,
  Materialize, Memoize, Gather, Limit, ...) e nos n-arios (Append, Merge Append,
  BitmapAnd, BitmapOr, Recursive Union).
- Com `EXPLAIN (FORMAT JSON, ANALYZE)`, o detalhe de cada no compara o previsto com o
  que aconteceu e avisa quando a estimativa erra por 10x ou mais - que e onde costuma
  estar a causa de um plano ruim.
- Detalhes do no (chave usada, condicoes, custos, tempos) ao passar o mouse.
- Zoom com a roda do mouse, arrastar para mover, ajustar a tela, duplo clique para
  reenquadrar.
- Exporta SVG, exporta PNG em 2x e copia o SVG para a area de transferencia. A imagem
  sai recortada no conteudo, com margem de 15px nas laterais e 10px em cima e embaixo.
- Exemplos prontos dos dois bancos, tema claro/escuro e persistencia do ultimo JSON.

Nada e enviado para servidor nenhum: todo o processamento acontece na maquina do usuario.

## Como usar

Abra o `index.html` direto no navegador (funciona via `file://`) ou sirva a pasta:

```
python3 -m http.server 8000
```

Cole o JSON no campo da esquerda. O texto pode vir sujo: cabecalho `EXPLAIN:`, saida de
`\G` do cliente mysql, `QUERY PLAN` com os `+` de continuacao do psql, rodape do tipo
`1 row in set`. O parser recorta o objeto JSON sozinho.

## Estrutura

```
index.html          layout da aplicacao
css/style.css       estilos (tema claro/escuro)
js/graphics.js      medicao de texto e contexto de desenho estilo cairo que emite SVG
js/nodes.js         nos do diagrama: layout e desenho de cada tipo de figura
js/nodes-pg.js      nos do PostgreSQL, reusando o layout de nodes.js
js/explain.js       parser do EXPLAIN do MySQL, layout geral e render no SVG
js/explain-pg.js    parser do EXPLAIN do PostgreSQL (herda de explain.js)
js/samples.js       exemplos dos dois bancos
js/app.js           interface: entrada, deteccao de dialeto, zoom/pan, tooltips, export
tools/e2e.mjs       teste end-to-end em Chrome headless
```

### Como funciona

1. O parser do dialeto percorre o JSON e monta a arvore de nos. No MySQL a estrutura vem
   de chaves nomeadas (`nested_loop`, `grouping_operation`, `table`, `union_result`); no
   PostgreSQL vem de um array `Plans` recursivo, e a forma do no e escolhida pela
   quantidade de entradas: 2 entradas com tipo de join viram losango, 2 ou mais entradas
   viram uma barra com os filhos lado a lado, o resto vira caixa.
2. Cada no calcula o proprio tamanho e posiciona os filhos (`do_relayout`). O texto e
   medido com `canvas.measureText`, que devolve as mesmas metricas que o
   `cairo_text_extents` usava (bearing, advance, ascent e descent).
3. O desenho usa um contexto com a API do cairo (`move_to`, `line_to`, `fill`,
   `show_text`, ...) que, em vez de rasterizar, emite elementos SVG. Por isso o que
   aparece na tela e exatamente o que e exportado: o export e o mesmo SVG, sem
   conversao intermediaria.
4. Depois de desenhar, `inkBounds()` mede o bounding box do que foi realmente pintado
   (somando metade da espessura de cada traco, ja que `getBBox()` ignora o stroke) e
   recorta a imagem nesse retangulo. O layout reserva mais area do que o desenho ocupa,
   entao sem esse passo sobrava espaco em branco no SVG exportado.

O layout roda em duas passadas, como no original (uma no `layout()`, outra no
`repaint`): figuras com `HFill`, como a barra do `UNION` ou a do `Append`, se esticam
ate a largura total calculada na passada anterior.

Os dois dialetos compartilham toda a camada de baixo: medicao de texto, figuras,
layout, recorte, exportacao e interface. O que muda e so a semantica - cores, rotulos,
de onde sai o custo e o texto de detalhe.

## Diferencas em relacao ao projeto original

- Sem backend: o CLI em Python, o Flask e o cairo sairam.
- O SVG e gerado diretamente pelo renderer (o original gerava PNG no servidor).
- Suporte a PostgreSQL, que o original nao tinha.
- Interatividade que o servidor nao tinha: zoom, pan, tooltips e tema.
- Ajustes de layout em cima do original:
  - quando o rotulo do tipo de acesso e mais largo que a caixa de uma tabela
    materializada, a caixa cresce em vez de deixar o texto vazar, e a moldura
    tracejada fica simetrica em torno do conteudo;
  - o rotulo de atributos dos nos de operacao (`filesort`, `tmp table`, `quicksort`)
    fica centralizado sob a figura, e nao alinhado a esquerda. A seta que chega no no
    para logo abaixo desse rotulo, entao antes ela parecia apontar para o vazio ao
    lado do texto em vez de apontar para o `ORDER` / `GROUP`;
  - o custo e a contagem de linhas de uma seta ficam na mesma linha de base. Para
    caberem lado a lado mesmo em figuras estreitas (o losango do nested loop), o
    custo e recuado para a esquerda quando encostaria na contagem.

### Limites conhecidos no dialeto PostgreSQL

- Um no de join que traga subplans (`InitPlan` / `SubPlan`) junto das duas entradas
  passa a ter mais de dois filhos e e desenhado como barra, nao como losango.
- Quando o JSON traz varios planos no array, so o primeiro e desenhado (com aviso).

## Testes

```
node tools/e2e.mjs
```

Sobe o Chrome headless, renderiza todos os exemplos dos dois bancos, confere as margens
do recorte, testa tooltip, zoom, entradas invalidas, saida bruta do cliente mysql e do
psql, e os downloads de SVG e PNG.

## Licenca

O algoritmo de layout e desenho e um porte do Visual Explain do MySQL Workbench
(`explain_renderer.py`, `canvas.py`), Copyright (c) 2012, 2021, Oracle and/or its
affiliates, distribuido sob a GNU General Public License, version 2.0. Por ser um
trabalho derivado, este projeto segue a mesma licenca (GPL-2.0). O texto completo
esta em https://www.gnu.org/licenses/old-licenses/gpl-2.0.html
