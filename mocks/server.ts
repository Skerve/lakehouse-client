// Serves the UI and proxies /api/{fetch,config,tools,state,file}/* with the signed-in user's bearer.
// Tokens stay in this process; the browser only holds an HttpOnly session cookie.
// /lab.html draws the visuals in ./visuals without signing in: plot's golden cases, written by `bun run visuals`.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ENVIRONMENTS = {
  dev: { fetch: "fetch-dev/v1", config: "config-dev/v3", tools: "tools-dev/v1", state: "state-dev/v1", file: "file-dev/v2", issuer: "https://auth-dev.grasp-daas.com" },
  prod: { fetch: "fetch/v1", config: "config/v3", tools: "tools/v1", state: "state/v1", file: "file/v2", issuer: "https://auth.grasp-daas.com" },
} as const;

const API = "https://grasp-daas.com/api";
const mode = (process.env.BUILDING_MODE ?? "dev") as keyof typeof ENVIRONMENTS;
const env = ENVIRONMENTS[mode];
if (!env) throw new Error(`BUILDING_MODE must be dev or prod, got "${mode}"`);

const COOKIE = "lakehouse_session";
const assets = new Set(["/index.html", "/lab.html", "/app.css", "/app.js", "/pins.js"]);
const VISUALS = join(import.meta.dir, "visuals");
const VISUAL = /^([a-z0-9_]+)\.json$/;
const forwardedRequestHeaders = ["content-type", "accept", "cache-control", "accept-language"];
const forwardedResponseHeaders = ["content-type", "x-cache", "x-cache-layer", "x-request-id", "x-files-refreshed", "etag", "retry-after"];

type Session = { user: string; access: string; refresh: string; expires: number; pending?: Promise<void> };
const sessions = new Map<string, Session>();

class AuthError extends Error {}

const unauthenticated = (message: string) => Response.json({ code: "unauthenticated", message }, { status: 401 });
const cookie = (value: string, maxAge?: number) => `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}`;
const sessionId = (request: Request) => request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1] ?? "";

const expiry = (jwt: string) => {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).exp as number;
  } catch {
    return Date.now() / 1000 + 300;
  }
};

const post = (path: string, body: object, bearer?: string) =>
  fetch(`${env.issuer}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer && { authorization: `Bearer ${bearer}` }) },
    body: JSON.stringify(body),
  });

async function login(request: Request): Promise<Response> {
  const { email = "", password = "" } = await request.json().catch(() => ({}));
  const response = await post("/auth/login/", { email, password });
  const body = await response.json().catch(() => ({}));
  const access = body.access ?? body.access_token;
  const refresh = body.refresh ?? body.refresh_token;
  if (!response.ok || !access || !refresh) return unauthenticated(body.detail ?? body.non_field_errors?.[0] ?? "Sign-in failed.");
  const id = crypto.randomUUID();
  const user = body.user?.email ?? email;
  sessions.set(id, { user, access, refresh, expires: expiry(access) });
  return Response.json({ user }, { headers: { "set-cookie": cookie(id) } });
}

async function logout(request: Request): Promise<Response> {
  const id = sessionId(request);
  const session = sessions.get(id);
  sessions.delete(id);
  if (session) await post("/auth/logout/", { refresh: session.refresh }, session.access).catch(() => {});
  return new Response(null, { status: 204, headers: { "set-cookie": cookie("", 0) } });
}

function renew(session: Session): Promise<void> {
  session.pending ??= (async () => {
    const response = await post("/auth/token/refresh/", { refresh: session.refresh });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access) throw new AuthError("Session expired. Sign in again.");
    Object.assign(session, { access: body.access, refresh: body.refresh ?? session.refresh, expires: expiry(body.access) });
  })().finally(() => {
    session.pending = undefined;
  });
  return session.pending;
}

type Service = "fetch" | "config" | "tools" | "state" | "file";

async function proxy(request: Request, service: Service, path: string): Promise<Response> {
  const id = sessionId(request);
  const session = sessions.get(id);
  if (!session) return unauthenticated("Sign in to continue.");
  const body = request.method === "GET" ? undefined : await request.arrayBuffer();
  const send = async (force: boolean) => {
    if (force || session.expires - 30 < Date.now() / 1000) await renew(session);
    const headers = new Headers({ authorization: `Bearer ${session.access}` });
    for (const name of forwardedRequestHeaders) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    return fetch(`${API}/${env[service]}${path}`, { method: request.method, headers, body });
  };
  try {
    let upstream = await send(false);
    if (upstream.status === 401) upstream = await send(true);
    const headers = new Headers();
    for (const name of forwardedResponseHeaders) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    if (!(error instanceof AuthError)) return Response.json({ code: "upstream_unavailable", message: String(error) }, { status: 502 });
    sessions.delete(id);
    return unauthenticated(error.message);
  }
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4173),
  async fetch(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/(fetch|config|tools|state|file)(\/.*)$/);
    if (match) return proxy(request, match[1] as Service, match[2] + url.search);
    if (url.pathname === "/visuals/") {
      const files = await readdir(VISUALS).catch((): string[] => []);
      return Response.json(files.flatMap((file) => VISUAL.exec(file)?.[1] ?? []).sort());
    }
    const visual = url.pathname.startsWith("/visuals/") && VISUAL.exec(url.pathname.slice("/visuals/".length));
    if (visual) {
      const file = Bun.file(join(VISUALS, `${visual[1]}.json`));
      return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/session") return Response.json({ env: mode, user: sessions.get(sessionId(request))?.user ?? null });
    if (url.pathname === "/auth/login" && request.method === "POST") return login(request);
    if (url.pathname === "/auth/logout" && request.method === "POST") return logout(request);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    return assets.has(path) ? new Response(Bun.file(join(import.meta.dir, path))) : new Response("Not found", { status: 404 });
  },
});

console.log(`Lakehouse on http://localhost:${server.port} → ${mode} (${API}/${env.fetch}, ${env.issuer})`);
