// Pins draws a plot visual (application/vnd.grasp.visual+json; ds-tools docks/tools/plot.md) as a pin toy: a fine
// rack of small pins, always all there, pressed up by a smooth surface through the cells' values — or, for a line,
// flat sand with each series a soft ridge along its curve; every pin the same size and length, inside a faint cage
// that is the x, y and z axes, labelled with the details. A pin without data rests at zero; data pushes it up or,
// when negative, down — on one scale for every frame. One metal, its tone the same share as the height, dark lowest
// to light highest, so a fresh rack lies flat showing the picture and then rises out of it. Nothing is computed
// from rows: the grid is the server's, its resolution the number of cells, and the heights are the contract's
// "Heights".
//   Pins.reach(visual)          → the largest |value|, full travel
//   Pins.heights(visual, frame) → per cell: value / reach in [-1, 1], NaN for no data
//   Pins.zero(visual)           → where zero sits on a pin's travel: the low end unless something is negative
//   Pins.lift(visual, frame)    → per cell: share of travel in [0, 1], linear in value, NaN for no data
//   Pins.rack(visual)           → { px, py, pitch, at, cell, place, x, y }: pin p at at[2p], at[2p+1], nearest
//                                  cell[p]; place(i, j) the middle of cell (i, j); x and y each pin's place in cells
//   Pins.surface(layout, cells, rest) → per pin: the cells' values, smooth between them, rest in a groove
//   Pins.sand(layout, cells)    → a line rack's { heights in [0, 1], owner: each pin's cell or -1 for bare sand }
//   Pins.open({ visual, text, title, path, edit, ask }) → the overlay; returns { show(result), close() }
(() => {
  const VERSION = 1; // the visual version this draws
  const TRAVEL = 0.6; // full travel, in half-widths of the rack's longer side
  const LENGTH = TRAVEL + 0.12; // every pin is this long
  const PINS = 128; // pins a rack has at least per axis, however few the cells
  const SERIES = 8; // an ordered x with at most this many y series is a line
  const RIDGE = 0.22; // a line's height, in travel
  const WIDTH = 1.4; // a line's half-width, in pins
  const PIN = 0.42; // radius, in pitches
  const MARGIN = 0.06; // cage beyond the outer pins
  const FRAME_MS = 650;
  const REST_MS = 500; // a fresh rack lies flat this long, then rises
  const RISE_MS = 1400;
  const MOVE_MS = 450; // between frames and edits
  const MORE_MS = 1000; // hovering a pin this long shows more
  const TARGET = [0, 0, 0];
  const DISTANCE = 5;
  const CAMERAS = { "3D": { yaw: -0.6, pitch: 0.6 }, Top: { yaw: 0, pitch: 1.56 }, Front: { yaw: 0, pitch: 0.05 }, Side: { yaw: -Math.PI / 2, pitch: 0.05 } };
  const METAL = [0.86, 0.87, 0.9];

  const exact = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
  const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
  const esc = (value) => String(value).replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  const clip = (text, length = 14) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  const size = ({ grid }) => ({ nx: grid.x.length, ny: Math.max(1, grid.y.length), nf: Math.max(1, grid.t.length) });

  // The lowest and highest value over every frame, always holding zero.
  function extremes(visual) {
    let [low, high] = [0, 0];
    for (const frame of visual.grid.values) for (const value of frame) if (value != null) [low, high] = [Math.min(low, value), Math.max(high, value)];
    return { low, high };
  }

  function reach(visual) {
    const { low, high } = extremes(visual);
    return Math.max(-low, high) || 1;
  }

  function heights(visual, frame) {
    const full = reach(visual);
    return Float64Array.from(visual.grid.values[frame] ?? [], (value) => (value == null ? NaN : value / full));
  }

  // Travel spans the lowest height to the highest, linearly.
  function span(visual) {
    const [{ low, high }, full] = [extremes(visual), reach(visual)];
    return high > low ? { low: low / full, high: high / full } : { low: 0, high: 1 };
  }

  function zero(visual) {
    const { low, high } = span(visual);
    return low ? -low / (high - low) : 0;
  }

  function lift(visual, frame) {
    const { low, high } = span(visual);
    return heights(visual, frame).map((share) => (share - low) / (high - low));
  }

  // Where each pin along one axis sits in cells: f its place (cell centres at whole numbers), cell the nearest. An
  // ordered axis is continuous. A category has nothing between its neighbours, so it is a band of whole pins at one
  // place, the bands parted by a groove of one pin.
  function axis(n, pins, category, flip) {
    const [f, cell, groove] = [new Float32Array(pins), new Int32Array(pins), new Uint8Array(pins)];
    const band = pins / Math.max(n, 1);
    for (let c = 0; c < pins; c++) {
      const block = Math.floor(c / band);
      const place = category ? block : clamp(((c + 0.5) * n) / pins - 0.5, 0, n - 1);
      f[c] = flip ? n - 1 - place : place;
      cell[c] = flip ? n - 1 - block : block;
      groove[c] = category && band >= 3 && c % band === band - 1 && block < n - 1;
    }
    return { f, cell, groove };
  }

  // x runs across and y from front to back, so seen from above an ordered y rises up the screen, while categories
  // read top down like a table's rows. Two binned axes keep their proportions, so a map stays a map. A line puts
  // its value in depth instead, rising up the screen too.
  function rack(visual) {
    const { nx, ny } = size(visual);
    const kinds = [visual.summary?.x?.kind, visual.summary?.y?.kind];
    const line = nx > 0 && kinds[0] !== "category" && (!visual.summary?.y || (kinds[1] === "category" && ny <= SERIES));
    const even = kinds[0] === "bins" && kinds[1] === "bins";
    const pins = (n, kind) =>
      !nx ? 0 : even ? Math.round(n * Math.max(1, PINS / Math.max(nx, ny))) : kind === "category" ? n * Math.max(1, Math.floor(PINS / n)) : Math.max(n, PINS);
    const [px, py] = line ? [pins(nx), PINS] : [pins(nx, kinds[0]), pins(ny, kinds[1])];
    const pitch = 2 / Math.max(px, py, 1);
    const [x, y] = [axis(nx, px, kinds[0] === "category", false), line ? axis(1, py, false, false) : axis(ny, py, kinds[1] === "category", kinds[1] === "category")];
    const at = new Float32Array(px * py * 2);
    const cell = new Int32Array(px * py);
    for (let p = 0; p < px * py; p++) {
      const [c, r] = [p % px, Math.floor(p / px)];
      [at[p * 2], at[p * 2 + 1]] = [(c + 0.5 - px / 2) * pitch, (py / 2 - r - 0.5) * pitch];
      cell[p] = y.cell[r] * nx + x.cell[c];
    }
    const row = (j) => (kinds[1] === "category" ? ny - 1 - j : j);
    const place = (i, j) => [((i + 0.5) * px / nx - px / 2) * pitch, (py / 2 - ((row(j) + 0.5) * py) / ny) * pitch];
    const depth = (share) => (py / 2 - edge(py, share) - 0.5) * pitch;
    return { nx, ny, px, py, pitch, at, cell, place, x, y, line, depth };
  }

  // A monotone cubic (Fritsch–Butland) through samples at whole numbers: it passes through every value and never
  // swings past its neighbours, so the surface invents no peak and no dip.
  function curve(get, n, f) {
    const k = Math.min(Math.floor(f), n - 2);
    if (k < 0) return get(0);
    const t = f - k;
    if (t === 0 || t === 1) return get(k + t);
    const step = (i) => (i >= 0 && i < n - 1 ? get(i + 1) - get(i) : NaN);
    const slope = (i) => {
      const [a, b] = [step(i - 1), step(i)];
      if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : b;
      if (Number.isNaN(b)) return a;
      return a * b > 0 ? (2 * a * b) / (a + b) : 0;
    };
    const [t2, t3] = [t * t, t * t * t];
    return (2 * t3 - 3 * t2 + 1) * get(k) + (t3 - 2 * t2 + t) * slope(k) + (3 * t2 - 2 * t3) * get(k + 1) + (t3 - t2) * slope(k + 1);
  }

  // The surface at every pin, one axis at a time: along x for each row of cells, then along y for each column of pins.
  function surface({ nx, ny, px, py, x, y }, cells, rest) {
    const across = new Float64Array(px * ny);
    for (let j = 0; j < ny; j++) for (let c = 0; c < px; c++) across[j * px + c] = curve((i) => cells[j * nx + i], nx, x.f[c]);
    const out = new Float64Array(px * py);
    for (let r = 0; r < py; r++) {
      for (let c = 0; c < px; c++) out[r * px + c] = x.groove[c] || y.groove[r] ? rest : curve((j) => across[j * px + c], ny, y.f[r]);
    }
    return out;
  }

  // The pin row of a share of a line's depth, a whole ridge in from either edge.
  const edge = (py, share) => Math.ceil(WIDTH * 2) + share * (py - 1 - 2 * Math.ceil(WIDTH * 2));

  // A line drawn in sand: each series' curve (x across, its value in depth) poured as a soft ridge onto flat sand.
  // Where a cell has no data the line breaks.
  function sand({ nx, ny, px, py, x }, cells) {
    const [heights, owner] = [new Float64Array(px * py), new Int32Array(px * py).fill(-1)];
    const reach = Math.ceil(WIDTH * 2);
    for (let j = 0; j < ny; j++) {
      const track = Float64Array.from(x.f, (f) => edge(py, curve((i) => cells[j * nx + i], nx, f)));
      for (let c = 0; c < px; c++) {
        if (Number.isNaN(track[c])) continue;
        const next = Number.isNaN(track[c + 1] ?? NaN) ? track[c] : track[c + 1];
        const steps = Math.max(1, Math.ceil(Math.abs(next - track[c])));
        for (let step = 0; step < steps; step++) {
          const [sx, sy] = [c + step / steps, track[c] + ((next - track[c]) * step) / steps];
          for (let r = Math.max(0, Math.round(sy) - reach); r <= Math.min(py - 1, Math.round(sy) + reach); r++) {
            for (let q = Math.max(0, Math.round(sx) - reach); q <= Math.min(px - 1, Math.round(sx) + reach); q++) {
              const height = Math.exp(-((q - sx) ** 2 + (r - sy) ** 2) / WIDTH ** 2);
              if (height > heights[r * px + q]) [heights[r * px + q], owner[r * px + q]] = [height, j * nx + x.cell[q]];
            }
          }
        }
      }
    }
    return { heights, owner };
  }

  /* ---------- 3D: column-major matrices, one instanced pin mesh, the cage ---------- */

  const sub = (a, b) => a.map((value, index) => value - b[index]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => a.map((value) => value / Math.hypot(...a));

  function perspective(fov, aspect, near, far) {
    const [f, d] = [1 / Math.tan(fov / 2), 1 / (near - far)];
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * d, -1, 0, 0, 2 * far * near * d, 0];
  }

  function lookAt(eye, at, up) {
    const z = unit(sub(eye, at));
    const x = unit(cross(up, z));
    const y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  }

  function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    return out;
  }

  // Screen position and depth of a world point.
  function project(m, x, y, z, width, height) {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [(((m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * 0.5 + 0.5) * width, (0.5 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5) * height, w];
  }

  // Vertex: position, normal, part (0 shaft, 1 end, 3 cage). A unit cylinder, flat at both ends; the
  // shader sizes it.
  function pinMesh(segments = 12) {
    const vertices = [];
    const indices = [];
    const ring = (part, y, normalY) => {
      const start = vertices.length / 7;
      for (let s = 0; s <= segments; s++) {
        const angle = (s / segments) * Math.PI * 2;
        const [x, z] = [Math.cos(angle), Math.sin(angle)];
        vertices.push(x, y, z, normalY ? 0 : x, normalY, normalY ? 0 : z, part);
      }
      return start;
    };
    const [low, high] = [ring(0, 0, 0), ring(0, 1, 0)];
    for (let s = 0; s < segments; s++) indices.push(low + s, high + s, low + s + 1, low + s + 1, high + s, high + s + 1);
    for (const [y, normalY] of [[1, 1], [0, -1]]) {
      const rim = ring(1, y, normalY);
      const centre = vertices.length / 7;
      vertices.push(0, y, 0, 0, normalY, 0, 1);
      for (let s = 0; s < segments; s++) indices.push(centre, rim + s, rim + s + 1);
    }
    return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
  }

  // The twelve edges of a unit box, y from 0 to 1; the shader spans it over every pin's reach.
  function cageMesh() {
    const corners = [];
    for (const y of [0, 1]) for (const z of [-1, 1]) for (const x of [-1, 1]) corners.push(x, y, z, 0, 1, 0, 3);
    const edges = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];
    return { vertices: new Float32Array(corners), indices: new Uint16Array(edges) };
  }

  const VERTEX = `#version 300 es
    layout(location = 0) in vec3 a_position;
    layout(location = 1) in vec3 a_normal;
    layout(location = 2) in float a_part;
    layout(location = 3) in vec2 a_at;
    layout(location = 4) in float a_lift;
    layout(location = 5) in vec2 a_shade;
    uniform mat4 u_view;
    uniform float u_radius;
    uniform float u_length;
    uniform vec2 u_extent;
    uniform vec2 u_cage;
    out vec3 v_normal;
    out vec3 v_world;
    out float v_drop;
    out vec2 v_shade;
    out float v_part;
    void main() {
      vec3 world = a_part < 1.5
        ? vec3(a_at.x, 0.0, a_at.y) + vec3(a_position.x * u_radius, a_lift - u_length * (1.0 - a_position.y), a_position.z * u_radius)
        : vec3(a_position.x * u_extent.x, mix(u_cage.x, u_cage.y, a_position.y), a_position.z * u_extent.y);
      v_normal = a_normal;
      v_world = world;
      v_drop = a_lift - world.y;
      v_shade = a_shade;
      v_part = a_part;
      gl_Position = u_view * vec4(world, 1.0);
    }`;

  // One metal, toned dark to light by value (x), under a key and a fill light; a lit pin (y) glows.
  const FRAGMENT = `#version 300 es
    precision highp float;
    in vec3 v_normal;
    in vec3 v_world;
    in float v_drop;
    in vec2 v_shade;
    in float v_part;
    uniform vec3 u_eye;
    uniform vec3 u_metal;
    uniform vec3 u_line;
    out vec4 color;
    void main() {
      if (v_part > 2.5) {
        color = vec4(u_line, 1.0);
        return;
      }
      vec3 n = normalize(v_normal);
      vec3 e = normalize(u_eye - v_world);
      vec3 key = normalize(vec3(-0.4, 1.0, 0.6));
      vec3 fill = normalize(vec3(0.7, 0.5, -0.5));
      float light = 0.4 + 0.5 * max(dot(n, key), 0.0) + 0.15 * max(dot(n, fill), 0.0);
      float shine = 0.18 * pow(max(dot(n, normalize(key + e)), 0.0), 32.0);
      float depth = v_part < 0.5 ? mix(0.55, 1.0, clamp(1.0 - v_drop * 4.0, 0.0, 1.0)) : 1.0;
      color = vec4(u_metal * mix(0.06, 1.15, v_shade.x * v_shade.x * (3.0 - 2.0 * v_shade.x)) * light * depth + shine + v_shade.y, 1.0);
    }`;

  function stage(gl) {
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const names = ["u_view", "u_radius", "u_length", "u_extent", "u_cage", "u_eye", "u_metal", "u_line"];
    const uniforms = Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));

    const mesh = ({ vertices, indices }) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      for (const [location, components, offset] of [[0, 3, 0], [1, 3, 12], [2, 1, 24]]) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, components, gl.FLOAT, false, 28, offset);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      return { vao, count: indices.length };
    };
    const [pin, cage] = [mesh(pinMesh()), mesh(cageMesh())];
    gl.bindVertexArray(pin.vao);
    const perPin = (location, components) => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, components, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(location, 1);
      return buffer;
    };
    const buffers = { at: perPin(3, 2), lift: perPin(4, 1), shade: perPin(5, 2) };
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    let count = 0;

    return {
      rack(at) {
        count = at.length / 2;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.at);
        gl.bufferData(gl.ARRAY_BUFFER, at, gl.STATIC_DRAW);
      },
      draw({ view, eye, radius, extent, lifts, shades, ink }) {
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        gl.clearColor(...ink.background, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(program);
        gl.uniformMatrix4fv(uniforms.u_view, false, view);
        gl.uniform1f(uniforms.u_radius, radius);
        gl.uniform1f(uniforms.u_length, LENGTH);
        gl.uniform2fv(uniforms.u_extent, extent);
        gl.uniform2f(uniforms.u_cage, -LENGTH, TRAVEL);
        gl.uniform3fv(uniforms.u_eye, eye);
        gl.uniform3fv(uniforms.u_metal, METAL);
        gl.uniform3fv(uniforms.u_line, ink.line);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.lift);
        gl.bufferData(gl.ARRAY_BUFFER, lifts, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.shade);
        gl.bufferData(gl.ARRAY_BUFFER, shades, gl.DYNAMIC_DRAW);
        gl.bindVertexArray(cage.vao);
        gl.drawElements(gl.LINES, cage.count, gl.UNSIGNED_SHORT, 0);
        gl.bindVertexArray(pin.vao);
        gl.drawElementsInstanced(gl.TRIANGLES, pin.count, gl.UNSIGNED_SHORT, 0, count);
        gl.bindVertexArray(null);
      },
      release: () => gl.getExtension("WEBGL_lose_context")?.loseContext(),
    };
  }

  /* ---------- overlay ---------- */

  function open({ visual, text, title, path, edit, ask }) {
    const root = document.createElement("div");
    root.className = "pins";
    root.innerHTML = `<header class="pins-bar">
        <span class="pins-chrome" hidden><b class="ellipsis">${esc(title)}</b></span><span class="grow"></span>
        <span class="pins-cams pins-chrome" hidden>${Object.keys(CAMERAS).map((name) => `<button type="button" data-camera="${name}">${name}</button>`).join("")}</span>
        <button class="btn subtle" data-pins="panel" aria-expanded="false">Details</button>
        <button class="icon" data-pins="close" aria-label="Close">×</button>
      </header>
      <form class="pins-bar" data-pins="edit" hidden></form>
      <div class="pins-body"><div class="pins-stage"><canvas data-pins="bed" tabindex="0" role="img"></canvas><canvas data-pins="labels" aria-hidden="true"></canvas></div><aside class="pins-panel" aria-live="polite" hidden></aside></div>
      <footer class="pins-bar pins-time"><button class="btn" type="button" data-pins="play">Play</button><input type="range" data-pins="frames" min="0" value="0" /><span class="mono" data-pins="frame"></span></footer>
      <div class="pins-tip" role="tooltip" hidden></div>`;
    document.body.append(root);

    const element = (name) => root.querySelector(`[data-pins="${name}"]`);
    const [canvas, labels, slider, form] = ["bed", "labels", "frames", "edit"].map(element);
    const panel = root.querySelector(".pins-panel");
    const tip = root.querySelector(".pins-tip");
    const context = labels.getContext("2d");
    const css = getComputedStyle(document.documentElement);
    const rgb = (name) => {
      context.fillStyle = css.getPropertyValue(name).trim() || "#888888";
      return [1, 3, 5].map((offset) => parseInt(context.fillStyle.slice(offset, offset + 2), 16) / 255);
    };
    const [background, foreground] = [rgb("--background"), rgb("--foreground")];
    const mix = (share) => background.map((channel, c) => channel + (foreground[c] - channel) * share);
    const ink = { background, line: mix(0.16), text: mix(0.5), title: mix(0.8) };
    const paint = (color) => `rgb(${color.map((channel) => Math.round(channel * 255)).join(",")})`;
    const gl = canvas.getContext("webgl2", { antialias: true });
    let bed = gl && stage(gl);
    const camera = { ...CAMERAS["3D"], zoom: 1 };

    let current, n, rest, goal, tone, owner, shown, from, layout, lifts, shades, scale;
    let motion = { start: 0, ms: 1 }, frame = 0, timer, raf, hovered = null, selected = null, answer = "", dirty = true;
    let lingering;

    const normalized = () => current.visual.args.normalize !== "none";
    const format = (value) => (value == null || Number.isNaN(value) ? "no data" : normalized() ? percent.format(value) : exact.format(value));
    const short = (value) => (normalized() ? percent.format(value) : compact.format(value));
    const cellId = ({ i, j }) => `${i}.${j}.${frame}`;
    const same = (a, b) => a && b && a.i === b.i && a.j === b.j;
    const indexOf = (cell) => (cell ? cell.j * n.nx + cell.i : -1);

    function show(result) {
      if (result.visual.version !== VERSION) throw new Error(`visual version ${result.visual.version} is not ${VERSION}; update the renderer`);
      const fresh = !current || size(result.visual).nx !== n.nx || size(result.visual).ny !== n.ny;
      current = result;
      n = size(result.visual);
      if (fresh) {
        layout = rack(result.visual);
        const pins = layout.cell.length;
        [shown, lifts, shades, selected, hovered] = [new Float64Array(pins), new Float32Array(pins), new Float32Array(pins * 2), null, null];
        bed?.rack(layout.at);
      }
      rest = zero(result.visual);
      scale = extremes(result.visual);
      canvas.setAttribute("aria-label", `${result.text ?? result.visual.summary.measure.label}. Arrow keys move between cells.`);
      slider.max = n.nf - 1;
      root.querySelector(".pins-time").hidden = n.nf < 2;
      form.hidden = !edit || panel.hidden;
      if (edit) form.innerHTML = editHtml(result.visual.args);
      if (fresh) shown.fill(layout.line ? 0 : rest);
      setFrame(Math.min(frame, n.nf - 1), fresh ? { delay: REST_MS, ms: RISE_MS } : undefined);
    }

    // Every pin moves from where it stands to its value together, easing in to rest: no overshoot.
    function setFrame(index, { delay = 0, ms = MOVE_MS } = {}) {
      frame = index;
      slider.value = index;
      element("frame").textContent = current.visual.grid.t[index] ?? "";
      const cells = lift(current.visual, frame);
      if (layout.line) {
        ({ heights: tone, owner } = sand(layout, cells));
        goal = tone.map((height) => height * RIDGE);
      } else {
        goal = tone = surface(layout, cells.map((share) => (Number.isNaN(share) ? rest : share)), rest);
        owner = layout.cell;
      }
      from = Float64Array.from(shown);
      motion = { start: performance.now() + delay, ms };
      panel.innerHTML = panelHtml();
      dirty = true;
    }

    const editHtml = (args) => {
      const field = (name, value, hint, type = "text") => `<label class="pins-dim"><span>${name}</span><input class="input" type="${type}" name="${name}" value="${esc(value ?? "")}" placeholder="${hint}" /></label>`;
      const choice = (name, value, options) => `<label class="pins-dim"><span>${name}</span><select class="input" name="${name}">${options.map((option) => `<option ${option === value ? "selected" : ""}>${option}</option>`).join("")}</select></label>`;
      return `${field("x", args.x, "column or unit(column)")}${field("y", args.y, "none")}${field("t", args.t, "none")}${field("z", args.z, "count(*)")}
        ${field("resolution", args.resolution, "48", "number")}${choice("normalize", args.normalize, ["none", "x", "y", "t"])}${choice("sort", args.sort, ["label", "measure"])}
        ${field("min_rows", args.min_rows, "none", "number")}${field("tz", args.tz, "UTC")}<button class="btn" type="submit">Plot</button><span class="hint" data-pins="status"></span>`;
    };

    function panelHtml() {
      const { summary } = current.visual;
      const facts = selected && cellFacts(selected);
      const frameFacts = summary.frames?.[frame];
      return `<p>${esc(current.text ?? "")}</p>
        ${frameFacts ? `<h3>${esc(frameFacts.t)}</h3><p>${esc(format(frameFacts.value))} across ${exact.format(frameFacts.filled)} filled cells.</p>` : ""}
        ${facts ? `<h3>Pin</h3><dl>${facts.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${esc(value)}</dd>`).join("")}</dl>` : ""}
        ${ask && current.path ? `<form data-pins="ask"><input class="input" name="question" maxlength="1024" placeholder="${selected ? "Ask about this pin" : "Ask about this plot"}" /></form>${answer ? `<p>${esc(answer)}</p>` : ""}` : ""}
        <div class="pins-actions"><button class="btn subtle" type="button" data-pins="copy">Copy visual</button></div>`;
    }

    function cellFacts({ i, j }) {
      const { grid, summary } = current.visual;
      const k = j * n.nx + i;
      return [
        [summary.measure.label, format(grid.values[frame]?.[k])],
        [summary.x.field, grid.x[i]],
        ...(grid.y.length ? [[summary.y.field, grid.y[j]]] : []),
        ...(grid.t.length ? [[summary.t.field, grid.t[frame]]] : []),
        ["rows", exact.format(grid.rows[frame]?.[k] ?? 0)],
      ];
    }

    let view, eye, width, height, headPx;

    function render() {
      const ratio = devicePixelRatio || 1;
      [width, height] = [canvas.clientWidth, canvas.clientHeight];
      for (const surface of [canvas, labels]) {
        if (surface.width !== Math.round(width * ratio) || surface.height !== Math.round(height * ratio)) [surface.width, surface.height] = [Math.round(width * ratio), Math.round(height * ratio)];
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      if (!bed) return label("Drawing the rack needs WebGL2.", width / 2, height / 2);

      const direction = [Math.cos(camera.pitch) * Math.sin(camera.yaw), Math.sin(camera.pitch), Math.cos(camera.pitch) * Math.cos(camera.yaw)];
      const aspect = width / Math.max(1, height);
      const distance = (DISTANCE * Math.max(1, 1.5 / aspect)) / camera.zoom;
      eye = direction.map((value, index) => TARGET[index] + value * distance);
      view = multiply(perspective(0.6, aspect, 0.05, 40), lookAt(eye, TARGET, [0, 1, 0]));
      const radius = layout.pitch * PIN;
      const extent = [(layout.px * layout.pitch) / 2 + MARGIN, (layout.py * layout.pitch) / 2 + MARGIN];
      headPx = Math.max(3, Math.abs(project(view, radius, 0, 0, width, height)[0] - project(view, 0, 0, 0, width, height)[0]));

      const { px, x, y } = layout;
      const near = (cell, p) => {
        if (!cell) return 0;
        if (layout.line) return owner[p] === indexOf(cell) ? tone[p] : 0;
        return Math.max(0, 1 - Math.hypot(x.f[p % px] - cell.i, y.f[Math.floor(p / px)] - cell.j));
      };
      for (let p = 0; p < lifts.length; p++) {
        lifts[p] = shown[p] * TRAVEL;
        [shades[p * 2], shades[p * 2 + 1]] = [tone[p], Math.max(0.2 * near(selected, p), 0.1 * near(hovered, p))];
      }
      bed.draw({ view, eye, radius, extent, lifts, shades, ink });
      if (!panel.hidden) axes(extent);
      if (!n.nx) label("No cells: no row could be placed.", width / 2, 28, ink.title);
    }

    function label(value, x, y, fill = ink.text, align = "center", font = "11px 'Geist Mono', monospace") {
      context.fillStyle = paint(fill);
      context.textAlign = align;
      context.textBaseline = "middle";
      context.font = font;
      context.fillText(value, x, y);
    }

    // The cage's edges carry the axes, each its name and its first and last value: x and y on the bottom edges nearest
    // the eye, z on the vertical edge outermost on screen — or, for a line, along the side edge in depth, each series
    // named at its line's end. A label that would overlap one already drawn is left out.
    function axes([ex, ez]) {
      if (!n.nx) return;
      const { grid, summary } = current.visual;
      const at = (x, y, z) => project(view, x, y, z, width, height);
      const placed = [];
      const put = (value, [x, y, w], fill, align = "center", font = "11px 'Geist Mono', monospace") => {
        if (w <= 0) return;
        context.font = font;
        const half = context.measureText(value).width / 2 + 4;
        const middle = align === "left" ? x + half : align === "right" ? x - half : x;
        if (placed.some(([px, py, ph]) => Math.abs(px - middle) < ph + half && Math.abs(py - y) < 14)) return;
        placed.push([middle, y, half]);
        label(value, x, y, fill, align, font);
      };
      const name = "500 12px Geist, sans-serif";
      const [sx, sz] = [Math.sign(eye[0]) || 1, Math.sign(eye[2]) || 1];
      const level = (share) => share * TRAVEL;
      const ticks = [[scale.high, 1], [0, rest], ...(scale.low < 0 ? [[scale.low, 0]] : [])];
      const { place, depth } = layout;
      if (layout.line) {
        const side = sx > 0 ? "left" : "right";
        for (const [value, share] of ticks) put(short(value), at(sx * (ex + 0.06), 0, depth(share)), ink.text, side);
        put(summary.measure.label, at(sx * (ex + 0.06), 0, depth(1) - 0.16), ink.title, side, name);
        const shares = lift(current.visual, frame);
        for (let j = 0; j < (summary.y ? n.ny : 0); j++) {
          const i = shares.slice(j * n.nx, (j + 1) * n.nx).findLastIndex((share) => !Number.isNaN(share));
          if (i >= 0) put(clip(grid.y[j]), at(place(i, 0)[0] + 0.04, RIDGE * TRAVEL, depth(shares[j * n.nx + i])), ink.text, "left");
        }
      } else {
        const corners = [[-ex, -ez], [ex, -ez], [-ex, ez], [ex, ez]].map(([x, z]) => [x, z, at(x, level(0.5), z)[0]]);
        const [cx, cz] = corners.reduce((left, corner) => (corner[2] < left[2] ? corner : left));
        const out = (value) => value + Math.sign(value) * 0.06;
        for (const [value, share] of ticks) put(short(value), at(out(cx), level(share), out(cz)), ink.text, "right");
        put(summary.measure.label, at(out(cx), level(1) + 0.12, out(cz)), ink.title, "right", name);
      }

      const base = -LENGTH;
      const [x0, x1] = [place(0, 0)[0], place(n.nx - 1, 0)[0]];
      put(summary.x.field, at(0, base, sz * (ez + 0.3)), ink.title, "center", name);
      put(clip(grid.x[0]), at(x0, base, sz * (ez + 0.14)), ink.text);
      if (n.nx > 1) put(clip(grid.x[n.nx - 1]), at(x1, base, sz * (ez + 0.14)), ink.text);
      if (!summary.y || layout.line) return;
      const [y0, y1] = [place(0, 0)[1], place(0, n.ny - 1)[1]];
      put(summary.y.field, at(sx * (ex + 0.3), base, 0), ink.title, "center", name);
      put(clip(grid.y[0]), at(sx * (ex + 0.14), base, y0), ink.text);
      if (n.ny > 1) put(clip(grid.y[n.ny - 1]), at(sx * (ex + 0.14), base, y1), ink.text);
    }

    function tick(now) {
      const t = clamp((now - motion.start) / motion.ms, 0, 1);
      if (t > 0 && shown.some((value, k) => value !== goal[k])) {
        const eased = 1 - (1 - t) ** 3;
        for (let k = 0; k < shown.length; k++) shown[k] = t === 1 ? goal[k] : from[k] + (goal[k] - from[k]) * eased;
        dirty = true;
      }
      if (dirty) render();
      dirty = false;
      raf = requestAnimationFrame(tick);
    }

    /* ----- interaction ----- */

    // The pin whose top is under the pointer, nearest the eye.
    function hit(event) {
      if (!view || !n.nx) return null;
      const bounds = canvas.getBoundingClientRect();
      const [mx, my] = [event.clientX - bounds.left, event.clientY - bounds.top];
      const { at } = layout;
      let [best, depth] = [-1, Infinity];
      for (let p = 0; p < lifts.length; p++) {
        if (owner[p] < 0) continue;
        const [sx, sy, w] = project(view, at[p * 2], lifts[p], at[p * 2 + 1], width, height);
        if (w > 0 && w < depth && Math.abs(sx - mx) < headPx && Math.abs(sy - my) < headPx) [best, depth] = [owner[p], w];
      }
      return best < 0 ? null : { i: best % n.nx, j: Math.floor(best / n.nx) };
    }

    function details(on) {
      panel.hidden = !on;
      element("panel").setAttribute("aria-expanded", String(on));
      for (const part of root.querySelectorAll(".pins-chrome")) part.hidden = !on;
      form.hidden = !edit || !on;
      dirty = true;
    }

    // What a pin is, at once; held still for a second, also its rows and its rank in the frame.
    function hint(cell, more) {
      const { grid, summary } = current.visual;
      const k = indexOf(cell);
      const value = grid.values[frame]?.[k];
      const where = [[summary.x.field, grid.x[cell.i]], ...(grid.y.length ? [[summary.y.field, grid.y[cell.j]]] : []), ...(grid.t.length ? [[summary.t.field, grid.t[frame]]] : [])];
      const lines = where.map(([name, label]) => `<span class="hint">${esc(name)}</span> ${esc(label)}`);
      if (more) {
        const filled = grid.values[frame].filter((other) => other != null);
        const rank = value == null ? null : filled.filter((other) => other > value).length + 1;
        lines.push(`<span class="hint">rows</span> ${exact.format(grid.rows[frame]?.[k] ?? 0)}`);
        if (rank) lines.push(`<span class="hint">rank</span> ${exact.format(rank)} of ${exact.format(filled.length)}`);
      }
      return `<b>${esc(format(value))}</b> <span class="hint">${esc(summary.measure.label)}</span><br>${lines.join("<br>")}`;
    }

    function close() {
      clearInterval(timer);
      clearTimeout(lingering);
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("keydown", onKey, true);
      bed?.release();
      root.remove();
    }

    function onKey(event) {
      if (event.key !== "Escape" || event.target.closest?.("input, select")) return;
      event.stopPropagation();
      close();
    }

    function play() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      } else timer = setInterval(() => setFrame((frame + 1) % n.nf), FRAME_MS);
      element("play").textContent = timer ? "Pause" : "Play";
    }

    root.addEventListener("click", (event) => {
      const preset = event.target.closest("[data-camera]")?.dataset.camera;
      if (preset) {
        Object.assign(camera, CAMERAS[preset], { zoom: 1 });
        dirty = true;
        return;
      }
      const action = event.target.closest("[data-pins]")?.dataset.pins;
      if (action === "close") close();
      if (action === "play") play();
      if (action === "panel") details(panel.hidden);
      if (action === "copy") navigator.clipboard?.writeText(JSON.stringify(current.visual, null, 2));
    });
    root.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (event.target === form) {
        const numeric = new Set(["resolution", "min_rows"]);
        const args = Object.fromEntries([...new FormData(form)].filter(([, value]) => value.trim()).map(([name, value]) => [name, numeric.has(name) ? Number(value) : value.trim()]));
        element("status").textContent = "plotting…";
        try {
          show(await edit(args));
        } catch (error) {
          element("status").textContent = `${error.code ?? "error"}: ${error.message}`;
        }
        return;
      }
      const question = new FormData(event.target).get("question")?.trim();
      if (!question) return;
      answer = "asking…";
      panel.innerHTML = panelHtml();
      try {
        answer = await ask(selected ? `${current.path}/cells/${cellId(selected)}` : current.path, question);
      } catch (error) {
        answer = `${error.code ?? "error"}: ${error.message}`;
      }
      panel.innerHTML = panelHtml();
    });
    slider.addEventListener("input", () => setFrame(Number(slider.value)));
    // Arrow keys move the chosen cell: left and right along x, up to the back and down to the front.
    canvas.addEventListener("keydown", (event) => {
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
      if (!step || !n.nx) return;
      event.preventDefault();
      const back = current.visual.summary.y?.kind === "category" ? -1 : 1;
      const from = selected ?? { i: 0, j: 0 };
      selected = { i: clamp(from.i + step[0], 0, n.nx - 1), j: clamp(from.j + step[1] * back, 0, n.ny - 1) };
      [answer, dirty] = ["", true];
      details(true);
      panel.innerHTML = panelHtml();
    });
    canvas.addEventListener("pointerdown", (event) => {
      const [startX, startY] = [event.clientX, event.clientY];
      let [lastX, lastY, moved] = [startX, startY, false];
      canvas.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        moved ||= Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 4;
        if (!moved) return;
        tip.hidden = true;
        camera.yaw += (moveEvent.clientX - lastX) * 0.008;
        camera.pitch = clamp(camera.pitch + (moveEvent.clientY - lastY) * 0.006, -1.2, 1.56);
        [lastX, lastY, dirty] = [moveEvent.clientX, moveEvent.clientY, true];
      };
      const end = (endEvent) => {
        for (const [type, listener] of [["pointermove", move], ["pointerup", end], ["pointercancel", end]]) canvas.removeEventListener(type, listener);
        if (moved || endEvent.type === "pointercancel") return;
        const cell = hit(endEvent);
        [selected, answer, dirty] = [same(cell, selected) ? null : cell, "", true];
        if (selected) details(true);
        panel.innerHTML = panelHtml();
      };
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", end);
      canvas.addEventListener("pointercancel", end);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (event.buttons) return;
      const cell = hit(event);
      Object.assign(tip.style, { left: `${event.clientX + 14}px`, top: `${event.clientY + 14}px` });
      if (same(cell, hovered)) return;
      [hovered, dirty, tip.hidden] = [cell, true, !cell];
      clearTimeout(lingering);
      if (!cell) return;
      tip.innerHTML = hint(cell, false);
      lingering = setTimeout(() => same(cell, hovered) && (tip.innerHTML = hint(cell, true)), MORE_MS);
    });
    canvas.addEventListener("pointerleave", () => {
      tip.hidden = true;
      clearTimeout(lingering);
      [hovered, dirty] = [null, true];
    });
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        camera.zoom = clamp(camera.zoom * Math.exp(-event.deltaY * 0.001), 0.4, 6);
        dirty = true;
      },
      { passive: false },
    );
    // A GPU reset loses the context; once it is back, the rack is built again.
    canvas.addEventListener("webglcontextlost", (event) => event.preventDefault());
    canvas.addEventListener("webglcontextrestored", () => {
      bed = stage(gl);
      bed.rack(layout.at);
      dirty = true;
    });
    const observer = new ResizeObserver(() => (dirty = true));
    observer.observe(canvas);
    document.addEventListener("keydown", onKey, true);

    show({ visual, text, path });
    tick(performance.now());
    return { show, close };
  }

  globalThis.Pins = { reach, heights, zero, lift, rack, surface, sand, open };
})();
