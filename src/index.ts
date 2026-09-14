/**
 * vergabe-api: German public procurement notices as a normalised JSON API.
 * Paid per call via x402 (USDC). Free sample and stats endpoints.
 *
 * Data source: Datenservice Öffentlicher Einkauf (oeffentlichevergabe.de), licence CC0.
 * Built with substantial AI assistance (Claude); operated by Viono Insights (see /impressum).
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";

type Bindings = {
  DB: D1Database;
  PAY_TO: string;
  X402_NETWORK: string;
  X402_FACILITATOR: string;
  PRICE_LIST: string;
  PRICE_NOTICE: string;
  PUBLIC_URL: string;
};

const VERSION = "0.3.0";
const PROVIDER = {
  name: "Dr. Josua Decker",
  brand: "Viono Insights",
  website: "https://viono-insights.de",
  imprint: "https://viono-insights.de/impressum.html",
  email: "kontakt@viono-insights.de",
};
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
  const server = new x402ResourceServer(facilitator)
    .register(env.X402_NETWORK as `${string}:${string}`, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  const accept = (price: string) => ({ scheme: "exact" as const, price, network: env.X402_NETWORK as `${string}:${string}`, payTo: env.PAY_TO, maxTimeoutSeconds: 120 });
  const meta = { serviceName: "vergabe-api", tags: ["procurement", "tenders", "germany", "open-data", "government"], iconUrl: `${env.PUBLIC_URL}/icon.svg` };
  paid = paymentMiddleware(
    {
      "GET /v1/notices": {
        accepts: accept(env.PRICE_LIST),
        description: "German public procurement notices (tenders, awards) as normalised JSON. Filter by CPV code, NUTS region, deadline, publication date, buyer type or full text. Up to 100 records per call; 1,000 new notices per day from the official eForms-DE feed (CC0). Contact data removed.",
        mimeType: "application/json",
        ...meta,
        extensions: {
          ...declareDiscoveryExtension({
            input: { cpv: "45", nuts: "DE2", deadline_after: "2026-09-20", limit: 20 },
            inputSchema: {
              properties: {
                kind: { type: "string", enum: ["competition", "result", "planning", "change", "all"], description: "notice kind, default competition (calls for tenders)" },
                cpv: { type: "string", description: "CPV codes or prefixes, comma separated, e.g. 45 or 45,7131" },
                nuts: { type: "string", description: "NUTS region prefixes, comma separated, e.g. DE2 (Bavaria)" },
                q: { type: "string", description: "substring search in title, description, buyer (min 3 chars)" },
                since: { type: "string", description: "publication day >= YYYY-MM-DD" },
                until: { type: "string", description: "publication day <= YYYY-MM-DD" },
                deadline_after: { type: "string", description: "submission deadline >= YYYY-MM-DD" },
                deadline_before: { type: "string", description: "submission deadline <= YYYY-MM-DD" },
                nature: { type: "string", enum: ["works", "services", "supplies"] },
                buyer_type: { type: "string", description: "eForms buyer-legal-type code, e.g. kommun-beh" },
                min_value: { type: "number", description: "estimated value >= (EUR)" },
                limit: { type: "integer", description: "1..100, default 50" },
                offset: { type: "integer", description: "0..5000" },
                fields: { type: "string", enum: ["compact", "full"] },
                sort: { type: "string", enum: ["published", "deadline"] },
              },
            },
            output: {
              example: {
                total: 142, limit: 20, offset: 0, count: 1,
                attribution: "Datenservice Öffentlicher Einkauf (oeffentlichevergabe.de), CC0-1.0",
                notices: [{ id: "0066c4ef-f672-4717-aa5b-8b0d589a64a6-01", published: "2026-09-10", kind: "competition", notice_type: "cn-standard", procedure: "open", legal_basis: "vgv", nature: "supplies", title: "Beschaffung von mobilen Zufahrtsschutzelementen", cpv_main: "34928300", cpv_additional: ["35000000"], buyer_name: "Stadt Mannheim", buyer_type: "kommun-beh", buyer_city: "Mannheim", place_nuts: "DE126", deadline_date: "2026-09-24", deadline_time: "10:15", deadline_kind: "tender", documents_url: "https://vergabe.vmstart.de/...", lot_count: 2, source_url: "https://oeffentlichevergabe.de/api/notices/0066c4ef-...?format=eforms-de&noticeVersion=01" }],
              },
            },
          }),
        },
      },
      "GET /v1/notice/*": {
        accepts: accept(env.PRICE_NOTICE),
        description: "One German public procurement notice by UUID with all lots, deadlines, buyer, links and (for awards) winning organisations. Source: oeffentlichevergabe.de (CC0), contact data removed.",
        mimeType: "application/json",
        ...meta,
        extensions: {
          ...declareDiscoveryExtension({
            pathParams: { id: "0066c4ef-f672-4717-aa5b-8b0d589a64a6" },
            pathParamsSchema: { properties: { id: { type: "string", description: "notice UUID, optionally with -version suffix" } }, required: ["id"] },
            output: { example: { attribution: "Datenservice Öffentlicher Einkauf (oeffentlichevergabe.de), CC0-1.0", notice: { id: "0066c4ef-f672-4717-aa5b-8b0d589a64a6-01", title: "Beschaffung von mobilen Zufahrtsschutzelementen", lots: [{ id: "LOT-0001", title: "Los 1", cpv: "34928300", deadline_date: "2026-09-24" }] } } },
          }),
        },
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
      "GET /impressum": { price: "free", note: "legal notice (§ 5 DDG)" },
      "GET /datenschutz": { price: "free", note: "privacy notice (Art. 13 DSGVO)" },
      "GET /.well-known/x402": { price: "free", note: "x402 discovery manifest" },
    },
    examples: [
      `${base}/v1/sample?cpv=72`,
      `${base}/v1/notices?cpv=45,71&nuts=DE2&deadline_after=2026-09-20&limit=20`,
      `${base}/v1/notices?q=Photovoltaik&since=2026-09-01`,
    ],
    provider: { name: PROVIDER.name, brand: PROVIDER.brand, website: PROVIDER.website, imprint: PROVIDER.imprint, privacy: `${base}/datenschutz`, contact: PROVIDER.email },
    disclosure: "Built with substantial AI assistance (Claude); operated by the provider named above, who reviews and is responsible for it. No legal advice; verify deadlines at the source before bidding.",
    source_code: "https://github.com/applehorsefrog/vergabe-api",
  });
});

// ---------- legal (§ 5 DDG, Art. 13 DSGVO) ----------
const IMPRESSUM_TXT = `Impressum / Legal notice (§ 5 DDG)

Anbieter dieses Dienstes (vergabe-api):
${PROVIDER.name}, ${PROVIDER.brand}
Kontakt: ${PROVIDER.email}
Vollständiges Impressum mit Anschrift, Steuernummer und Haftungshinweisen:
${PROVIDER.imprint}

Datenschutzhinweise für diese API: siehe /datenschutz
Datenquelle: Datenservice Öffentlicher Einkauf (oeffentlichevergabe.de), Lizenz CC0 1.0.
Dieser Dienst wurde mit erheblicher KI-Unterstützung (Claude) erstellt und wird vom Anbieter geprüft und verantwortet.
`;

const DATENSCHUTZ_TXT = `Datenschutzhinweise für die API vergabe-api (Art. 13 DSGVO) / Privacy notice

Verantwortlicher: ${PROVIDER.name}, ${PROVIDER.brand}, ${PROVIDER.email}. Anschrift siehe ${PROVIDER.imprint}

1. Welche Daten verarbeitet werden
- Technische Zugriffsdaten: IP-Adresse, Zeitpunkt, angefragte URL, User-Agent, Antwortstatus. Sie fallen beim Aufruf jeder HTTP-Schnittstelle an und werden von unserem Hosting-Dienstleister Cloudflare (Cloudflare, Inc., USA; EU-Standardvertragsklauseln und EU-US Data Privacy Framework) in Protokollen verarbeitet. Aufbewahrung in der Beobachtbarkeits-Funktion des Workers: bis zu 7 Tage.
- Zahlungsdaten bei kostenpflichtigen Endpunkten (x402): Ihre Wallet-Adresse, der signierte Zahlungsauftrag und der Transaktions-Hash. Diese Daten sind Bestandteil einer öffentlichen Blockchain (Base) und werden vom Zahlungs-Facilitator (PayAI, facilitator.payai.network) zur Prüfung und Abwicklung verarbeitet. Wir speichern keine Wallet-Adressen über die Protokolle hinaus.
- Keine Cookies, keine Konten, keine Registrierung, kein Tracking.

2. Zwecke und Rechtsgrundlagen
Bereitstellung und Sicherheit des Dienstes sowie Missbrauchsabwehr (Art. 6 Abs. 1 lit. f DSGVO); Abwicklung der Bezahlung pro Aufruf (Art. 6 Abs. 1 lit. b DSGVO).

3. Inhalte der API
Die ausgelieferten Daten stammen aus dem Datenservice Öffentlicher Einkauf (CC0). Personenbezogene Kontaktdaten (Ansprechpartner, E-Mail-Adressen, Telefonnummern) werden beim Import entfernt; es werden nur Organisationsdaten ausgeliefert. Sollten dennoch personenbezogene Daten enthalten sein, bitten wir um Hinweis an ${PROVIDER.email}; sie werden entfernt.

4. Ihre Rechte
Auskunft, Berichtigung, Löschung, Einschränkung, Widerspruch und Datenübertragbarkeit (Art. 15 bis 21 DSGVO) sowie Beschwerde bei einer Datenschutz-Aufsichtsbehörde, in Bayern das Bayerische Landesamt für Datenschutzaufsicht (BayLDA). Hinweis: Daten auf einer öffentlichen Blockchain können technisch nicht gelöscht werden.

Stand: 14.09.2026
`;

app.get("/impressum", (c) => {
  if ((c.req.header("accept") || "").includes("application/json")) {
    return c.json({ law: "§ 5 DDG", provider: PROVIDER.name, brand: PROVIDER.brand, contact: PROVIDER.email, full_imprint: PROVIDER.imprint, privacy: "/datenschutz" });
  }
  return c.text(IMPRESSUM_TXT);
});
app.get("/imprint", (c) => c.redirect("/impressum", 301));
app.get("/legal", (c) => c.redirect("/impressum", 301));
app.get("/datenschutz", (c) => c.text(DATENSCHUTZ_TXT));
app.get("/privacy", (c) => c.redirect("/datenschutz", 301));

// ---------- discovery: /.well-known/x402, icon, OpenAPI with x-payment-info ----------
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#1f3a5f"/><path d="M14 20h36M14 32h36M14 44h22" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/><circle cx="48" cy="44" r="6" fill="#ffcc00"/></svg>`;
app.get("/icon.svg", (c) => {
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(ICON_SVG, 200, { "Content-Type": "image/svg+xml" });
});
app.get("/favicon.ico", (c) => {
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(ICON_SVG, 200, { "Content-Type": "image/svg+xml" });
});

app.get("/.well-known/x402", (c) => {
  const base = c.env.PUBLIC_URL;
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({
    x402Version: 2,
    version: 1,
    kind: "resource-server",
    name: "vergabe-api",
    description: "German public procurement notices (tenders and awards) as normalised JSON, updated daily from the official eForms-DE feed. Paid per call in USDC on Base.",
    docs: `${base}/openapi.json`,
    contact: PROVIDER.email,
    updated: "2026-09-14",
    resources: [
      { url: `${base}/v1/notices`, method: "GET", description: "Filtered list of notices (CPV, NUTS, deadline, full text), up to 100 records" },
      { url: `${base}/v1/notice/0066c4ef-f672-4717-aa5b-8b0d589a64a6`, method: "GET", description: "One notice by UUID with lots and links" },
    ],
  });
});
app.get("/.well-known/x402.json", (c) => c.redirect("/.well-known/x402", 301));

app.get("/openapi.json", (c) => {
  const base = c.env.PUBLIC_URL;
  const pay = (amount: string) => ({ protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount }, network: c.env.X402_NETWORK, asset: "USDC", payTo: c.env.PAY_TO });
  const q = (name: string, description: string, type = "string") => ({ name, in: "query", description, schema: { type } });
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({
    openapi: "3.1.0",
    info: {
      title: "vergabe-api", version: VERSION,
      description: "German public procurement notices (above and below EU thresholds), normalised from the official eForms-DE feed of oeffentlichevergabe.de (CC0). Paid endpoints use x402 (HTTP 402, USDC on Base). Provider: Viono Insights, see /impressum.",
      contact: { name: PROVIDER.brand, email: PROVIDER.email, url: PROVIDER.website },
      license: { name: "Data: CC0-1.0; code: MIT", url: "https://github.com/applehorsefrog/vergabe-api" },
      "x-payment-info": pay(c.env.PRICE_LIST.replace("$", "")),
    },
    servers: [{ url: base }],
    paths: {
      "/v1/sample": { get: { operationId: "sample", summary: "Free sample: 5 latest calls for tenders (compact fields)", security: [], parameters: [q("cpv", "CPV code or prefix")], responses: { "200": { description: "OK" } } } },
      "/v1/stats": { get: { operationId: "stats", summary: "Free: notices per day, last 30 days", security: [], responses: { "200": { description: "OK" } } } },
      "/v1/notices": {
        get: {
          operationId: "searchNotices",
          summary: "Filtered notices (x402 paid, $0.01 per call, up to 100 records)",
          "x-payment-info": pay(c.env.PRICE_LIST.replace("$", "")),
          parameters: [
            q("kind", "competition (default) | result | planning | change | all"),
            q("cpv", "CPV codes or prefixes, comma separated (45 or 45,7131)"),
            q("nuts", "NUTS region prefixes, comma separated (DE2, DE212)"),
            q("q", "substring in title, description, buyer (min 3 chars)"),
            q("since", "publication day >= YYYY-MM-DD"), q("until", "publication day <= YYYY-MM-DD"),
            q("deadline_after", "submission deadline >= YYYY-MM-DD"), q("deadline_before", "submission deadline <= YYYY-MM-DD"),
            q("nature", "works | services | supplies"), q("procedure", "eForms procedure code, e.g. open"), q("legal_basis", "vgv | vob | uvgo | ..."),
            q("buyer_type", "eForms buyer-legal-type code"), q("min_value", "estimated value >= (EUR)", "number"),
            q("limit", "1..100, default 50", "integer"), q("offset", "0..5000", "integer"), q("fields", "compact (default) | full"), q("sort", "published (default) | deadline"),
          ],
          responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { total: { type: "integer" }, count: { type: "integer" }, notices: { type: "array", items: { type: "object" } } } } } } }, "402": { description: "Payment required (x402): see PAYMENT-REQUIRED header" } },
        },
      },
      "/v1/notice/{id}": {
        get: {
          operationId: "getNotice",
          summary: "One notice by UUID with lots, deadlines, links (x402 paid, $0.002)",
          "x-payment-info": pay(c.env.PRICE_NOTICE.replace("$", "")),
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "notice UUID, optionally with -version" }],
          responses: { "200": { description: "OK" }, "402": { description: "Payment required (x402)" }, "404": { description: "Not found" } },
        },
      },
      "/impressum": { get: { summary: "Legal notice (§ 5 DDG)", security: [], responses: { "200": { description: "OK" } } } },
      "/datenschutz": { get: { summary: "Privacy notice (Art. 13 GDPR)", security: [], responses: { "200": { description: "OK" } } } },
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
