# ds-lakehouse-client

A mock Lakehouse client: browse the gold, silver and bronze layers, run SQL through ds-fetch, and plot results as a bed of pins with ds-tools' `plot`.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer.
- A Grasp account, to use the app.
- Go and [ds-tools](../ds-tools) checked out next to this repo, only to regenerate the lab's visuals.

## Run

```sh
bun run dev
```

Open <http://localhost:4173> and sign in with your Grasp account. Settings:

| Variable        | Default | Meaning                                                      |
| --------------- | ------- | ------------------------------------------------------------ |
| `BUILDING_MODE` | `dev`   | `dev` or `prod`: which Grasp services the app talks to.       |
| `PORT`          | `4173`  | The local port.                                              |

The server keeps your tokens. The browser only gets an HttpOnly session cookie, and calls are proxied to fetch, config, tools, state and file under `/api/*`.

## Use

1. Pick a layer and a dataset. Its tabs show the overview, schema, preview and lineage.
2. Press **Open in SQL**, or **Ask in words** and then **Draft SQL** to have one written for you. Review it, then press **Run**.
3. Press **Pins** on the result. This sends the statement to ds-tools' `plot`, which needs to be deployed in the environment you chose.

   The result is a pin toy: a fine rack of small pins, x across and y in depth, always all there, pressed up by a smooth surface through the cells' values: it passes through every value and never swings past one. Categories stay apart as bands. An ordered x with no y, or up to 8 series, is a line drawn in sand: flat sand, the value in depth, each series a soft ridge named at its end. Every pin is the same size and length. The rack opens flat, already showing the picture in its tones, then rises out of it. A pin without data rests at zero. Data raises it by its value, on one scale for every frame, and negative values sink it below zero. One metal, toned dark for the lowest value to light for the highest, inside a faint cage that is the x, y and z axes.

   Then:
   - Set **resolution**, the most cells per axis (2 to 360, default 48), and press **Plot**.
   - Look from **3D**, the **Top**, the **Front** or the **Side**.
   - Drag to rotate and scroll to zoom. Hover a pin for its value and place; hold still a second for its rows and rank. Click it for the details. With the rack focused, arrow keys move between cells; the rack is described to screen readers by plot's text.
   - Press **Play** to animate over t.
   - Edit x, y, t, z and the other arguments, then press **Plot**.
   - Press **Details** (off by default) for the title, cameras, edit form, axis labels and what the plot shows, and to ask about it or about the selected pin.

## Pins lab

<http://localhost:4173/lab.html> draws plot's golden cases without sign-in, to check the renderer against the contract. `?case=earth` opens a single case: Earth relief at 2°, 180 × 91 cells, one pin each.

To regenerate the cases from ds-tools (written to `mocks/visuals`):

```sh
bun run visuals
```

## Test

```sh
bun test
```

This tests the renderer's height rules on small inline cases, and checks every visual in `mocks/visuals` against the contract.
