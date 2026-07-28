# EXPLAIN Render

Turns a query execution plan, in JSON, into a diagram - and exports it as **SVG**
(vector) or PNG. Runs entirely in the browser, in plain HTML, CSS and JavaScript: no
backend, no build step, no dependencies.

It reads two dialects, detected automatically from the shape of the JSON:

| Database | Command | JSON root |
|---|---|---|
| MySQL | `EXPLAIN FORMAT=JSON <query>;` | object with `query_block` |
| PostgreSQL | `EXPLAIN (FORMAT JSON) <query>;` | array with `Plan` |

The starting point was `mysql-visual-explain-server` (Flask + cairo + a Python CLI):
the same diagram MySQL Workbench's Visual Explain draws, rewritten for the browser and
then extended to PostgreSQL.

## What it does

- Draws the execution tree with colors by cost, arrow thickness proportional to the row
  count, and the cost and row count on every edge.
- **MySQL**: tables, nested loops (including block nested loop and batched key access),
  `GROUP` / `ORDER` / `DISTINCT`, attached subqueries, subqueries in the SELECT list,
  materialized tables, materialized joins (`buffer_result`) and `UNION`.
- **PostgreSQL**: scans (Seq, Index, Index Only, Bitmap, CTE, Function, Foreign, ...),
  joins (Nested Loop, Hash Join, Merge Join), operations (Sort, Aggregate, Hash,
  Materialize, Memoize, Gather, Limit, ...) and n-ary nodes (Append, Merge Append,
  BitmapAnd, BitmapOr, Recursive Union).
- With `EXPLAIN (FORMAT JSON, ANALYZE)`, the detail of each node compares the estimate
  against what happened and flags an estimate off by 10x or more - usually where the
  cause of a bad plan is hiding.
- Node details (key used, conditions, costs, timings) on hover.
- Zoom with the mouse wheel, drag to pan, fit to screen, double click to reframe.
- Copies the diagram to the clipboard as an image, ready to paste into a chat or a
  document, and exports it as SVG or as PNG at 2x. The image is cropped to the content,
  with a 15px margin on the sides and 10px top and bottom.
- Ready made samples for both databases, light/dark theme, and the last JSON is kept
  between visits.

Nothing is sent to any server: all the processing happens on the user's machine.

## How to use it

Open `index.html` straight in the browser (it works over `file://`) or serve the folder:

```
python3 -m http.server 8000
```

Paste the JSON in the field on the left. The text can be messy: an `EXPLAIN:` header,
`\G` output from the mysql client, `QUERY PLAN` with psql's `+` continuation markers, a
`1 row in set` footer. The parser carves out the JSON object on its own.

## Layout of the repository

```
index.html          app markup and metatags
404.html            error page (and what turns off Cloudflare Pages' SPA mode)
css/style.css       styles (light/dark theme)
js/graphics.js      text measurement and a cairo-like drawing context that emits SVG
js/nodes.js         diagram nodes: layout and drawing of each kind of figure
js/nodes-pg.js      PostgreSQL nodes, reusing the layout from nodes.js
js/explain.js       MySQL EXPLAIN parser, overall layout and SVG rendering
js/explain-pg.js    PostgreSQL EXPLAIN parser (inherits from explain.js)
js/samples.js       samples for both databases
js/app.js           UI: input, dialect detection, zoom/pan, tooltips, export
og-image.png        share image (1200x630), generated
apple-touch-icon.png  touch icon (180x180), generated
robots.txt          allows indexing and points at the sitemap
sitemap.xml         the single URL of the site
_headers            CSP, HSTS and friends, read by Cloudflare Pages
tools/e2e.mjs       end-to-end test in headless Chrome
tools/og-image.mjs  generator for the two images above
```

### How it works

1. The dialect parser walks the JSON and builds the node tree. On MySQL the structure
   comes from named keys (`nested_loop`, `grouping_operation`, `table`, `union_result`);
   on PostgreSQL it comes from a recursive `Plans` array, and the shape of the node is
   picked from the number of inputs: 2 inputs with a join type become a diamond, 2 or
   more inputs become a bar with the children side by side, anything else becomes a box.
2. Each node computes its own size and places its children (`do_relayout`). Text is
   measured with `canvas.measureText`, which returns the same metrics
   `cairo_text_extents` used to (bearing, advance, ascent and descent).
3. The drawing goes through a context with cairo's API (`move_to`, `line_to`, `fill`,
   `show_text`, ...) that emits SVG elements instead of rasterizing. That is why what
   you see on screen is exactly what gets exported: the export is the same SVG, with no
   intermediate conversion.
4. After drawing, `inkBounds()` measures the bounding box of what was actually painted
   (adding half of each stroke width, since `getBBox()` ignores the stroke) and crops
   the image to that rectangle. The layout reserves more area than the drawing uses, so
   without this step the exported SVG carried empty space around it.

The layout runs in two passes, as in the original (one in `layout()`, one in
`repaint`): figures with `HFill`, such as the `UNION` bar or the `Append` bar, stretch
to the total width computed by the previous pass.

Both dialects share the whole lower layer: text measurement, figures, layout, cropping,
export and UI. What changes is only the semantics - colors, labels, where the cost comes
from and the detail text.

## Differences from the original project

- No backend: the Python CLI, Flask and cairo are gone.
- The SVG is produced by the renderer directly (the original generated PNG on the server).
- PostgreSQL support, which the original did not have.
- Interactivity the server version did not have: zoom, pan, tooltips and theming.
- Layout fixes on top of the original:
  - when the access type label is wider than the box of a materialized table, the box
    grows instead of letting the text spill out, and the dashed frame stays symmetric
    around the content;
  - the attribute label of operation nodes (`filesort`, `tmp table`, `quicksort`) is
    centered under the figure rather than left aligned. The arrow reaching the node
    stops right below that label, so before this it looked like it pointed at the empty
    space beside the text instead of at the `ORDER` / `GROUP`;
  - the cost and the row count of an arrow sit on the same baseline. So that both fit
    side by side even on narrow figures (the nested loop diamond), the cost is pushed
    left when it would touch the count.

### Known limits in the PostgreSQL dialect

- A join node that carries subplans (`InitPlan` / `SubPlan`) alongside its two inputs
  ends up with more than two children and is drawn as a bar, not as a diamond.
- When the JSON carries several plans in the array, only the first one is drawn (with a
  warning).

## Indexing and sharing

`index.html` carries `canonical`, `robots`, Open Graph, a Twitter card, `theme-color`
for both themes and a JSON-LD block (`WebApplication`). The public address
(`https://explain-render.matob.dev/`) appears as an absolute URL in those tags, in
`robots.txt` and in `sitemap.xml` - changing domain means touching all three files.

The share image and the touch icon are generated from the renderer itself, so the
diagram on the card is the same SVG the app exports:

```
node tools/og-image.mjs
```

### Why there is a 404.html

The site is published on Cloudflare Pages, which decides on its own whether the project
is a single-page application: *"if your project does not include a top-level `404.html`
file, Pages assumes that you are deploying a single-page application"*. Without that
file, any unknown path answered **200 with the home page**, and every wrong URL somebody
linked looked like a copy of the home page to search engines. With `404.html` at the
root, an unknown path answers a real 404. The page carries `noindex` and does not depend
on `css/style.css`, so it renders even if the stylesheet path changes.

## Tests

```
node tools/e2e.mjs
```

Starts headless Chrome, renders every sample of both databases, checks the crop margins,
exercises the tooltip, zoom, invalid input, raw output from the mysql client and from
psql, the SVG and PNG downloads, and the indexing and sharing metatags (including the
size and the weight of the share image).

## Language

Everything in this repository is in English: UI, code, comments, documentation and the
metatags. It is a tool for developers reading query plans, and the vocabulary of the
subject (`Seq Scan`, `nested loop`, `buffer_result`) is in English anyway.

## License

The layout and drawing algorithm is a port of MySQL Workbench's Visual Explain
(`explain_renderer.py`, `canvas.py`), Copyright (c) 2012, 2021, Oracle and/or its
affiliates, distributed under the GNU General Public License, version 2.0. Being a
derivative work, this project follows the same license (GPL-2.0). The full text is at
https://www.gnu.org/licenses/old-licenses/gpl-2.0.html
