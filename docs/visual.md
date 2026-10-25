# The plot visual

What Pins draws: a visual from Grasp's `plot` tool, content type
`application/vnd.grasp.visual+json`, version 1. This page is the part of
it this client reads; a visual of another version is refused.

## Getting one

1. Invoke `plot` (`POST /api/tools/tools/plot/invoke/`) with `sql` and
   `paths`, plus `x`, `y`, `t`, `z` and the other arguments. Its output is
   `{visual: "/files/<id>", text, resolved}`.
2. Read the file's content: the visual below.
3. To re-plot, send `resolved` back with fields edited. To ask about it,
   invoke `inspect` with `/files/<id>`, or `/files/<id>/cells/<i.j.f>`
   for one pin.

## Shape

```json
{
  "version": 1,
  "args": {"x": "month(date)", "y": "account", "z": "sum(amount)", "resolution": 48, "sort": "label", "normalize": "none", "tz": "UTC"},
  "grid": {
    "x": ["2025-01", "…"], "y": ["3000 Sales", "…"], "t": [],
    "values": [[120500, null, "…"]],
    "rows": [[42, 0, "…"]]
  },
  "summary": {
    "measure": {"label": "sum(amount)"},
    "x": {"field": "month(date)", "kind": "ordered"},
    "y": {"field": "account", "kind": "category"}
  }
}
```

- **Cells.** `values[f][j·nx + i]` is cell `(i, j)` of frame `f`; `null`
  is no data. `rows` has the same shape and counts the rows behind
  each cell. Without `y`, `j` is 0.
- **Frames.** One per `grid.t` label, or a single one when there is no
  `t`. With `t`, `summary.frames` holds each frame as
  `{t, filled, value}`: its label, cells with data and measure.
- **Axes.** `kind` is `ordered` (time, integers: neighbours are
  neighbours), `bins` (numbers, by position) or `category` (labels,
  nothing between them).
- **Arguments.** `args` is every argument plot used, defaults made
  explicit.

## Heights

Height is the value, so it must not lie.

- **Scale.** Linear, one scale for every frame: full travel is the
  largest `|value|` of the whole visual.
- **Sign.** With nothing negative, zero is the plate; otherwise zero sits
  where it falls and negatives sink below it.
- **Place.** A cell's value is the height at its middle. Along an
  ordered axis the pins between follow a monotone cubic through the
  values, which never swings past them. A category is a band at its own
  height, bands parted by a groove at zero. Two binned axes keep their
  proportions, so a map stays a map.
- **Line.** An ordered `x` with no `y`, or at most 8 series, is a line in
  sand: flat at zero, the value in depth, each series a ridge. A cell
  with no data breaks it.
- **No data** rests at zero.

## Lab cases

`mocks/visuals` holds plot's own test cases, each `{text, visual}`, a
snapshot taken from plot. `bun test` checks every one against these
rules, and `/lab.html` draws them without signing in.
