/**
 * vergabe-api: German public procurement notices as a normalised JSON API.
 * Paid per call via x402 (USDC). Free sample and stats endpoints.
 *
 * Data source: Datenservice Öffentlicher Einkauf (oeffentlichevergabe.de), licence CC0.
 * Built with substantial AI assistance (Claude); operated pseudonymously by the account holder.
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

type Bindings = {
  DB: D1Database;
  PAY_TO: string;
  X402_NETWORK: string;
  X402_FACILITATOR: string;
  PRICE_LIST: string;
  PRICE_NOTICE: string;
  PUBLIC_URL: string;
};

const VERSION = "0.1.0";
const SOURCE = "Datenservice Öffentlicher Einkauf (oeffentlichevergabe.de)";
const LICENSE = "CC0-1.0";

const app = new Hono<{ Bindings: Bindings }>();

// ---------- common headers ----------
app.use("*", async (c, next) => {
  await next();
  c.header("X-Data-Source", SOURCE);
  c.header("X-Data-License", LICENSE);
  c.header("X-Service-Version", VERSION);
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Expose-Headers", "*");
});

// ---------- x402 payment middleware (lazy, per-isolate) ----------
let paid: MiddlewareHandler | undefined;
let paidKey = "";
function paymentFor(env: Bindings): MiddlewareHandler {
  const key = `${env.PAY_TO}|${env.X402_NETWORK}|${env.X402_FACILITATOR}|${env.PRICE_LIST}|${env.PRICE_NOTICE}`;
  if (paid && paidKey === key) return paid;
  const facilitator = new HTTPFacilitatorClient({ url: env.X402_FACILITATOR });
  const server = new x402ResourceServer(facilitator).register(env.X402_NETWORK as `${string}:${string}`, new ExactEvmScheme());
  const accept = (price: string) => ({ scheme: "exact" as const, price, network: env.X402_NETWORK as `${string}:${string}`, payTo: env.PAY_TO, maxTimeoutSeconds: 120 });
  paid = paymentMiddleware(
    {
      "GET /v1/notices": {
        accepts: accept(env.PRICE_LIST),
        description: "Filtered list of German public procurement notices (CPV, NUTS, deadline, full text). Up to 100 records per call.",
        mimeType: "application/json",
      },
      "GET /v1/notice/*": {
        accepts: accept(env.PRICE_NOTICE),
        description: "One procurement notice with all lots and links.",
        mimeType: "application/json",
      },
    },
    server,
  );
  paidKey = key;
  return paid;
}
app.use("/v1/notices", (c, next) => paymentFor(c.env)(c, next));
app.use("/v1/notice/*", (c, next) => paymentFor(c.env)(c, next));

// ---------- helpers ----------
const COMPACT = [
  "id", "published", "kind", "notice_type", "procedure", "legal_basis", "nature", "title", "cpv_main", "cpv_additional",
  "buyer_name", "buyer_type", "buyer_city", "place_nuts", "place_city", "estimated_value", "currency",
  "deadline_date", "deadline_time", "deadline_kind", "documents_url", "lot_count", "source_url",
];
const JSON_COLS = new Set(["cpv_additional", "lots", "winners"]);

function rowOut(row: Record<string, unknown>, cols?: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of cols ?? Object.keys(row)) {
    let v = row[k];
    if (JSON_COLS.has(k) && typeof v === "string") {
      try { v = JSON.parse(v); } catch { /* keep string */ }
    }
    out[k] = v;
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function bad(c: Context, msg: string) {
  return c.json({ error: msg }, 400);
}
function list(param: string | undefined, re: RegExp, max = 10): string[] | null {
  if (!param) return [];
  const items = param.split(",").map((s) => s.trim()).filter(Boolean).slice(0, max);
  for (const it of items) if (!re.test(it)) return null;
  return items;
}

type Q = { where: string[]; params: unknown[] };
function buildFilters(c: Context<{ Bindings: Bindings }>, q: Q): string | null {
  const p = c.req.query();
  const kind = p.kind ?? "competition";
  if (!["competition", "result", "planning", "change", "all"].includes(kind)) return "kind must be competition|result|planning|change|all";
  if (kind !== "all") { q.where.push("kind = ?"); q.params.push(kind); }

  const cpv = list(p.cpv, /^\d{2,8}$/);
  if (cpv === null) return "cpv must be 2-8 digit codes or prefixes, comma separated";
  if (cpv.length) {
    q.where.push("(" + cpv.map(() => "(cpv_main LIKE ? OR cpv_additional LIKE ?)").join(" OR ") + ")");
    for (const code of cpv) q.params.push(code + "%", `%"${code}%`);
  }
  const nuts = list(p.nuts, /^[A-Z]{2}[A-Z0-9]{0,3}$/i);
  if (nuts === null) return "nuts must be NUTS codes or prefixes (e.g. DE, DE2, DE212)";
  if (nuts.length) {
    q.where.push("(" + nuts.map(() => "(place_nuts LIKE ? OR buyer_nuts LIKE ?)").join(" OR ") + ")");
    for (const n of nuts) q.params.push(n.toUpperCase() + "%", n.toUpperCase() + "%");
  }
  for (const [key, col] of [["since", "published >= ?"], ["until", "published <= ?"], ["deadline_after", "deadline_date >= ?"], ["deadline_before", "deadline_date <= ?"]] as const) {
    const v = p[key];
    if (v) {
      if (!DATE_RE.test(v)) return `${key} must be YYYY-MM-DD`;
      q.where.push(col); q.params.push(v);
    }
  }
  for (const [key, col, re] of [["nature", "nature", /^(works|services|supplies)$/], ["procedure", "procedure", /^[a-z-]{2,20}$/], ["legal_basis", "legal_basis", /^[a-z-]{2,20}$/], ["buyer_type", "buyer_type", /^[a-z-]{2,30}$/]] as const) {
    const v = p[key];
    if (v) {
      if (!re.test(v)) return `${key} has an invalid value`;
      q.where.push(`${col} = ?`); q.params.push(v);
    }
  }
  if (p.min_value) {
    const n = Number(p.min_value);
    if (!Number.isFinite(n) || n < 0) return "min_value must be a number";
    q.where.push("estimated_value >= ?"); q.params.push(n);
  }
  if (p.q) {
    const term = p.q.trim().slice(0, 100);
    if (term.length < 3) return "q must have at least 3 characters";
    q.where.push("(title LIKE ? OR description LIKE ? OR buyer_name LIKE ?)");
    const like = "%" + term.replace(/[%_]/g, " ") + "%";
    q.params.push(like, like, like);
  }
  return null;
}

// ---------- free endpoints ----------
app.get("/", (c) => {
  const base = c.env.PUBLIC_URL;
  return c.json({
    name: "vergabe-api",
    version: VERSION,
    description: "German public procurement notices (above and below EU thresholds) as normalised JSON: CPV, NUTS, buyer, deadline, links. Updated daily from the official eForms-DE feed.",
    data_source: { name: SOURCE, url: "https://oeffentlichevergabe.de", license: LICENSE, license_url: "https://opendefinition.org/licenses/cc-zero/" },
    privacy: "Contact persons, e-mail addresses and phone numbers are removed. Only organisation-level data is served.",
    payment: { protocol: "x402", network: c.env.X402_NETWORK, asset: "USDC", pay_to: c.env.PAY_TO, facilitator: c.env.X402_FACILITATOR },
    endpoints: {
      "GET /v1/sample": { price: "free", note: "5 latest competition notices, compact fields, optional ?cpv=" },
      "GET /v1/stats": { price: "free", note: "notices per day, last 30 days" },
      "GET /v1/notices": { price: c.env.PRICE_LIST, params: "kind, cpv, nuts, q, since, until, deadline_after, deadline_before, nature, procedure, legal_basis, buyer_type, min_value, limit(<=100), offset, fields=compact|full" },
      "GET /v1/notice/{id}": { price: c.env.PRICE_NOTICE, note: "full record incl. lots and winners" },
      "GET /openapi.json": { price: "free" },
    },
    examples: [
      `${base}/v1/sample?cpv=72`,
      `${base}/v1/notices?cpv=45,71&nuts=DE2&deadline_after=2026-09-20&limit=20`,
      `${base}/v1/notices?q=Photovoltaik&since=2026-09-01`,
    ],
    disclosure: "Built with substantial AI assistance (Claude) and operated pseudonymously by the account holder. No legal advice; verify deadlines at the source before bidding.",
    source_code: "https://github.com/Applehorsefrog/vergabe-api",
  });
});

app.get("/openapi.json", (c) => {
  const base = c.env.PUBLIC_URL;
  return c.json({
    openapi: "3.1.0",
    info: { title: "vergabe-api", version: VERSION, description: "German public procurement notices, normalised. Paid endpoints use x402 (HTTP 402 + USDC).", license: { name: "Data: CC0-1.0; code: MIT" } },
    servers: [{ url: base }],
    paths: {
      "/v1/sample": { get: { summary: "Free sample (5 latest competition notices)", parameters: [{ name: "cpv", in: "query", schema: { type: "string" } }], responses: { "200": { description: "OK" } } } },
      "/v1/stats": { get: { summary: "Notices per day", responses: { "200": { description: "OK" } } } },
      "/v1/notices": {
        get: {
          summary: "Filtered notices (x402 paid)",
          parameters: ["kind", "cpv", "nuts", "q", "since", "until", "deadline_after", "deadline_before", "nature", "procedure", "legal_basis", "buyer_type", "min_value", "limit", "offset", "fields"].map((n) => ({ name: n, in: "query", schema: { type: "string" } })),
          responses: { "200": { description: "OK" }, "402": { description: "Payment required (x402)" } },
        },
      },
      "/v1/notice/{id}": { get: { summary: "One notice (x402 paid)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" }, "402": { description: "Payment required (x402)" }, "404": { description: "Not found" } } } },
    },
  });
});

app.get("/v1/stats", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT day, notices, competition, result, planning, change, loaded_at FROM days ORDER BY day DESC LIMIT 30").all();
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({ days: results });
});

app.get("/v1/sample", async (c) => {
  const cpv = list(c.req.query("cpv"), /^\d{2,8}$/, 1);
  if (cpv === null) return bad(c, "cpv must be 2-8 digits");
  const where = ["kind = 'competition'"];
  const params: unknown[] = [];
  if (cpv.length) { where.push("cpv_main LIKE ?"); params.push(cpv[0] + "%"); }
  const sql = `SELECT ${COMPACT.join(", ")} FROM notices WHERE ${where.join(" AND ")} ORDER BY published DESC, id LIMIT 5`;
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({
    note: `Free sample, max 5 records. Full access: GET /v1/notices (${c.env.PRICE_LIST} per call via x402).`,
    count: results.length,
    notices: results.map((r) => rowOut(r as Record<string, unknown>)),
  });
});

// ---------- paid endpoints ----------
app.get("/v1/notices", async (c) => {
  const q: Q = { where: [], params: [] };
  const err = buildFilters(c, q);
  if (err) return bad(c, err);
  const p = c.req.query();
  const limit = Math.min(Math.max(parseInt(p.limit ?? "50", 10) || 50, 1), 100);
  const offset = Math.min(Math.max(parseInt(p.offset ?? "0", 10) || 0, 0), 5000);
  const full = p.fields === "full";
  const cols = full ? "*" : COMPACT.join(", ");
  const whereSql = q.where.length ? "WHERE " + q.where.join(" AND ") : "";
  const order = p.sort === "deadline" ? "deadline_date ASC NULLS LAST, published DESC" : "published DESC, id";
  const stmtRows = c.env.DB.prepare(`SELECT ${cols} FROM notices ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...q.params, limit, offset);
  const stmtCount = c.env.DB.prepare(`SELECT COUNT(*) AS n FROM notices ${whereSql}`).bind(...q.params);
  const [rows, cnt] = await c.env.DB.batch([stmtRows, stmtCount]);
  const total = (cnt.results?.[0] as { n: number } | undefined)?.n ?? 0;
  return c.json({
    total, limit, offset, count: rows.results.length,
    attribution: `${SOURCE}, ${LICENSE}`,
    notices: rows.results.map((r) => rowOut(r as Record<string, unknown>)),
  });
});

app.get("/v1/notice/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}(-\d{1,3})?$/i.test(id)) return bad(c, "id must be a notice UUID, optionally with -version");
  let row = await c.env.DB.prepare("SELECT * FROM notices WHERE id = ?").bind(id).first();
  if (!row) row = await c.env.DB.prepare("SELECT * FROM notices WHERE notice_id = ? ORDER BY version DESC LIMIT 1").bind(id).first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ attribution: `${SOURCE}, ${LICENSE}`, notice: rowOut(row as Record<string, unknown>) });
});

app.notFound((c) => c.json({ error: "not found", see: "/" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

export default app;
