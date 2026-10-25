"use strict";

/* ---------- helpers ---------- */

const esc = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const FULL = new Intl.NumberFormat("en");
const compact = (value) => (value == null ? "—" : COMPACT.format(value));
const full = (value) => (value == null ? "—" : FULL.format(value));
const short = (id) => id.slice(0, 8);
const sum = (items, pick) => items.reduce((total, item) => total + (pick(item) ?? 0), 0);
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
const refresh = (id, html) => {
  const element = document.getElementById(id);
  if (element) element.innerHTML = html;
};

function size(value) {
  if (value == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value < 10 && index ? 1 : 0)} ${units[index]}`;
}

/* ---------- API: ds-fetch, ds-config and ds-tools through server.ts ---------- */

class ApiError extends Error {
  constructor(status, body, requestId) {
    const detail = body?.details?.[0];
    super(detail?.message ?? body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = detail?.code ?? body?.code ?? body?.class ?? String(status);
    this.requestId = requestId;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body && JSON.stringify(body) });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, json, response.headers.get("x-request-id"));
  return { body: json, headers: response.headers };
}

const errorText = (error, sql) =>
  [`${error.status ?? ""} ${error.code ?? "error"}`.trim(), error.message, error.requestId && `request ${error.requestId}`, sql && `\n${sql}`].filter(Boolean).join("\n");

const errorNote = (error, sql) =>
  `<div class="note err"><div class="note-head"><b>${esc(`${error.status ? `${error.status} · ` : ""}${error.code ?? "error"}`)}</b><button class="add" data-copy="${esc(errorText(error, sql))}">copy</button></div><pre class="note-text">${esc(error.message)}</pre>${error.requestId ? `<p class="hint mono">request ${esc(error.requestId)}</p>` : ""}</div>`;

async function pages(path, onPage = () => {}, cap = 20) {
  const items = [];
  for (let page = 0; page < cap; page++) {
    const { body } = await api(`${path}${path.includes("?") ? "&" : "?"}limit=500&offset=${page * 500}`);
    items.push(...body.data);
    onPage(body.data, body.page.total);
    if (!body.page.has_next) break;
  }
  return { items, total: items.length };
}

const query = (sql) => api("/api/fetch/query/", { method: "POST", body: { sql } });

const lazyCache = new Map();
function lazy(key, load) {
  if (!lazyCache.has(key)) {
    const entry = { status: "loading" };
    lazyCache.set(key, entry);
    load()
      .then((value) => Object.assign(entry, { status: "ready", value }))
      .catch((error) => Object.assign(entry, { status: "error", error }))
      .finally(() => state.view === "explore" && render());
  }
  return lazyCache.get(key);
}

/* ---------- catalogue ---------- */

const LAYERS = [
  { id: "bronze", label: "Bronze", blurb: "Raw pipeline runs, any source format." },
  { id: "silver", label: "Silver", blurb: "Typed and renamed by the pipeline's transform." },
  { id: "gold", label: "Gold", blurb: "Merged, deduplicated parquet with partitions and history." },
  { id: "platinum", label: "Platinum", blurb: "Joined marts and semantic models across gold. Not served by Fetch yet.", proposed: true },
];
const LAYER_BY_ID = new Map(LAYERS.map((layer) => [layer.id, layer]));
const SYSTEM_NAMES = new Set(["_uid", "_tenant_id", "_system_time", "_valid_from", "_valid_to"]);

const data = {
  status: "loading",
  error: null,
  env: "",
  user: null,
  tenant: null,
  gold: [],
  bronze: [],
  silver: [],
  goldById: new Map(),
  pipelineConfig: new Map(),
  runs: { bronze: [], silver: [] },
  totals: {},
  complete: {},
  runErrors: {},
  owners: new Map(),
};

const settled = (promise, fallback) => promise.catch(() => fallback);
const columnsOf = (dataset) => dataset.columns.map((column) => [column.name, column.type]);
const ownerName = (id) => data.owners.get(id);

function toGold(dataset, config) {
  const id = dataset.name.slice("gold.".length);
  const meta = config.get(id);
  const columns = columnsOf(dataset);
  return {
    id,
    layer: "gold",
    fetchName: dataset.name,
    name: meta?.name ?? id,
    named: !!meta,
    description: meta?.description ?? "",
    owner: meta?.owner_id,
    columns,
    partitions: dataset.partition_columns,
    pk: meta?.settings?.primary_key_fields?.[0],
    history: meta?.settings?.history_mode ?? (columns.some(([name]) => name === "_valid_to") ? "scd2" : "none"),
    rows: dataset.row_count,
    bytes: dataset.byte_size,
    files: dataset.file_count,
    pipelines: [],
  };
}

function toPipelines(layer) {
  const groups = new Map();
  for (const run of data.runs[layer]) {
    const [pipelineId, jobId] = run.name.slice(layer.length + 1).split("/");
    const group = groups.get(pipelineId) ?? { id: pipelineId, layer, runs: [], columns: columnsOf(run), partitions: [], history: "none" };
    group.runs.push({ id: jobId, kind: "run", label: jobId, files: run.file_count, columns: columnsOf(run) });
    groups.set(pipelineId, group);
  }
  return [...groups.values()].map((group) => {
    const config = data.pipelineConfig.get(group.id);
    const gold = data.goldById.get(config?.gold_id);
    if (gold && !gold.pipelines.includes(group.id)) gold.pipelines.push(group.id);
    return { ...group, config, gold, name: config?.name ?? gold?.name ?? group.id, files: sum(group.runs, (run) => run.files) };
  });
}

// Background updates must not wipe the SQL editor or an input the user is typing in.
const quietRender = () => state.view !== "query" && !document.activeElement?.matches("input, select") && render();

const requestedOwners = new Set();
async function resolveOwners(ids) {
  const missing = [...new Set(ids)].filter((id) => id && /^[0-9a-f-]{36}$/.test(id) && !requestedOwners.has(id));
  missing.forEach((id) => requestedOwners.add(id));
  for (let index = 0; index < missing.length; index += 100) {
    const batch = missing.slice(index, index + 100);
    const { body } = await settled(api(`/api/config/owner/?limit=100&id_in=${batch.join(",")}`), { body: { data: [] } });
    body.data.forEach((owner) => data.owners.set(owner.id, owner.name));
  }
  if (missing.length) quietRender();
}

async function streamRuns(layer) {
  try {
    await pages(`/api/fetch/dataset/?layer=${layer}`, (items, total) => {
      data.runs[layer].push(...items);
      data.totals[layer] = total;
      data.gold.forEach((item) => (item.pipelines = []));
      data.silver = toPipelines("silver");
      data.bronze = toPipelines("bronze");
      quietRender();
    });
  } catch (error) {
    data.runErrors[layer] = error.message;
  }
  data.complete[layer] = true;
  quietRender();
}

async function load() {
  try {
    const [gold, configGold, pipelines, tenants] = await Promise.all([
      pages("/api/fetch/dataset/?layer=gold"),
      settled(pages("/api/config/dataset/?type=ds.resource.dataset.aic-gold"), { items: [] }),
      settled(pages("/api/config/pipeline/"), { items: [] }),
      settled(api("/api/config/tenant/?limit=1"), { body: { data: [] } }),
    ]);
    const config = new Map(configGold.items.map((item) => [item.id, item]));
    data.pipelineConfig = new Map(pipelines.items.map((item) => [item.id, item]));
    data.tenant = tenants.body.data[0] ?? null;
    data.gold = gold.items.map((item) => toGold(item, config));
    data.goldById = new Map(data.gold.map((item) => [item.id, item]));
    data.totals.gold = gold.total;
    data.status = "ready";
  } catch (error) {
    Object.assign(data, { status: error.status === 401 ? "signed-out" : "error", error });
  }
  render();
  if (data.status !== "ready") return;
  resolveOwners(data.gold.map((item) => item.owner));
  ["bronze", "silver"].forEach(streamRuns);
}

const itemsOf = (layer) => (layer === "gold" ? data.gold : data[layer] ?? []);

function layerStats(layer) {
  if (layer === "gold") {
    return { count: data.totals.gold, unit: "datasets", facts: [["Rows", compact(sum(data.gold, (item) => item.rows))], ["Size", size(sum(data.gold, (item) => item.bytes))], ["Files", full(sum(data.gold, (item) => item.files))]] };
  }
  const pipelines = itemsOf(layer);
  const loaded = data.runs[layer].length;
  const progress = data.runErrors[layer] ? [["Failed", data.runErrors[layer]]] : data.complete[layer] && loaded >= (data.totals[layer] ?? 0) ? [] : [["Loaded", `${full(loaded)} of ${full(data.totals[layer])}`]];
  return { count: data.totals[layer], unit: "runs", facts: [["Pipelines", full(pipelines.length)], ["Files", full(sum(pipelines, (item) => item.files))], ...progress] };
}

/* ---------- state ---------- */

const state = {
  view: "explore",
  layer: null,
  path: [],
  tab: "overview",
  previewAs: null,
  laneQuery: "",
  laneOwner: "",
  laneSort: "rows",
  query: { sql: "", path: "", question: "", ask: null, context: [], result: null, resultTab: "table", history: [] },
};

/* ---------- drill-down: layer → dataset → partition → partition, or layer → pipeline → run ---------- */

function resolveChain() {
  const root = state.layer && itemsOf(state.layer).find((item) => item.id === state.path[0]);
  if (!root) return [];
  const chain = [root];
  for (const id of state.path.slice(1)) {
    const node = childColumn(chain)?.nodes.find((candidate) => candidate.id === id);
    if (!node) break;
    chain.push(node);
  }
  return chain;
}

const scopeOf = (chain) => chain.filter((node) => node.kind === "partition");

function whereOf(chain) {
  const root = chain[0];
  return scopeOf(chain).map((node) => {
    if (node.value === null) return `"${node.key}" IS NULL`;
    const type = root.columns.find(([name]) => name === node.key)?.[1] ?? "VARCHAR";
    return `"${node.key}" = ${/INT|DECIMAL|DOUBLE|FLOAT/.test(type) ? node.value : literal(node.value)}`;
  });
}

function childColumn(chain) {
  const root = chain[0];
  const depth = chain.length - 1;
  if (state.layer !== "gold") {
    if (depth > 0) return null;
    const max = Math.max(1, ...root.runs.map((run) => run.files));
    return { title: "runs", hint: `${root.runs.length} · 30-day retention`, nodes: root.runs.map((run) => ({ ...run, share: run.files / max })) };
  }
  const key = root.partitions[depth];
  if (!key) return null;
  const where = whereOf(chain);
  const sql = `SELECT "${key}" AS value, count(*) AS n\nFROM gold."${root.id}"\n${where.length ? `WHERE ${where.join(" AND ")}\n` : ""}GROUP BY 1\nORDER BY 2 DESC\nLIMIT 200`;
  const entry = lazy(sql, () => query(sql).then((response) => response.body));
  if (entry.status !== "ready") return { title: key, hint: entry.status === "loading" ? "querying…" : "failed", nodes: [], error: entry.error, sql };
  if (key === "owner_id") resolveOwners(entry.value.rows.map(([value]) => value));
  const total = Math.max(1, sum(entry.value.rows, (row) => row[1]));
  const nodes = entry.value.rows.map(([value, count]) => ({
    id: `${key}=${value}`,
    kind: "partition",
    key,
    value,
    label: value === null ? "null" : (key === "owner_id" && ownerName(value)) || String(value),
    rows: count,
    share: count / total,
  }));
  return { title: key, hint: `${nodes.length}${entry.value.truncated || nodes.length === 200 ? "+" : ""} values`, nodes };
}

function sqlRef(chain) {
  const run = chain.find((node) => node.kind === "run");
  if (state.layer === "gold") return `gold."${chain[0].id}"`;
  return `${state.layer}."${chain[0].id}/${(run ?? chain[0].runs[0]).id}"`;
}

function crn(chain) {
  const tenant = data.tenant ? short(data.tenant.id) : "<tenant>";
  const run = chain.find((node) => node.kind === "run");
  const path = state.layer === "gold" ? ["gold", chain[0].id, ...scopeOf(chain).map((node) => `${node.key}=${node.value}`)] : [state.layer, chain[0].id, run ? run.id : "*"];
  return `crn:${tenant}::fetch::dataset:${path.join("/")}`;
}

function scopeSql(chain) {
  const where = [...whereOf(chain), chain[0].history === "scd2" && "_valid_to IS NULL"].filter(Boolean);
  return `SELECT *\nFROM ${sqlRef(chain)}\n${where.length ? `WHERE ${where.join("\n  AND ")}\n` : ""}LIMIT 100`;
}

/* ---------- shared fragments ---------- */

const resizer = '<div class="resizer" role="separator" aria-orientation="vertical" title="Drag to resize · double-click to reset"></div>';
const section = (title, body) => `<div class="section"><h3>${title}</h3>${body}</div>`;
const metric = (label, value) => `<div class="metric"><span>${label}</span><b>${value}</b></div>`;
const style = (layer) => `style="--layer: var(--${layer})"`;
const loadingHtml = () => (data.status === "error" ? errorNote(data.error) : '<p class="empty">Loading the catalogue…</p>');

function itemMeta(item) {
  const id = item.name === item.id ? "" : `${short(item.id)} · `;
  return item.layer === "gold" ? `${id}${compact(item.rows)} rows · ${size(item.bytes)}` : `${id}${item.runs.length} runs · ${full(item.files)} files`;
}

function datasetRow(item, depth, selected) {
  return `<button class="row ${selected ? "on" : ""}" data-action="select" data-depth="${depth}" data-id="${item.id}">
    <span class="row-top"><span class="grow ellipsis">${esc(item.name)}</span></span>
    <span class="row-meta">${itemMeta(item)}</span>
  </button>`;
}

function nodeRow(node, depth, selected) {
  const meta = node.kind === "partition" ? `${compact(node.rows)} rows · ${(node.share * 100).toFixed(node.share < 0.01 ? 1 : 0)}%` : `${full(node.files)} files`;
  return `<button class="row ${selected ? "on" : ""}" data-action="select" data-depth="${depth}" data-id="${esc(node.id)}">
    <span class="row-top"><span class="grow ellipsis ${node.kind === "run" ? "mono" : ""}">${esc(node.label)}</span></span>
    <span class="row-meta">${meta}</span>
    <span class="bar"><i style="width:${(node.share * 100).toFixed(1)}%"></i></span>
  </button>`;
}

/* ---------- overview ---------- */

function overviewView() {
  if (data.status !== "ready") return `<section class="overview">${loadingHtml()}</section>`;
  const compaction = data.gold.filter((item) => item.files > 4 && item.bytes / item.files < 32 * 2 ** 20).slice(0, 4);
  const unnamed = data.gold.filter((item) => !item.named).slice(0, 3);
  const flat = data.gold.filter((item) => !item.partitions.length && item.rows > 1e6).slice(0, 2);
  const attention = [
    ...compaction.map((item) => attentionItem(item, `${full(item.files)} files averaging ${size(item.bytes / item.files)}. Needs compaction.`, "warn")),
    ...flat.map((item) => attentionItem(item, `${compact(item.rows)} rows and no partitions. Every query scans all of it.`, "warn")),
    ...unnamed.map((item) => attentionItem(item, "No business name in DS Config. text_to_sql only sees the UUID.", "")),
  ];
  const ranked = (list, value, max) =>
    list
      .map(
        (item) => `<button class="row" data-action="goto" data-layer="gold" data-id="${item.id}" ${style("gold")}>
          <span class="row-top"><span class="grow ellipsis">${esc(item.name)}</span><span class="mono muted">${value(item)}</span></span>
          ${max ? `<span class="bar"><i style="width:${(((item.rows ?? 0) / max) * 100).toFixed(1)}%"></i></span>` : ""}
        </button>`,
      )
      .join("") || '<p class="hint">No gold datasets.</p>';
  const largest = [...data.gold].sort((left, right) => (right.rows ?? 0) - (left.rows ?? 0)).slice(0, 8);
  const pipelines = [...data.silver].sort((left, right) => right.runs.length - left.runs.length).slice(0, 8);
  return `<section class="overview">
    <div><h1>${esc(data.tenant?.name ?? "Lakehouse")}</h1><p class="muted">${data.env || "—"} · every layer queryable through one SQL surface</p></div>
    <div class="flow">${LAYERS.map((layer, index) => `${index ? '<span class="arrow">→</span>' : ""}${flowCard(layer)}`).join("")}</div>
    <div class="ov-grid">
      <div class="panel"><h3>Needs attention</h3>${attention.join("") || '<p class="hint">Nothing flagged.</p>'}</div>
      <div class="panel"><h3>Largest gold datasets</h3><div class="dist">${ranked(largest, (item) => compact(item.rows), largest[0]?.rows)}</div></div>
      <div class="panel"><h3>Busiest pipelines</h3><div class="dist">${
        pipelines
          .map((item) => `<button class="row" data-action="goto" data-layer="silver" data-id="${item.id}" ${style("silver")}><span class="row-top"><span class="grow ellipsis">${esc(item.name)}</span><span class="mono muted">${item.runs.length} runs</span></span></button>`)
          .join("") || '<p class="hint">No pipeline runs.</p>'
      }</div></div>
    </div>
  </section>`;
}

function flowCard(layer) {
  if (layer.proposed) {
    return `<div class="flow-card" ${style(layer.id)}><span class="lane-kicker"><span class="dot"></span>${layer.label}<span class="badge">proposed</span></span><span class="muted">${layer.blurb}</span></div>`;
  }
  const stats = layerStats(layer.id);
  return `<button class="flow-card" data-action="layer" data-layer="${layer.id}" ${style(layer.id)}>
    <span class="lane-kicker"><span class="dot"></span>${layer.label}</span>
    <span class="lane-total">${compact(stats.count)}<small>${stats.unit}</small></span>
    <span class="kv">${stats.facts.map(([label, value]) => `<span>${label}</span><b>${value}</b>`).join("")}</span>
  </button>`;
}

function attentionItem(item, text, level) {
  return `<button class="item" data-action="goto" data-layer="gold" data-id="${item.id}" ${style("gold")}>
    <span class="item-top"><span class="dot"></span><span class="grow ellipsis">${esc(item.name)}</span><span class="badge">gold</span></span>
    <span class="insight ${level}"><span>${text}</span></span>
  </button>`;
}

/* ---------- explore ---------- */

function exploreView() {
  if (data.status !== "ready") return `<section class="explore intro"><div class="crumbs">datalake</div>${loadingHtml()}</section>`;
  const chain = resolveChain();
  const columns = [];
  for (let depth = 1; depth <= chain.length; depth++) {
    const column = childColumn(chain.slice(0, depth));
    if (!column) break;
    const body = column.error
      ? errorNote(column.error, column.sql)
      : column.nodes.map((node) => nodeRow(node, depth, chain[depth]?.id === node.id)).join("") || '<p class="empty">Querying…</p>';
    columns.push(`<div class="col">
      <div class="col-head"><b>${esc(column.title)}</b><span class="muted mono">${column.hint}</span></div>
      <div class="col-body">${body}</div>
    </div>`);
  }
  return `<section class="explore ${state.layer ? "" : "intro"}" data-layer="${state.layer ?? ""}">
    <div class="crumbs">${crumbs(chain)}<span class="grow"></span>${state.layer ? "" : "<span>bronze → silver → gold → platinum · pick a layer to drill in</span>"}</div>
    <div class="miller">${LAYERS.map(laneHtml).join("")}${columns.join("")}</div>
    ${state.layer ? `<aside class="inspector">${inspectorHtml(chain)}</aside>` : ""}
  </section>`;
}

function crumbs(chain) {
  const parts = [`<button data-action="layer" data-layer="">datalake</button>`];
  if (state.layer) parts.push(`<button data-action="crumb" data-depth="0">${state.layer}</button>`);
  chain.forEach((node, index) => {
    const label = index === 0 ? node.name : node.kind === "partition" ? `${node.key}=${node.label}` : `run ${node.label}`;
    parts.push(`<button data-action="crumb" data-depth="${index + 1}">${esc(label)}</button>`);
  });
  parts[parts.length - 1] = parts.at(-1).replace("<button", '<button class="here"');
  return parts.join("<span>/</span>");
}

function laneHtml(layer) {
  if (!state.layer) return introLane(layer);
  if (state.layer !== layer.id) {
    const count = layer.proposed ? "" : ` <b>${compact(layerStats(layer.id).count)}</b>`;
    const tag = layer.proposed ? "div" : "button";
    return `<${tag} class="lane strip" ${style(layer.id)} ${layer.proposed ? "" : `data-action="layer" data-layer="${layer.id}"`} title="${layer.label}">
      <span class="dot"></span><span class="vlabel">${layer.label}${count}</span>
    </${tag}>`;
  }
  const stats = layerStats(layer.id);
  const owners = [...new Set(itemsOf(layer.id).map((item) => item.owner).filter(Boolean))].slice(0, 10);
  const sorts = layer.id === "gold" ? [["rows", "Most rows"], ["bytes", "Largest"], ["files", "Most files"], ["name", "Name"]] : [["runs", "Most runs"], ["files", "Most files"], ["name", "Name"]];
  return `<div class="lane open" ${style(layer.id)}>
    ${resizer}
    <div class="col-head">
      <button class="lane-title" data-action="layer" data-layer="" title="Back to all layers"><span class="dot"></span>${layer.label}</button>
      <span class="muted mono">${full(stats.count)} ${stats.unit}</span>
    </div>
    <div class="lane-tools">
      <input id="lane-search" class="input" placeholder="Filter by name, id or column" value="${esc(state.laneQuery)}" autocomplete="off" />
      ${owners.length ? `<div class="chips">${owners.map((owner) => `<button class="chip ${state.laneOwner === owner ? "on" : ""}" data-action="owner" data-owner="${owner}">${esc(ownerName(owner) ?? short(owner))}</button>`).join("")}</div>` : ""}
      <select id="lane-sort" class="input">${sorts.map(([value, label]) => `<option value="${value}" ${state.laneSort === value ? "selected" : ""}>${label}</option>`).join("")}</select>
    </div>
    <div class="col-body" id="lane-list">${laneList(layer)}</div>
  </div>`;
}

function introLane(layer) {
  if (layer.proposed) {
    return `<div class="lane intro" ${style(layer.id)}>
      <span class="lane-kicker"><span class="dot"></span>${layer.label}<span class="badge">proposed</span></span>
      <span class="lane-total">—</span>
      <span class="muted">${layer.blurb}</span>
    </div>`;
  }
  const stats = layerStats(layer.id);
  const items = [...itemsOf(layer.id)].sort(layer.id === "gold" ? SORTS.rows : SORTS.runs).slice(0, 6);
  return `<button class="lane intro" ${style(layer.id)} data-action="layer" data-layer="${layer.id}">
    <span class="lane-kicker"><span class="dot"></span>${layer.label}</span>
    <span class="lane-total">${compact(stats.count)}<small>${stats.unit}</small></span>
    <span class="muted">${layer.blurb}</span>
    <span class="kv">${stats.facts.map(([label, value]) => `<span>${label}</span><b>${value}</b>`).join("")}</span>
    <span class="lane-list">${
      items.map((item) => `<span class="mini"><span class="ellipsis">${esc(item.name)}</span><span class="muted mono">${layer.id === "gold" ? compact(item.rows) : `${item.runs.length} runs`}</span></span>`).join("") ||
      '<span class="muted">Nothing granted in this layer.</span>'
    }</span>
    <span class="lane-cta">Open ${layer.label.toLowerCase()} →</span>
  </button>`;
}

const SORTS = {
  rows: (left, right) => (right.rows ?? 0) - (left.rows ?? 0),
  bytes: (left, right) => (right.bytes ?? 0) - (left.bytes ?? 0),
  files: (left, right) => right.files - left.files,
  runs: (left, right) => right.runs.length - left.runs.length,
  name: (left, right) => left.name.localeCompare(right.name),
};

function laneList(layer) {
  const needle = state.laneQuery.trim().toLowerCase();
  const all = itemsOf(layer.id);
  const items = all
    .filter((item) => !state.laneOwner || item.owner === state.laneOwner)
    .filter((item) => !needle || item.name.toLowerCase().includes(needle) || item.id.startsWith(needle) || item.columns.some(([name]) => name.toLowerCase().includes(needle)))
    .sort(SORTS[state.laneSort]);
  return `${items.map((item) => datasetRow(item, 0, state.path[0] === item.id)).join("") || '<p class="empty">No match</p>'}
    <p class="col-foot">Showing ${items.length} of ${full(all.length)}.</p>`;
}

/* ---------- inspector ---------- */

function inspectorHtml(chain) {
  const layer = LAYER_BY_ID.get(state.layer);
  if (!chain.length) return layerSummary(layer);
  const root = chain[0];
  const node = chain.at(-1);
  const scope = scopeOf(chain);
  const run = chain.find((item) => item.kind === "run");
  const tabs = ["overview", "schema", "preview", "lineage", ...(root.config?.transform || root.pipelines?.length ? ["transform"] : [])];
  const tab = tabs.includes(state.tab) ? state.tab : "overview";
  const ref = sqlRef(chain);
  const metrics =
    state.layer === "gold"
      ? node === root
        ? [["Rows", compact(root.rows)], ["Size", size(root.bytes)], ["Files", full(root.files)], ["Columns", root.columns.length]]
        : [["Rows", compact(node.rows)], ["Share", `${(node.share * 100).toFixed(1)}%`], ["Size est.", size(root.rows ? (root.bytes * node.rows) / root.rows : null)], ["Columns", root.columns.length]]
      : [["Runs", root.runs.length], ["Files", full((run ?? root).files)], ["Columns", (run ?? root).columns.length], ["Gold", root.gold ? "linked" : "—"]];
  return `<div class="insp-head">
      <div class="insp-badges">
        <span class="badge layer">${layer.label}</span>
        ${root.history === "scd2" ? '<span class="badge">history</span>' : ""}
        ${scope.map((item) => `<button class="badge" data-copy="${esc(item.label)}" title="Copy value">${item.key}=${esc(item.label)}</button>`).join("")}
        ${run ? `<button class="badge" data-copy="${esc(run.label)}" title="Copy run">run ${run.label}</button>` : ""}
      </div>
      ${
        root.name === root.id
          ? `<h2 class="mono" data-copy="${esc(root.id)}" title="Copy id">${esc(root.id)}</h2>`
          : `<h2>${esc(root.name)}</h2><button class="ident" data-copy="${esc(root.id)}" title="Copy id"><span>id</span><code>${esc(root.id)}</code></button>`
      }
      ${root.description ? `<p class="muted">${esc(root.description)}</p>` : ""}
      <button class="ref" data-copy="${esc(ref)}"><code>${esc(ref)}</code><span>copy</span></button>
    </div>
    <div class="metrics">${metrics.map(([label, value]) => metric(label, value)).join("")}</div>
    <div class="actions">
      <button class="btn primary" data-action="open-sql">Open in SQL</button>
      <button class="btn" data-action="ask-scope">Ask in words</button>
    </div>
    <div class="tabs">${tabs.map((name) => `<button class="${name === tab ? "on" : ""}" data-action="tab" data-tab="${name}">${name[0].toUpperCase() + name.slice(1)}</button>`).join("")}</div>
    <div>${TABS[tab](chain)}</div>`;
}

function layerSummary(layer) {
  const stats = layerStats(layer.id);
  const how = {
    bronze: 'Each pipeline run lands raw parquet. Query a run as <code>bronze."&lt;pipeline&gt;/&lt;job&gt;"</code>. Runs expire after 30 days.',
    silver: 'The silver transform SQL in DS Config renames and casts each bronze row. Query a run as <code>silver."&lt;pipeline&gt;/&lt;job&gt;"</code>.',
    gold: 'Every run merged into one deduplicated dataset. Partition columns are plain columns; filter on them first. Current rows have <code>_valid_to IS NULL</code>.',
  }[layer.id];
  return `<div class="insp-head"><div class="insp-badges"><span class="badge layer">${layer.label}</span></div><h2>${full(stats.count)} ${stats.unit}</h2><p class="muted">${layer.blurb}</p></div>
    <div class="metrics">${stats.facts.map(([label, value]) => metric(label, value)).join("")}</div>
    ${section("How it works", `<p class="muted">${how}</p>`)}`;
}

const TABS = {
  overview(chain) {
    const root = chain[0];
    const next = childColumn(chain);
    const parts = [];
    if (next?.nodes[0]?.kind === "partition") {
      const max = next.nodes[0].share;
      parts.push(
        section(
          `By ${next.title}`,
          `<div class="dist">${next.nodes
            .slice(0, 8)
            .map(
              (item) => `<button class="row" data-action="select" data-depth="${chain.length}" data-id="${esc(item.id)}">
                <span class="row-top"><span class="grow ellipsis">${esc(item.label)}</span><span class="mono muted">${compact(item.rows)}</span></span>
                <span class="bar"><i style="width:${((item.share / max) * 100).toFixed(1)}%"></i></span>
              </button>`,
            )
            .join("")}</div>`,
        ),
      );
    }
    parts.push(section("Insights", insights(chain, root, chain.at(-1)) || '<p class="hint">Nothing flagged.</p>'));
    parts.push(section("Access", `<code class="crn" data-copy="${esc(crn(chain))}">${esc(crn(chain))}</code><p class="muted">Grant this pattern in IAM to share exactly this scope.</p>`));
    return parts.join("");
  },

  schema(chain) {
    const root = chain[0];
    const run = chain.find((node) => node.kind === "run");
    const partitions = new Set(root.partitions);
    const rows = (run ?? root).columns.map(([name, type]) => {
      const tags = [name === root.pk && "pk", partitions.has(name) && "partition", SYSTEM_NAMES.has(name) && "system"].filter(Boolean);
      return `<tr class="${SYSTEM_NAMES.has(name) ? "sys" : ""}"><td data-copy="${esc(name)}"><code>${esc(name)}</code></td><td class="mono muted">${esc(type)}</td><td>${tags.map((tag) => `<span class="badge">${tag}</span>`).join(" ")}</td></tr>`;
    });
    const columns = (run ?? root).columns.map(([name, type]) => [/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`, type]);
    const width = Math.max(...columns.map(([name]) => name.length));
    const ddl = `CREATE TABLE ${sqlRef(chain)} (\n${columns.map(([name, type]) => `  ${name.padEnd(width)} ${type}`).join(",\n")}\n);`;
    return `<div class="tab-actions"><span class="hint">${columns.length} columns</span><button class="btn" data-copy="${esc(ddl)}">Copy schema</button></div>
      <div class="table-wrap"><table><thead><tr><th>Column</th><th>Type</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  },

  preview(chain) {
    const sql = scopeSql(chain).replace(/LIMIT 100$/, "LIMIT 20");
    const entry = lazy(sql, () => query(sql).then((response) => response.body));
    if (entry.status === "loading") return '<p class="hint">Querying the first rows…</p>';
    if (entry.status === "error") return errorNote(entry.error, sql);
    const { columns, rows, row_count, elapsed_ms } = entry.value;
    const nested = state.layer === "bronze" || isNested(columns, rows);
    const as = nested ? state.previewAs ?? "records" : "table";
    return `<div class="tab-actions">${nested ? viewToggle(as, "preview-as") : "<span></span>"}<span class="hint">First ${row_count} rows · ${elapsed_ms} ms</span></div>
      ${as === "records" ? recordsHtml(columns, rows) : resultTable(columns, rows)}`;
  },

  lineage(chain) {
    const root = chain[0];
    const step = (layer, title, subtitle, id) => {
      const current = layer === state.layer && id === root.id;
      const tag = id ? "button" : "div";
      return `<${tag} class="step ${current ? "on" : ""}" ${style(layer)} ${id ? `data-action="goto" data-layer="${layer}" data-id="${id}"` : ""}>
        <span class="dot"></span><span><b>${esc(title)}</b><small>${esc(subtitle)}</small></span>
      </${tag}>`;
    };
    const pipelineIds = state.layer === "gold" ? root.pipelines : [root.id];
    const gold = state.layer === "gold" ? root : root.gold;
    if (!pipelineIds.length && !gold) return '<p class="hint">No pipeline in DS Config links to this data.</p>';
    const steps = [];
    for (const id of pipelineIds) {
      const config = data.silver.find((item) => item.id === id)?.config ?? data.bronze.find((item) => item.id === id)?.config;
      if (config?.bronze_id) steps.push(step("source", "Source dataset", `config dataset ${short(config.bronze_id)}`));
      if (data.bronze.some((item) => item.id === id)) steps.push(step("bronze", "Bronze runs", `pipeline ${short(id)}`, id));
      if (data.silver.some((item) => item.id === id)) steps.push(step("silver", config?.name ?? "Silver runs", "transform in DS Config", id));
    }
    if (gold) steps.push(step("gold", gold.name, `gold."${short(gold.id)}…" · ${gold.history}`, gold.id));
    return `<div class="lineage">${steps.join('<div class="step-line"></div>')}</div>`;
  },

  transform(chain) {
    const root = chain[0];
    const config = root.config ?? data.silver.find((item) => root.pipelines?.includes(item.id))?.config;
    if (!config?.transform) return '<p class="hint">No transform in DS Config.</p>';
    return `${section("transform.sql_query", `<pre class="code">${highlight(config.transform.sql_query.replace(/, /g, ",\n  ").replace(/ FROM /i, "\nFROM ").replace(/ WHERE /i, "\nWHERE "))}</pre>`)}
      ${section("non_null_columns", `<code>${esc(config.transform.non_null_columns.join(", ") || "none")}</code>`)}
      <p class="muted" style="margin-top:12px">Pipeline ${esc(config.name)} (${short(config.id)}) in DS Config.</p>`;
  },
};

function insights(chain, root, node) {
  const notes = [];
  if (state.layer === "gold") {
    const average = root.bytes / root.files;
    if (root.files > 1 && average < 32 * 2 ** 20) notes.push(["warn", `Files average ${size(average)}. Compacting to 128–512 MB keeps queries inside latency targets.`]);
    if (root.history === "scd2") notes.push(["", "Keeps every version of a row. Current rows: <code>_valid_to IS NULL</code>."]);
    const depth = scopeOf(chain).length;
    if (depth < root.partitions.length) notes.push(["", `Filter on <code>${esc(root.partitions[depth])}</code> to skip files before any read.`]);
    if (!root.partitions.length) notes.push(["warn", "No partitions. Every query reads every file."]);
    if (!root.named) notes.push(["", "No business name in DS Config. text_to_sql only sees the UUID."]);
    if (root.columns.length > 60) notes.push(["", `${root.columns.length} columns. text_to_sql sees at most 60 of them.`]);
  } else {
    notes.push(["", "Runs are snapshots or increments and expire after 30 days. Query gold for history."]);
    if (!root.config) notes.push(["warn", "Pipeline not found in DS Config."]);
  }
  return notes.map(([level, text]) => `<p class="insight ${level}"><span>${text}</span></p>`).join("");
}

const NESTED_TYPE = /STRUCT|MAP|UNION|JSON|\[\]/i;
const decode = (value) => {
  if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const isNested = (columns, rows) => columns.some((column) => NESTED_TYPE.test(column.type)) || rows.some((row) => row.some((value) => typeof decode(value) === "object" && value !== null));

function jsonHtml(value) {
  return JSON.stringify(value, null, 2).replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (match, text, colon, literal, number) =>
    text ? `<span class="${colon ? "t-k" : "t-s"}">${esc(text)}</span>${colon ?? ""}` : `<span class="${literal ? "t-k" : "t-n"}">${match}</span>`,
  );
}

function recordsHtml(columns, rows) {
  return `<div class="records">${rows
    .map((row, index) => {
      const record = Object.fromEntries(columns.map((column, position) => [column.name, decode(row[position])]));
      const json = JSON.stringify(record, null, 2);
      return `<details class="record" ${index < 3 ? "open" : ""}>
        <summary><span class="mono muted">#${index + 1}</span><span class="grow ellipsis mono">${esc(JSON.stringify(record))}</span><button class="add" data-copy="${esc(json)}">copy</button></summary>
        <pre class="code">${jsonHtml(record)}</pre>
      </details>`;
    })
    .join("")}</div>`;
}

const viewToggle = (current, action) =>
  `<div class="tabs" style="border:0">${["records", "table"].map((name) => `<button class="${name === current ? "on" : ""}" data-action="${action}" data-tab="${name}">${name[0].toUpperCase() + name.slice(1)}</button>`).join("")}</div>`;

function resultTable(columns, rows) {
  const numeric = (type) => /INT|DECIMAL|DOUBLE|FLOAT/.test(type);
  const cell = (value, type) => {
    if (value === null) return '<td><span class="null">null</span></td>';
    const owner = typeof value === "string" && ownerName(value);
    if (owner) return `<td data-copy="${esc(value)}"><code>${short(value)}…</code> <span class="muted">${esc(owner)}</span></td>`;
    const text = esc(typeof value === "object" ? JSON.stringify(value) : value);
    return `<td class="${numeric(type) ? "num" : ""}" data-copy="${text}">${text}</td>`;
  };
  return `<div class="table-wrap"><table>
    <thead><tr>${columns.map((column) => `<th>${esc(column.name)}<small>${esc(column.type)}</small></th>`).join("")}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${row.map((value, index) => cell(value, columns[index].type)).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

/* ---------- query ---------- */

// DuckDB, the dialect ds-fetch executes: its clauses (QUALIFY, EXCLUDE, PIVOT, ASOF …), types and common functions.
const KEYWORDS = new Set(
  `SELECT FROM WHERE AND OR NOT GROUP BY ORDER LIMIT OFFSET AS IS NULL TRUE FALSE JOIN LEFT RIGHT FULL INNER OUTER CROSS SEMI ANTI ASOF POSITIONAL NATURAL LATERAL ON USING
  WITH RECURSIVE DESC ASC NULLS FIRST LAST HAVING QUALIFY WINDOW OVER PARTITION ROWS RANGE GROUPS PRECEDING FOLLOWING UNBOUNDED CURRENT ROW FILTER
  CASE WHEN THEN ELSE END IN LIKE ILIKE GLOB SIMILAR BETWEEN EXISTS ANY ALL SOME DISTINCT UNION INTERSECT EXCEPT BY NAME EXCLUDE REPLACE COLUMNS
  PIVOT UNPIVOT SUMMARIZE DESCRIBE SAMPLE TABLESAMPLE CAST TRY_CAST INTERVAL AT TIME ZONE
  VARCHAR TEXT STRING INTEGER INT BIGINT HUGEINT SMALLINT TINYINT UBIGINT UINTEGER DOUBLE FLOAT REAL DECIMAL NUMERIC BOOLEAN BOOL DATE TIMESTAMP TIMESTAMPTZ BLOB UUID JSON STRUCT LIST MAP UNION`.split(/\s+/),
);
const FUNCTIONS = new Set(
  `count count_star sum avg mean min max median mode quantile quantile_cont approx_count_distinct approx_quantile stddev variance arg_max arg_min any_value first last
  string_agg list array_agg histogram bool_and bool_or round floor ceil abs ln log greatest least coalesce nullif ifnull
  date_trunc date_part date_diff datediff date_add strftime strptime epoch epoch_ms make_date make_timestamp now current_date today age last_day dayname monthname year month day hour
  lower upper trim length concat concat_ws split_part string_split regexp_matches regexp_extract regexp_replace contains starts_with ends_with replace substr substring left right lpad rpad format printf md5 hash
  unnest generate_series range list_value list_extract list_contains list_filter list_transform list_aggregate len flatten struct_pack struct_extract map_extract
  json_extract json_extract_string json_value json_keys json_array_length json_type to_json from_json read_json read_csv read_parquet row_number rank dense_rank ntile lag lead first_value last_value cume_dist percent_rank`.split(/\s+/),
);
const TOKEN = /(--[^\n]*)|('(?:[^']|'')*')|("[^"]*")|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)\b/g;

function highlight(sql) {
  let out = "";
  let last = 0;
  for (const match of sql.matchAll(TOKEN)) {
    const [text, comment, string, identifier, number, word] = match;
    const kind = comment ? "c" : string ? "s" : identifier ? "i" : number ? "n" : KEYWORDS.has(word.toUpperCase()) ? "k" : FUNCTIONS.has(word.toLowerCase()) ? "f" : "";
    out += esc(sql.slice(last, match.index)) + (kind ? `<span class="t-${kind}">${esc(text)}</span>` : esc(text));
    last = match.index + text.length;
  }
  return `${out}${esc(sql.slice(last))}\n`;
}

function localHints(sql, datasets) {
  const where = sql.split(/\bwhere\b/i)[1] ?? "";
  return datasets.flatMap((dataset) => [
    dataset.history === "scd2" && !/_valid_to\s+is\s+null/i.test(sql) && { text: `${dataset.name} keeps history. Add _valid_to IS NULL for current rows`, fix: true },
    dataset.partitions[0] && !new RegExp(`\\b${dataset.partitions[0]}\\b`).test(where) && { text: `No ${dataset.partitions[0]} filter, scans ${size(dataset.bytes)}` },
  ]).filter(Boolean);
}

let validateTimer;
let validateSeq = 0;
function scheduleValidate() {
  clearTimeout(validateTimer);
  const sql = state.query.sql;
  if (!sql.trim()) return refresh("validate", '<span class="hint">Write SQL, pick a dataset on the left, or ask in words.</span>');
  refresh("validate", '<span class="hint">Checking…</span>');
  validateTimer = setTimeout(async () => {
    const seq = ++validateSeq;
    let html;
    try {
      const { body } = await api("/api/fetch/query/validate/", { method: "POST", body: { sql } });
      const datasets = body.datasets.map((name) => data.gold.find((item) => item.fetchName === name)).filter(Boolean);
      const names = body.datasets.map((name) => esc(data.gold.find((item) => item.fetchName === name)?.name ?? name)).join(", ");
      html = `<span class="v ok">Binds</span><span class="hint">reads ${names} · ${body.columns.length} columns</span>${localHints(sql, datasets)
        .map((hint) => `<span class="v warn">${esc(hint.text)}${hint.fix ? ' <button data-action="fix-history">fix</button>' : ""}</span>`)
        .join("")}`;
    } catch (error) {
      html = `<span class="v err">${esc(error.code)}</span><span class="hint">${esc(error.message)}</span>`;
    }
    if (seq === validateSeq) refresh("validate", html);
  }, 400);
}

function queryView() {
  return `<section class="query">
    <aside class="q-side">
      ${resizer}
      <input id="q-filter" class="input" placeholder="Find dataset or column" autocomplete="off" />
      <div id="q-tree" class="tree">${treeHtml("")}</div>
    </aside>
    <div class="q-main">
      <form id="ask-form" class="ask">
        <span class="ask-icon">✦</span>
        <input id="ask-input" placeholder="Ask in words. We draft the SQL, you review it before anything runs." value="${esc(state.query.question)}" autocomplete="off" />
        <button class="btn" type="submit">Draft SQL</button>
      </form>
      <div id="ask-context" class="ask-context">${askContextHtml()}</div>
      <div id="ask-note">${askNote()}</div>
      <div class="editor"><pre id="hl" aria-hidden="true"></pre><textarea id="sql" spellcheck="false" placeholder="SELECT … (DuckDB SQL)"></textarea><span class="editor-dialect">DuckDB</span><button class="editor-copy" data-action="copy-sql" title="Copy SQL">copy</button></div>
      <div class="q-bar">
        <span id="validate" class="q-bar"></span><span class="grow"></span>
        <span id="file-bar" class="q-bar">${fileBarHtml()}</span>
        <button class="btn primary" data-action="run">Run <kbd>⌘↵</kbd></button>
      </div>
      <div id="result" class="result">${resultHtml()}</div>
    </div>
    <aside class="q-right">
      <h3>Projects</h3><div id="projects">${projectsHtml()}</div>
      <h3>History</h3><div id="history">${historyHtml()}</div>
    </aside>
  </section>`;
}

function treeHtml(filter) {
  const needle = filter.trim().toLowerCase();
  const items = [...data.gold]
    .sort(SORTS.rows)
    .filter((item) => !needle || item.name.toLowerCase().includes(needle) || item.id.startsWith(needle) || item.columns.some(([name]) => name.toLowerCase().includes(needle)))
    .slice(0, 60);
  return (
    items
      .map(
        (item) => `<details ${needle && !item.name.toLowerCase().includes(needle) ? "open" : ""}>
          <summary ${style("gold")}><span class="dot"></span><span class="grow ellipsis">${esc(item.name)}</span><button class="add ${state.query.context.includes(item.fetchName) ? "on" : ""}" data-action="pin" data-name="${esc(item.fetchName)}" title="Use as context for Draft SQL">${state.query.context.includes(item.fetchName) ? "✓ ask" : "+ ask"}</button><button class="add" data-copy="${esc(`gold."${item.id}"`)}" title="Copy reference">copy</button><button class="add" data-action="insert" data-text="${esc(`gold."${item.id}"`)}" title="Insert at cursor">+ ref</button></summary>
          <div class="cols">${item.columns
            .filter(([name]) => !SYSTEM_NAMES.has(name) || name === "_valid_to")
            .map(([name, type]) => `<button data-action="insert" data-text="${esc(name)}"><span>${esc(name)}</span><small>${esc(type)}</small></button>`)
            .join("")}</div>
        </details>`,
      )
      .join("") || `<p class="empty">${data.status === "ready" ? "No gold datasets" : "Loading…"}</p>`
  );
}

function askNote() {
  const ask = state.query.ask;
  if (!ask) return "";
  const over = `over ${ask.datasets.map(datasetLabel).map(esc).join(", ")}`;
  if (ask.status === "pending") return `<p class="hint">Drafting SQL ${over}…</p>`;
  if (ask.status === "refused") return `<div class="note warn"><div class="note-head"><b>Not drafted · ${esc(ask.kind)}</b><button class="add" data-copy="${esc(ask.detail)}">copy</button></div><pre class="note-text">${esc(ask.message)}</pre><p class="hint">Asked ${over}.</p></div>`;
  return `<p class="hint">✦ Drafted from “${esc(ask.question)}” ${over}. Check the dataset, filters and grouping, then run.</p>`;
}

const MESSAGE_LIMIT = 200;
const messages = [];
const messageText = (entry) => `${entry.at.toISOString()} ${entry.level.toUpperCase()} ${entry.title}${entry.detail ? `\n${entry.detail}` : ""}`;

// Errors already shown inline (run, draft) or from background saves pass toast = false.
function log(level, title, detail = "", toast = level === "error") {
  messages.unshift({ at: new Date(), level, title, detail });
  messages.length = Math.min(messages.length, MESSAGE_LIMIT);
  if (toast) notify(title, true);
  if (state.view === "query") refresh("result", resultHtml());
}

function messagesHtml() {
  if (!messages.length) return '<p class="empty">Runs, drafts, saves and errors are logged here for this session.</p>';
  return `<div class="tab-actions"><span class="hint">${messages.length} messages, newest first</span><span><button class="btn" data-copy="${esc(messages.map(messageText).join("\n\n"))}">Copy all</button> <button class="btn" data-action="clear-messages">Clear</button></span></div>
    <div class="messages">${messages
      .map((entry) => `<div class="msg ${entry.level}"><div class="msg-head"><span class="mono muted">${entry.at.toLocaleTimeString()}</span><b class="grow">${esc(entry.title)}</b><button class="add" data-copy="${esc(messageText(entry))}">copy</button></div>${entry.detail ? `<pre class="note-text">${esc(entry.detail)}</pre>` : ""}</div>`)
      .join("")}</div>`;
}

function resultHtml() {
  const result = state.query.result;
  const ok = Boolean(result?.columns);
  const chartable = ok && result.columns.length === 2 && /INT|DECIMAL|DOUBLE|FLOAT/.test(result.columns[1].type) && result.rows.length > 1;
  const tabs = ok ? ["table", ...(isNested(result.columns, result.rows.slice(0, 50)) ? ["records"] : []), ...(chartable ? ["chart"] : []), "messages"] : ["result", "messages"];
  const tab = tabs.includes(state.query.resultTab) ? state.query.resultTab : tabs[0];
  const errors = messages.filter((entry) => entry.level === "error").length;
  const label = (name) => (name === "messages" && messages.length ? `Messages <small class="${errors ? "count err" : "count"}">${messages.length}</small>` : name[0].toUpperCase() + name.slice(1));
  const head = `<div class="result-head">
    <div class="tabs" style="border:0">${tabs.map((name) => `<button class="${name === tab ? "on" : ""}" data-action="result-tab" data-tab="${name}">${label(name)}</button>`).join("")}</div>
    <span class="grow"></span>
    ${ok && tab !== "messages" ? `<span class="hint mono">${full(result.row_count)} rows · ${result.elapsed_ms} ms · cache ${esc(result.cache)}${result.truncated ? " · truncated" : ""}</span>
    <button class="btn subtle" data-action="pins" title="Plot this statement with ds-tools: X × Y as a bed of pins, Z as height, time as a movie">Pins</button>
    <button class="btn" data-action="csv">CSV</button>` : ""}
  </div>`;
  if (tab === "messages") return head + messagesHtml();
  if (!result) return `${head}<p class="empty">Results appear here. Inline up to 100,000 rows or 8 MiB and 25 s.</p>`;
  if (result.status === "running") return `${head}<p class="empty">Running…</p>`;
  if (result.error) return head + errorNote(result.error, result.sql);
  if (tab === "chart") {
    const rows = result.rows.slice(0, 30);
    const max = Math.max(...rows.map((row) => Number(row[1])));
    return `${head}<div class="chart">${rows
      .map((row) => `<div class="chart-row"><span class="ellipsis">${esc(ownerName(row[0]) ?? row[0] ?? "null")}</span><i style="width:${(Number(row[1]) / max) * 100}%"></i><span>${compact(Number(row[1]))}</span></div>`)
      .join("")}</div>`;
  }
  if (tab === "records") {
    const shown = result.rows.slice(0, 200);
    return `${head}<div class="table-wrap">${recordsHtml(result.columns, shown)}${shown.length < result.rows.length ? `<p class="hint">First ${shown.length} records. Use Table or CSV for all ${full(result.rows.length)}.</p>` : ""}</div>`;
  }
  return head + resultTable(result.columns, result.rows);
}

function fileBarHtml() {
  return `<input id="file-path" class="input file-path" placeholder="project/query-name" value="${esc(state.query.path)}" autocomplete="off" ${workspace.status === "ready" ? "" : "disabled"} />
    <button class="btn" data-action="save" ${workspace.status === "ready" ? "" : "disabled"}>Save <kbd>⌘S</kbd></button>`;
}

function projectsHtml() {
  if (workspace.status === "loading") return '<p class="hint">Loading your workspace…</p>';
  if (workspace.status === "error") return `<p class="hint">State unavailable: ${esc(workspace.error)}</p>`;
  if (!workspace.files.length) return '<p class="hint">Save a query as <code>project/name</code> to start a project.</p>';
  const projects = [...Map.groupBy(workspace.files, (file) => file.path.split("/")[0])].sort(([left], [right]) => left.localeCompare(right));
  return projects
    .map(
      ([project, files]) => `<details class="project" open>
        <summary><span class="grow ellipsis">${esc(project)}</span><small>${files.length}</small></summary>
        ${files
          .sort((left, right) => left.path.localeCompare(right.path))
          .map(
            (file) => `<div class="file ${file.path === state.query.path ? "on" : ""}">
              <button class="grow ellipsis" data-action="open-file" data-path="${esc(file.path)}" title="${esc(file.path)}">${esc(file.path.slice(project.length + 1))}</button>
              <button class="del" data-action="delete-file" data-path="${esc(file.path)}" aria-label="Delete ${esc(file.path)}">×</button>
            </div>`,
          )
          .join("")}
      </details>`,
    )
    .join("");
}

function historyHtml() {
  if (!state.query.history.length) return '<p class="hint">Your runs are kept here and in State.</p>';
  return state.query.history
    .map((entry, index) => `<button class="item" data-action="restore" data-index="${index}"><code class="ellipsis">${esc(entry.sql.replace(/\s+/g, " "))}</code><span class="muted mono">${entry.summary}</span></button>`)
    .join("");
}

function mountEditor() {
  const area = document.getElementById("sql");
  const overlay = document.getElementById("hl");
  area.value = state.query.sql;
  area.addEventListener("scroll", () => {
    overlay.scrollTop = area.scrollTop;
  });
  syncEditor();
}

function syncEditor() {
  refresh("hl", highlight(state.query.sql));
  scheduleValidate();
  scheduleSessionSave();
}

function setSql(sql) {
  state.query.sql = sql;
  const area = document.getElementById("sql");
  if (area) area.value = sql;
  syncEditor();
}

function insertText(text) {
  const area = document.getElementById("sql");
  area.setRangeText(text, area.selectionStart, area.selectionEnd, "end");
  area.focus();
  setSql(area.value);
}

async function runQuery() {
  const sql = state.query.sql.trim();
  if (!sql || state.query.result?.status === "running") return;
  state.query.result = { status: "running" };
  state.query.resultTab = "table";
  refresh("result", resultHtml());
  let summary;
  try {
    const { body, headers } = await query(sql);
    state.query.result = { ...body, sql, cache: headers.get("x-cache") ?? "—" };
    summary = `${full(body.row_count)} rows · ${body.elapsed_ms} ms`;
    log("info", `Ran · ${summary}`, sql);
  } catch (error) {
    state.query.result = { error, sql };
    summary = `failed · ${error.code}`;
    log("error", `Run failed · ${error.code}: ${error.message}`, errorText(error, sql), false);
  }
  refresh("result", resultHtml());
  recordHistory(sql, summary);
}

function downloadCsv() {
  const { columns, rows, truncated } = state.query.result;
  const cell = (value) => {
    if (value == null) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const csv = [columns.map((column) => cell(column.name)), ...rows.map((row) => row.map(cell))].map((line) => line.join(",")).join("\r\n");
  const link = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
    download: `${(state.query.path || "query").replaceAll("/", "-")}.csv`,
  });
  link.click();
  URL.revokeObjectURL(link.href);
  notify(truncated ? `Downloaded ${full(rows.length)} rows. The result was truncated at the inline limit.` : `Downloaded ${full(rows.length)} rows`);
}

/* ---------- workspace: per-user SQL in ds-state under /lakehouse/<user>/ ---------- */

const workspace = { status: "loading", error: "", files: [], ids: new Map(), sessionSaved: "" };
const HISTORY_LIMIT = 50;

const identity = () =>
  data.user
    .trim()
    .toLowerCase()
    .replace("@", "_at_")
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
const stateKey = (path) => `/lakehouse/${identity()}/${path}`;
const fileKey = (path) => `projects/${path}.sql`;
const normalizePath = (input) => {
  const parts = input.trim().replace(/\.sql$/i, "").split("/").map((part) => part.trim().replace(/[^\w.-]+/g, "-")).filter(Boolean);
  return parts.length > 1 ? parts.join("/") : parts.length ? `scratch/${parts[0]}` : "";
};

let stateQueue = Promise.resolve();
const enqueue = (task) => (stateQueue = stateQueue.catch(() => {}).then(task));

async function putState(path, value, dataType) {
  const key = stateKey(path);
  const body = { key, value, data_type: dataType, description: "", metadata: {}, tags: { app: "lakehouse" }, owner_id: null, status: "active", ttl_seconds: 0, version: "v1", acl: { owners: [], viewers: [] } };
  let id = workspace.ids.get(key);
  if (!id) {
    try {
      const { body: created } = await api("/api/state/state/", { method: "POST", body });
      workspace.ids.set(key, created.id);
      return created;
    } catch (error) {
      if (error.status !== 409) throw error;
      const { body: found } = await api(`/api/state/state/?limit=10&key_prefix=${encodeURIComponent(key)}`);
      id = found.data.find((item) => item.key === key)?.id;
      if (!id) throw error;
    }
  }
  const { body: saved } = await api(`/api/state/state/${id}/`, { method: "PUT", body });
  workspace.ids.set(key, saved.id);
  return saved;
}

async function loadWorkspace() {
  try {
    const root = stateKey("");
    const { items } = await pages(`/api/state/state/?status=active&order_by=-modified_at&key_prefix=${encodeURIComponent(root)}`);
    const byPath = new Map(items.map((item) => [item.key.slice(root.length), item]));
    items.forEach((item) => workspace.ids.set(item.key, item.id));
    workspace.files = [...byPath]
      .filter(([path]) => path.startsWith("projects/") && path.endsWith(".sql"))
      .map(([path, item]) => ({ path: path.slice("projects/".length, -".sql".length), sql: item.value }));
    state.query.history = JSON.parse(byPath.get("history.json")?.value || "[]");
    workspace.sessionSaved = byPath.get("session.sql")?.value ?? "";
    if (!state.query.sql) setSql(workspace.sessionSaved);
    workspace.status = "ready";
  } catch (error) {
    Object.assign(workspace, { status: "error", error: error.message });
  }
  refresh("file-bar", fileBarHtml());
  refresh("projects", projectsHtml());
  refresh("history", historyHtml());
}

let sessionTimer;
function scheduleSessionSave() {
  if (workspace.status !== "ready" || !state.query.sql.trim() || state.query.sql === workspace.sessionSaved) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const sql = state.query.sql;
    enqueue(() => putState("session.sql", sql, "string")).then(
      () => (workspace.sessionSaved = sql),
      (error) => log("error", `Session not saved: ${error.message}`, errorText(error), false),
    );
  }, 1500);
}

function recordHistory(sql, summary) {
  state.query.history = [{ sql, summary, at: new Date().toISOString() }, ...state.query.history].slice(0, HISTORY_LIMIT);
  refresh("history", historyHtml());
  if (workspace.status === "ready") enqueue(() => putState("history.json", JSON.stringify(state.query.history), "array")).catch((error) => log("error", `History not saved: ${error.message}`, errorText(error), false));
}

async function saveFile() {
  const path = normalizePath(document.getElementById("file-path")?.value || state.query.path || "untitled");
  if (!state.query.sql.trim() || workspace.status !== "ready") return;
  const sql = state.query.sql;
  try {
    await enqueue(() => putState(fileKey(path), sql, "string"));
    workspace.files = [{ path, sql }, ...workspace.files.filter((file) => file.path !== path)];
    state.query.path = path;
    notify(`Saved ${path}`);
    log("info", `Saved ${path}`);
  } catch (error) {
    log("error", `Save failed: ${error.message}`, errorText(error, sql));
  }
  refresh("file-bar", fileBarHtml());
  refresh("projects", projectsHtml());
}

function openFile(path) {
  const file = workspace.files.find((item) => item.path === path);
  state.query.path = path;
  setSql(file.sql);
  refresh("file-bar", fileBarHtml());
  refresh("projects", projectsHtml());
}

async function deleteFile(path) {
  if (!confirm(`Delete ${path}?`)) return;
  const key = stateKey(fileKey(path));
  try {
    await enqueue(() => api(`/api/state/state/${workspace.ids.get(key)}/`, { method: "DELETE" }));
    workspace.ids.delete(key);
    workspace.files = workspace.files.filter((file) => file.path !== path);
  } catch (error) {
    log("error", `Delete failed: ${error.message}`, errorText(error));
  }
  refresh("projects", projectsHtml());
}

// text_to_sql takes at most 10 dataset names and reads their schemas itself. Unscoped, it
// enumerates whatever Fetch lists first, which is mostly runs, so a scope is always sent.
const ASK_LIMIT = 10;

// The datasets a statement reads, as [layer, id]: layer."id", the only form an id with - or / can take.
const references = (sql) => [...new Map([...sql.matchAll(/\b(gold|silver|bronze)\s*\.\s*"([^"]+)"/gi)].map(([, layer, id]) => [`${layer.toLowerCase()}.${id}`, [layer.toLowerCase(), id]])).values()];

function askDatasets(question) {
  if (state.query.context.length) return state.query.context;
  const referenced = references(state.query.sql).map(([layer, id]) => `${layer}.${id}`);
  if (referenced.length) return referenced.slice(0, ASK_LIMIT);
  const words = question.toLowerCase().match(/[\p{L}\d_]{3,}/gu) ?? [];
  const score = (item) =>
    words.reduce(
      (total, word) => total + (item.name.toLowerCase().includes(word) ? 3 : 0) + (item.description.toLowerCase().includes(word) ? 2 : 0) + item.columns.filter(([name]) => name.toLowerCase().includes(word)).length,
      0,
    );
  return data.gold
    .map((item) => [score(item), item])
    .sort(([left, a], [right, b]) => right - left || (b.rows ?? 0) - (a.rows ?? 0))
    .slice(0, ASK_LIMIT)
    .map(([, item]) => item.fetchName);
}

function datasetLabel(fetchName) {
  const [layer, id] = [fetchName.slice(0, fetchName.indexOf(".")), fetchName.slice(fetchName.indexOf(".") + 1)];
  if (layer === "gold") return data.goldById.get(id)?.name ?? id;
  const [pipeline, job] = id.split("/");
  return `${layer} ${data[layer]?.find((item) => item.id === pipeline)?.name ?? short(pipeline)} / ${short(job)}`;
}

function toggleContext(fetchName) {
  const context = state.query.context;
  state.query.context = context.includes(fetchName) ? context.filter((name) => name !== fetchName) : [...context, fetchName].slice(-ASK_LIMIT);
  refresh("ask-context", askContextHtml());
  refresh("q-tree", treeHtml(document.getElementById("q-filter")?.value ?? ""));
}

function askContextHtml() {
  const pinned = state.query.context;
  if (!pinned.length) return '<span class="hint">Context: datasets in your SQL, otherwise the 10 gold datasets that best match the question. Pin with <b>+ ask</b>.</span>';
  return `<span class="hint">Context</span>${pinned.map((name) => `<span class="chip on" title="${esc(name)}">${esc(datasetLabel(name))} <button type="button" data-action="unpin" data-name="${esc(name)}" aria-label="Remove">×</button></span>`).join("")}`;
}

async function ask(question) {
  if (!question.trim()) return;
  const datasets = askDatasets(question);
  if (!datasets.length) return notify("No datasets to ask about yet.");
  state.query.question = question;
  state.query.ask = { status: "pending", question, datasets };
  refresh("ask-note", askNote());
  try {
    const { body } = await api("/api/tools/tools/text_to_sql/invoke/", {
      method: "POST",
      body: { tool_use_id: crypto.randomUUID(), input: { question, datasets }, timeout_ms: 45000 },
    });
    state.query.ask = { status: "draft", question, datasets };
    setSql(body.output.trim());
    log("info", `Drafted “${question}”`, `datasets: ${datasets.join(", ")}\n\n${body.output.trim()}`);
  } catch (error) {
    const detail = `${errorText(error)}\n\nquestion: ${question}\ndatasets: ${datasets.join(", ")}`;
    state.query.ask = { status: "refused", kind: error.code, message: error.message, detail, question, datasets };
    log("error", `Draft failed · ${error.code}: ${error.message}`, detail, false);
  }
  refresh("ask-note", askNote());
}

/* ---------- plot: the statement becomes a visual in ds-tools, drawn by Pins ---------- */

const invoke = async (tool, input) =>
  (await api(`/api/tools/tools/${tool}/invoke/`, { method: "POST", body: { tool_use_id: crypto.randomUUID(), input, timeout_ms: 45000 } })).body.output;

const quoteName = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`);

// The first call is a guess from the result's columns; the overlay edits it from there.
function firstPlot({ columns }) {
  const numeric = columns.filter((column) => /INT|DECIMAL|DOUBLE|FLOAT|REAL|NUMERIC/i.test(column.type));
  const temporal = columns.find((column) => /DATE|TIME/i.test(column.type));
  const labels = columns.filter((column) => !numeric.includes(column) && column !== temporal);
  const x = labels[0] ?? temporal ?? columns[0];
  const [y, z] = [labels[1], numeric.filter((column) => column !== x).at(-1)];
  return { x: quoteName(x.name), ...(y && { y: quoteName(y.name) }), ...(temporal && temporal !== x && { t: quoteName(temporal.name) }), z: z ? `sum(${quoteName(z.name)})` : "count(*)" };
}

async function plot(sql, args) {
  const output = JSON.parse(await invoke("plot", { sql, paths: references(sql).map(([layer, id]) => `/datasets/${layer}/${id}`), ...args }));
  const { body: visual } = await api(`/api/file/file/${output.visual.split("/").pop()}/content/`);
  return { visual, text: output.text, path: output.visual };
}

async function openPlot() {
  const { sql } = state.query.result;
  try {
    Pins.open({
      ...(await plot(sql, firstPlot(state.query.result))),
      title: state.query.path || "Query result",
      edit: (args) => plot(sql, args),
      ask: (path, question) => invoke("inspect", { path, question }),
    });
  } catch (error) {
    log("error", `Plot failed · ${error.code}: ${error.message}`, errorText(error, sql));
  }
}

function fixHistory() {
  const sql = state.query.sql;
  const fixed = /\bwhere\b/i.test(sql)
    ? sql.replace(/\bwhere\b/i, "WHERE _valid_to IS NULL\n  AND")
    : sql.replace(/(\n?)(GROUP BY|ORDER BY|LIMIT|$)/i, (_, newline, clause) => `\nWHERE _valid_to IS NULL${clause ? `\n${clause}` : ""}`);
  setSql(fixed);
}

/* ---------- command palette ---------- */

const paletteElement = document.getElementById("palette");
const palette = { index: 0, results: [] };

function openPalette() {
  paletteElement.hidden = false;
  paletteElement.innerHTML = `<div class="pal-box">
    <input id="pal-input" class="pal-input" placeholder="Search gold datasets and pipelines by name, id or column" autocomplete="off" />
    <div id="pal-list" class="pal-list"></div>
    <footer class="pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></footer>
  </div>`;
  palette.index = 0;
  document.getElementById("pal-input").focus();
  renderPalette("");
}

function matchReason(item, needle) {
  if (!needle) return itemMeta(item);
  if (item.name.toLowerCase().includes(needle)) return "name";
  if (item.id.startsWith(needle)) return `id ${short(item.id)}`;
  const column = item.columns.find(([name]) => name.toLowerCase().includes(needle));
  return column ? `column ${column[0]}` : null;
}

function renderPalette(text) {
  const needle = text.trim().toLowerCase();
  palette.results = [...data.gold, ...data.silver, ...data.bronze]
    .map((item) => ({ item, reason: matchReason(item, needle) }))
    .filter((entry) => entry.reason !== null)
    .slice(0, 12);
  refresh(
    "pal-list",
    palette.results
      .map(
        ({ item, reason }, index) => `<button class="pal-row ${index === palette.index ? "on" : ""}" data-action="pick" data-layer="${item.layer}" data-id="${item.id}" ${style(item.layer)}>
          <span class="dot"></span><span class="grow ellipsis">${esc(item.name)}</span><span class="badge">${item.layer}</span><span class="muted mono">${esc(reason)}</span>
        </button>`,
      )
      .join("") || `<p class="empty">${data.status === "ready" ? "No match" : "Loading…"}</p>`,
  );
}

function closePalette() {
  paletteElement.hidden = true;
}

/* ---------- wiring ---------- */

const main = document.getElementById("main");

const loginView = () => `<form id="login-form" class="login">
  <h1>Sign in</h1>
  <p class="muted">AI Commons identity · ${esc(data.env)}</p>
  <input class="input" name="email" type="email" autocomplete="username" placeholder="Email" required autofocus />
  <input class="input" name="password" type="password" autocomplete="current-password" placeholder="Password" required />
  ${data.error ? `<p class="v err">${esc(data.error.message)}</p>` : ""}
  <button class="btn primary">Sign in</button>
</form>`;

async function start() {
  const { body } = await api("/session");
  Object.assign(data, { env: body.env, user: body.user, status: body.user ? "loading" : "signed-out" });
  render();
  if (!data.user) return;
  load();
  loadWorkspace();
}

async function login(form) {
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const { body } = await api("/auth/login", { method: "POST", body: { email: form.email.value, password: form.password.value } });
    Object.assign(data, { user: body.user, status: "loading", error: null });
    render();
    load();
    loadWorkspace();
  } catch (error) {
    data.error = error;
    render();
  }
}

function render() {
  document.querySelectorAll("[data-view]").forEach((element) => element.classList.toggle("on", element.dataset.view === state.view));
  refresh("env", esc(data.env || "…"));
  refresh("user", data.user ? `${esc(data.user)} <button class="btn" data-action="logout">Sign out</button>` : "");
  if (data.status === "signed-out") return void (main.innerHTML = loginView());
  main.innerHTML = { overview: overviewView, explore: exploreView, query: queryView }[state.view]();
  if (state.view === "query") mountEditor();
  const miller = main.querySelector(".miller");
  if (miller) miller.scrollLeft = miller.scrollWidth;
}

function go(patch) {
  Object.assign(state, patch);
  render();
}

const enterLayer = (layer) => ({ view: "explore", layer, laneQuery: "", laneOwner: "", laneSort: layer === "gold" ? "rows" : "runs" });
const explore = (layer, id) => go({ ...enterLayer(layer), path: [id], tab: "overview" });

const ACTIONS = {
  view: (element) => go({ view: element.dataset.view }),
  layer: (element) => go({ ...enterLayer(element.dataset.layer || null), path: [] }),
  select: (element) => go({ path: [...state.path.slice(0, Number(element.dataset.depth)), element.dataset.id] }),
  crumb: (element) => go({ path: state.path.slice(0, Number(element.dataset.depth)) }),
  tab: (element) => {
    state.tab = element.dataset.tab;
    render();
  },
  goto: (element) => explore(element.dataset.layer, element.dataset.id),
  owner: (element) => {
    state.laneOwner = state.laneOwner === element.dataset.owner ? "" : element.dataset.owner;
    render();
  },
  "open-sql": () => {
    Object.assign(state.query, { sql: scopeSql(resolveChain()), path: "", ask: null, result: null });
    go({ view: "query" });
  },
  "ask-scope": () => {
    const chain = resolveChain();
    const root = chain[0];
    const run = chain.find((node) => node.kind === "run") ?? root.runs?.[0];
    state.query.context = [state.layer === "gold" ? root.fetchName : `${state.layer}.${root.id}/${run.id}`];
    go({ view: "query" });
    document.getElementById("ask-input").focus();
  },
  pin: (element, event) => {
    event.preventDefault();
    toggleContext(element.dataset.name);
  },
  unpin: (element) => toggleContext(element.dataset.name),
  run: runQuery,
  csv: downloadCsv,
  pins: openPlot,
  save: saveFile,
  "open-file": (element) => openFile(element.dataset.path),
  "delete-file": (element) => deleteFile(element.dataset.path),
  insert: (element, event) => {
    event.preventDefault();
    insertText(element.dataset.text);
  },
  "fix-history": fixHistory,
  "result-tab": (element) => {
    state.query.resultTab = element.dataset.tab;
    refresh("result", resultHtml());
  },
  "preview-as": (element) => {
    state.previewAs = element.dataset.tab;
    render();
  },
  "clear-messages": () => {
    messages.length = 0;
    refresh("result", resultHtml());
  },
  dismiss: () => (toast.hidden = true),
  "copy-sql": () => state.query.sql.trim() && copy(state.query.sql),
  restore: (element) => setSql(state.query.history[Number(element.dataset.index)].sql),
  palette: openPalette,
  pick: (element) => {
    closePalette();
    explore(element.dataset.layer, element.dataset.id);
  },
  theme: () => document.documentElement.classList.toggle("dark"),
  logout: async () => {
    await api("/auth/logout", { method: "POST" });
    location.reload();
  },
};

const toast = document.getElementById("toast");
let toastTimer;
function notify(text, error = false) {
  toast.innerHTML = error
    ? `<span class="grow">${esc(text)}</span><button data-copy="${esc(text)}">copy</button><button data-action="dismiss" aria-label="Dismiss">×</button>`
    : esc(text);
  toast.classList.toggle("err", error);
  toast.hidden = false;
  clearTimeout(toastTimer);
  if (!error) toastTimer = setTimeout(() => (toast.hidden = true), 1800);
}

function copy(text) {
  navigator.clipboard?.writeText(text);
  const firstLine = text.split("\n")[0];
  notify(`Copied ${firstLine.length > 64 || text.includes("\n") ? `${firstLine.slice(0, 64)}…` : text}`);
}

const SIDEBAR = { min: 200, max: 640, initial: 290 };
const setSidebar = (width) => {
  const clamped = Math.round(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, width)));
  document.documentElement.style.setProperty("--sidebar", `${clamped}px`);
  localStorage.setItem("sidebar", clamped);
};
setSidebar(Number(localStorage.getItem("sidebar")) || SIDEBAR.initial);

document.addEventListener("pointerdown", (event) => {
  if (!event.target.classList.contains("resizer")) return;
  event.preventDefault();
  const left = event.target.parentElement.getBoundingClientRect().left;
  const move = (moveEvent) => setSidebar(moveEvent.clientX - left);
  document.body.classList.add("resizing");
  addEventListener("pointermove", move);
  addEventListener(
    "pointerup",
    () => {
      removeEventListener("pointermove", move);
      document.body.classList.remove("resizing");
    },
    { once: true },
  );
});

document.addEventListener("dblclick", (event) => event.target.classList.contains("resizer") && setSidebar(SIDEBAR.initial));

document.addEventListener("click", (event) => {
  if (event.target === paletteElement) return closePalette();
  const copyable = event.target.closest("[data-copy]");
  if (copyable && !getSelection().toString()) {
    event.preventDefault();
    return copy(copyable.dataset.copy);
  }
  const target = event.target.closest("[data-action]");
  if (target && !target.disabled) ACTIONS[target.dataset.action]?.(target, event);
});

document.addEventListener("input", (event) => {
  const { id, value } = event.target;
  if (id === "lane-search") {
    state.laneQuery = value;
    refresh("lane-list", laneList(LAYER_BY_ID.get(state.layer)));
  } else if (id === "sql") {
    state.query.sql = value;
    syncEditor();
  } else if (id === "q-filter") {
    refresh("q-tree", treeHtml(value));
  } else if (id === "pal-input") {
    palette.index = 0;
    renderPalette(value);
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id !== "lane-sort") return;
  state.laneSort = event.target.value;
  refresh("lane-list", laneList(LAYER_BY_ID.get(state.layer)));
});

document.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.target.id === "ask-form") ask(document.getElementById("ask-input").value);
  if (event.target.id === "login-form") login(event.target);
});

document.addEventListener("keydown", (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key === "k") {
    event.preventDefault();
    openPalette();
  } else if (!paletteElement.hidden) {
    if (event.key === "Escape") closePalette();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      palette.index = Math.max(0, Math.min(palette.results.length - 1, palette.index + (event.key === "ArrowDown" ? 1 : -1)));
      renderPalette(document.getElementById("pal-input").value);
    }
    if (event.key === "Enter" && palette.results[palette.index]) {
      const { item } = palette.results[palette.index];
      closePalette();
      explore(item.layer, item.id);
    }
  } else if (modifier && event.key === "Enter" && state.view === "query") {
    event.preventDefault();
    runQuery();
  } else if (state.view === "query" && ((modifier && event.key === "s") || (event.key === "Enter" && event.target.id === "file-path"))) {
    event.preventDefault();
    saveFile();
  }
});

start();
