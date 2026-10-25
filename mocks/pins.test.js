import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import "./pins.js";

const { Pins } = globalThis;

describe("heights", () => {
  test("a pin's height is its value over the largest |value|; no data is NaN, never 0", () => {
    const visual = { grid: { x: ["a", "b", "c", "d"], y: [], t: [], values: [[-3, null, 0, 6]] } };
    expect([...Pins.heights(visual, 0)]).toEqual([-0.5, NaN, 0, 1]);
  });

  test("one scale for the whole animation: frames compare", () => {
    const visual = { grid: { x: ["a", "b"], y: [], t: ["w1", "w2"], values: [[1, 2], [4, 8]] } };
    expect([...Pins.heights(visual, 0)]).toEqual([0.125, 0.25]);
    expect([...Pins.heights(visual, 1)]).toEqual([0.5, 1]);
  });

  test("all zeros rest at zero; an empty grid has no pins", () => {
    expect([...Pins.heights({ grid: { x: ["a", "b"], y: [], t: [], values: [[0, 0]] } }, 0)]).toEqual([0, 0]);
    expect([...Pins.heights({ grid: { x: [], y: [], t: [], values: [[]] } }, 0)]).toEqual([]);
  });
});

describe("lift", () => {
  test("with nothing negative, zero rests on the plate and the largest value is full travel", () => {
    const visual = { grid: { x: ["a", "b", "c", "d"], y: [], t: [], values: [[0, 2, null, 4]] } };
    expect(Pins.zero(visual)).toBe(0);
    expect([...Pins.lift(visual, 0)]).toEqual([0, 0.5, NaN, 1]);
  });

  test("with mixed signs, travel spans lowest to highest on one linear scale; zero sits where it falls", () => {
    const visual = { grid: { x: ["a", "b", "c"], y: [], t: [], values: [[-1, 0, 4]] } };
    expect(Pins.zero(visual)).toBe(0.2);
    expect([...Pins.lift(visual, 0)]).toEqual([0, 0.2, 1]);
  });

  test("with nothing positive, zero is full travel and the most negative value rests on the plate", () => {
    const visual = { grid: { x: ["a", "b"], y: [], t: [], values: [[-2, -8]] } };
    expect(Pins.zero(visual)).toBe(1);
    expect([...Pins.lift(visual, 0)]).toEqual([0.75, 0]);
  });

  test("the zero level is read over every frame, so it does not move during the animation", () => {
    const visual = { grid: { x: ["a"], y: [], t: ["w1", "w2"], values: [[2], [-2]] } };
    expect([...Pins.lift(visual, 0)]).toEqual([1]);
    expect([...Pins.lift(visual, 1)]).toEqual([0]);
  });
});

describe("rack", () => {
  const visual = (nx, ny, x = "ordered", y = "ordered") => ({
    grid: { x: Array(nx).fill(""), y: Array(ny).fill(""), t: [], values: [] },
    summary: { x: { kind: x }, y: ny ? { kind: y } : null },
  });

  test("the rack stays fine however few the cells, every pin one size", () => {
    const { px, py, pitch } = Pins.rack(visual(4, 2));
    expect([px, py, pitch]).toEqual([128, 128, 2 / 128]);
  });

  test("two binned axes keep their proportions: a map stays a map", () => {
    const earth = Pins.rack(visual(180, 91, "bins", "bins"));
    expect([earth.px, earth.py]).toEqual([180, 91]);
    expect(Pins.rack(visual(10, 5, "bins", "bins"))).toMatchObject({ px: 128, py: 64 });
  });

  test("categories are whole bands of pins, parted by a groove; an ordered y rises from the front", () => {
    const category = Pins.rack(visual(1, 12, "ordered", "category"));
    expect(category.py).toBe(120);
    expect([...category.y.groove].filter(Boolean)).toHaveLength(11);
    expect(category.y.f[0]).toBe(11);
    expect(category.place(0, 0)[1]).toBeLessThan(0);
    expect(Pins.rack(visual(1, 2)).place(0, 0)[1]).toBeGreaterThan(0);
  });

  test("an ordered x with no y, or a few series, is a line: the value in depth", () => {
    expect(Pins.rack(visual(20, 0)).line).toBe(true);
    expect(Pins.rack(visual(20, 4, "ordered", "category")).line).toBe(true);
    expect(Pins.rack(visual(20, 9, "ordered", "category")).line).toBe(false);
    expect(Pins.rack(visual(20, 4, "category", "category")).line).toBe(false);
    const { depth } = Pins.rack(visual(20, 0));
    expect(depth(1)).toBeLessThan(depth(0));
  });

  test("with no cells the rack is empty", () => {
    expect(Pins.rack(visual(0, 0)).at).toHaveLength(0);
  });
});

describe("sand", () => {
  const draw = (values) => {
    const layout = Pins.rack({ grid: { x: values.map(String), y: [], t: [], values: [] }, summary: { x: { kind: "ordered" }, y: null } });
    return { layout, ...Pins.sand(layout, Float64Array.from(values)) };
  };
  const ridge = ({ layout, heights }, c) => {
    let [top, at] = [0, -1];
    for (let r = 0; r < layout.py; r++) if (heights[r * layout.px + c] > top) [top, at] = [heights[r * layout.px + c], r];
    return { top, at };
  };

  test("the line is a ridge at its value's depth, on flat sand", () => {
    const drawn = draw([0, 1]);
    const { px, py } = drawn.layout;
    expect(ridge(drawn, 0)).toEqual({ top: 1, at: 3 });
    expect(ridge(drawn, px - 1)).toEqual({ top: 1, at: py - 4 });
    expect(drawn.heights[(py - 1) * px]).toBeLessThan(1e-3);
    expect(drawn.owner[(py / 2) * px]).toBe(-1);
  });

  test("a steep line stays unbroken, and a cell with no data breaks it", () => {
    const steep = draw([0, 1, 0]);
    for (let c = 0; c < steep.layout.px; c++) expect(ridge(steep, c).top).toBeGreaterThan(0.85);
    const broken = draw([0.5, NaN, 0.5]);
    expect(ridge(broken, broken.layout.px / 2).top).toBeLessThan(0.5);
  });
});

describe("surface", () => {
  const line = (values, kind = "ordered") => {
    const layout = Pins.rack({ grid: { x: values.map(String), y: [], t: [], values: [] }, summary: { x: { kind }, y: null } });
    return { layout, out: Pins.surface(layout, Float64Array.from(values), 0).slice(0, layout.px) };
  };

  test("it passes through every cell's value at the cell's middle", () => {
    const { layout, out } = line([0, 1, 0.2, 0.8]);
    for (let c = 0; c < layout.px; c++) if (Number.isInteger(layout.x.f[c])) expect(out[c]).toBeCloseTo([0, 1, 0.2, 0.8][layout.x.f[c]], 12);
    expect(out[0]).toBe(0);
  });

  test("it never swings past its neighbours: no invented peak or dip", () => {
    const values = [0, 0, 1, 1, 0.3, 0.9, 0.9, 0];
    const { layout, out } = line(values);
    for (let c = 0; c < layout.px; c++) {
      const k = Math.min(Math.floor(layout.x.f[c]), values.length - 2);
      expect(out[c]).toBeGreaterThanOrEqual(Math.min(values[k], values[k + 1]) - 1e-12);
      expect(out[c]).toBeLessThanOrEqual(Math.max(values[k], values[k + 1]) + 1e-12);
    }
  });

  test("a category holds its value across its band and rests in the groove", () => {
    const { layout, out } = line([0.5, 1], "category");
    expect(out[0]).toBe(0.5);
    expect(out[layout.px / 2 - 1]).toBe(0);
    expect(out[layout.px - 1]).toBe(1);
  });
});

// Every visual plot's golden cases produce is drawable by the contract's rules.
describe("plot's golden visuals", () => {
  const dir = join(import.meta.dir, "visuals");
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];

  test("are present: bun run visuals writes them from ds-tools", () => {
    expect(names.length).toBeGreaterThan(50);
  });

  for (const name of names) {
    test(name, () => {
      const { visual, text } = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const { grid, args } = visual;
      const [nx, ny] = [grid.x.length, Math.max(1, grid.y.length)];
      const nf = args.t ? grid.t.length : 1;
      expect(visual.version).toBe(1);
      expect(typeof text).toBe("string");
      expect(grid.values).toHaveLength(nf);

      let tallest = 0;
      for (let f = 0; f < nf; f++) {
        expect(grid.values[f]).toHaveLength(nx * ny);
        const h = Pins.heights(visual, f);
        const lift = Pins.lift(visual, f);
        grid.values[f].forEach((value, k) => {
          if (value == null) return expect([h[k], lift[k]]).toEqual([NaN, NaN]);
          expect(Math.abs(h[k])).toBeLessThanOrEqual(1);
          expect(Math.sign(h[k])).toBe(Math.sign(value));
          expect(lift[k]).toBeGreaterThanOrEqual(0);
          expect(lift[k]).toBeLessThanOrEqual(1);
          tallest = Math.max(tallest, Math.abs(h[k]));
        });
      }
      if (grid.values.flat().some((value) => value)) expect(tallest).toBe(1);

      const layout = Pins.rack(visual);
      const { px, py, at, cell, line } = layout;
      expect(at).toHaveLength(px * py * 2);
      for (const position of at) expect(Math.abs(position)).toBeLessThan(1 + 1e-6);
      expect(new Set(cell).size).toBe(line ? nx : nx * (nx ? ny : 0));
      if (nx) expect(Math.max(px, py)).toBeGreaterThanOrEqual(Math.min(128, Math.max(nx, ny)));
      for (let frame = 0; frame < (nx ? nf : 0); frame++) {
        const cells = Pins.lift(visual, frame).map((share) => (Number.isNaN(share) ? 0 : share));
        for (const height of Pins.surface(layout, cells, 0)) expect(height >= -1e-9 && height <= 1 + 1e-9).toBe(true);
      }
    });
  }
});
