#!/usr/bin/env node
/**
 * vergabe-mcp: MCP server (stdio) for German public procurement notices.
 *
 * Wraps https://vergabe-api.applehorsefrog.workers.dev. Free tools work without any setup.
 * Paid tools ($0.01 / $0.002 per call, USDC on Base via x402) need a wallet key in
 * VERGABE_PAYER_KEY; without it they return the payment requirements instead of data.
 *
 * Run:  npx -y github:applehorsefrog/vergabe-api
 * Env:  VERGABE_PAYER_KEY=0x...   (EVM private key holding USDC on Base; optional)
 *       VERGABE_API_URL=https://vergabe-api.applehorsefrog.workers.dev   (optional)
 *
 * Built with substantial AI assistance (Claude); operated by Viono Insights, see /impressum.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.VERGABE_API_URL || "https://vergabe-api.applehorsefrog.workers.dev").replace(/\/$/, "");
const KEY = process.env.VERGABE_PAYER_KEY;

let payFetch = null;
async function getFetch() {
  if (payFetch) return payFetch;
  if (!KEY) return fetch;
  const { wrapFetchWithPaymentFromConfig } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm");
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(KEY);
  payFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      { network: "eip155:8453", client: new ExactEvmScheme(account) },
      { network: "eip155:84532", client: new ExactEvmScheme(account) },
    ],
  });
  return payFetch;
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

function decodeHeader(h) {
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return h; }
}

async function call(path) {
  const f = await getFetch();
  const r = await f(`${BASE}${path}`, { headers: { accept: "application/json" } });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (r.status === 402) {
    const req = decodeHeader(r.headers.get("payment-required"));
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({
        error: "payment_required",
        message: KEY
          ? "Payment failed (check USDC balance on Base for the payer wallet)."
          : "This tool is paid per call via x402 (USDC on Base). Set VERGABE_PAYER_KEY to an EVM private key that holds USDC on Base, or call the HTTP endpoint with any x402 client.",
        url: `${BASE}${path}`,
        payment_requirements: req ?? body,
      }, null, 1) }],
    };
  }
  const settled = decodeHeader(r.headers.get("payment-response"));
  const out = settled ? { ...body, payment: settled } : body;
  return { isError: !r.ok, content: [{ type: "text", text: JSON.stringify(out, null, 1) }] };
}

const server = new McpServer({ name: "vergabe-mcp", version: "0.4.0" });

const filterShape = {
  kind: z.enum(["competition", "result", "planning", "change", "all"]).optional().describe("notice kind; default competition (calls for tenders)"),
  cpv: z.string().optional().describe("CPV codes or prefixes, comma separated, e.g. '45' or '45,7131'"),
  nuts: z.string().optional().describe("NUTS region prefixes, comma separated, e.g. 'DE2' (Bavaria), 'DE1,DE2'"),
  q: z.string().min(3).optional().describe("substring in title, description or buyer name"),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("publication day >= YYYY-MM-DD"),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("publication day <= YYYY-MM-DD"),
  deadline_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("submission deadline >= YYYY-MM-DD"),
  deadline_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("submission deadline <= YYYY-MM-DD"),
  nature: z.enum(["works", "services", "supplies"]).optional(),
  procedure: z.string().optional().describe("eForms procedure code, e.g. open, restricted, neg-w-call"),
  legal_basis: z.string().optional().describe("e.g. vgv, vob, uvgo, sektvo"),
  buyer_type: z.string().optional().describe("eForms buyer-legal-type code, e.g. kommun-beh, body-pl"),
  min_value: z.number().nonnegative().optional().describe("estimated contract value >= (EUR)"),
  limit: z.number().int().min(1).max(100).optional().describe("records per call, default 50, max 100"),
  offset: z.number().int().min(0).max(5000).optional(),
  fields: z.enum(["compact", "full"]).optional().describe("full adds description, lots, winners, all URLs"),
  sort: z.enum(["published", "deadline"]).optional(),
};

server.registerTool("search_tenders", {
  title: "Search German public procurement notices",
  description: "Search German public procurement notices (tenders, awards, planning) published on the official service oeffentlichevergabe.de, above and below EU thresholds, normalised to flat JSON with CPV, NUTS, buyer, deadline and document links. About 1,000 new notices per day, updated twice daily. PAID: $0.01 USDC on Base per call via x402 (up to 100 records); needs VERGABE_PAYER_KEY, otherwise returns the payment requirements. Personal contact data is removed at import.",
  inputSchema: filterShape,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async (args) => call(`/v1/notices${qs(args)}`));

server.registerTool("get_tender", {
  title: "Get one procurement notice",
  description: "Full record of one German procurement notice by UUID (optionally with -version suffix): all lots with deadlines, buyer organisation, document and submission URLs, winners for award notices. PAID: $0.002 USDC on Base per call via x402.",
  inputSchema: { id: z.string().regex(/^[0-9a-f-]{36}(-\d{1,3})?$/i).describe("notice UUID, e.g. 0066c4ef-f672-4717-aa5b-8b0d589a64a6") },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ id }) => call(`/v1/notice/${encodeURIComponent(id)}`));

server.registerTool("sample_tenders", {
  title: "Free sample: latest calls for tenders",
  description: "FREE. The 5 most recent German calls for tenders (compact fields), optionally filtered by one CPV code or prefix. Use it to check data shape and coverage before paid searches.",
  inputSchema: { cpv: z.string().regex(/^\d{2,8}$/).optional().describe("CPV code or prefix, e.g. 72 (IT services), 45 (construction)") },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ cpv }) => call(`/v1/sample${qs({ cpv })}`));

server.registerTool("tender_stats", {
  title: "Free: notices per day",
  description: "FREE. Number of imported notices per publication day for the last 30 days, split by kind (competition, result, planning, change), with load timestamps.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => call("/v1/stats"));

server.registerTool("describe_api", {
  title: "Service description, prices, legal notice",
  description: "FREE. Returns the service descriptor: endpoints, prices, payment details (x402, USDC on Base), data source and licence (CC0), provider and legal notice.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => call("/"));

const transport = new StdioServerTransport();
await server.connect(transport);
