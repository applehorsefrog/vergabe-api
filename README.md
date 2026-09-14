# vergabe-api

German public procurement notices, above and below the EU thresholds, as a normalised JSON API for software agents and procurement tools. Paid per call with [x402](https://x402.org) (HTTP 402, USDC). No account, no API key, no subscription.

Base URL: `https://vergabe-api.applehorsefrog.workers.dev` (a branded domain under viono-insights.de will follow). Payments settle on **Base mainnet** in USDC since 2026-09-14; the facilitator is PayAI.

## What you get

Every day roughly 1,000 notices are published on the official German notification service (Datenservice Öffentlicher Einkauf, eForms-DE). The raw feed is a ZIP of XML files, 20 MB per day, with organisation contacts, lots, deadlines and classifications scattered over UBL extensions. This API turns each notice into one flat record:

| field | meaning |
|---|---|
| `id`, `notice_id`, `version` | notice UUID and version |
| `published`, `issue_date` | publication day of the export, issue date from the notice |
| `kind` | `competition` (calls for tenders), `result` (awards), `planning`, `change` |
| `notice_type`, `subtype`, `procedure`, `legal_basis`, `nature` | eForms codes (`cn-standard`, `open`, `vgv`, `works` ...) |
| `title`, `description` | German text, personal contact data removed |
| `cpv_main`, `cpv_additional` | CPV codes without check digit |
| `buyer_name`, `buyer_type`, `buyer_city`, `buyer_postal`, `buyer_nuts`, `buyer_website` | contracting authority (organisation level only) |
| `place_nuts`, `place_city` | place of performance |
| `estimated_value`, `currency` | if stated |
| `deadline_date`, `deadline_time`, `deadline_kind` | earliest lot deadline; `tender` or `participation` |
| `documents_url`, `submission_url` | where the tender documents live |
| `lots` | array of lots with title, CPV, NUTS, value, deadline, period |
| `winners`, `total_awarded` | for award notices, organisation names only |
| `source_url` | the original notice at oeffentlichevergabe.de |

Coverage on a sample day (2026-09-10): 1,067 notices, 589 calls for tenders, 569 of them with a submission deadline, 1,036 with CPV, 985 with NUTS.

## Endpoints

| endpoint | price | notes |
|---|---|---|
| `GET /` | free | service descriptor |
| `GET /openapi.json` | free | OpenAPI 3.1 |
| `GET /v1/stats` | free | notices per day, last 30 days |
| `GET /v1/sample?cpv=72` | free | 5 latest calls for tenders, compact fields |
| `GET /v1/notices` | $0.01 | filtered list, up to 100 records |
| `GET /v1/notice/{id}` | $0.002 | one full record |

### Filters for `/v1/notices`

`kind` (default `competition`; `result`, `planning`, `change`, `all`), `cpv` (codes or prefixes, comma separated: `45,7131`), `nuts` (prefixes: `DE2,DE1`), `q` (substring in title, description, buyer), `since` / `until` (publication day), `deadline_after` / `deadline_before`, `nature`, `procedure`, `legal_basis`, `buyer_type`, `min_value`, `limit` (max 100), `offset` (max 5000), `fields=full` (all columns incl. lots), `sort=deadline`.

```
GET /v1/notices?cpv=45,71&nuts=DE2&deadline_after=2026-09-20&limit=20
GET /v1/notices?q=Photovoltaik&since=2026-09-01&fields=full
GET /v1/notices?kind=result&cpv=72&since=2026-09-01
```

## Paying with x402

A request without payment returns `402` with a `PAYMENT-REQUIRED` header describing the amount (USDC), network and receiving address. Any x402 client handles this automatically, for example `@x402/fetch`:

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`); // holds USDC on Base
const fetchWithPay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
});
const r = await fetchWithPay("https://vergabe-api.applehorsefrog.workers.dev/v1/notices?cpv=72");
console.log(await r.json());
```

Prices are in USD and settled in USDC on Base (eip155:8453); there are no other fees on our side. The same code runs against Base Sepolia by setting `X402_NETWORK=eip155:84532` and `X402_FACILITATOR=https://x402.org/facilitator` in `wrangler.jsonc`.

## Data source, licence, privacy

Data: Datenservice Öffentlicher Einkauf, https://oeffentlichevergabe.de, published under CC0 1.0. Every response carries `X-Data-Source` and `X-Data-License` headers. Code in this repository: MIT.

Contact persons, e-mail addresses, phone and fax numbers are removed during import (`etl/etl.py`), both from structured fields and from free text. Only organisation-level data is served. If you find personal data that slipped through, open an issue and it will be removed.

This is a technical data service, not legal advice. Deadlines and conditions must be verified at the source before bidding.

## How it runs

- `src/index.ts`: Cloudflare Worker (Hono) with `@x402/hono` payment middleware and a D1 (SQLite) database.
- `etl/etl.py`: downloads the daily eForms ZIP, parses it with lxml, scrubs personal data, writes `INSERT` statements.
- `.github/workflows/daily-etl.yml`: runs the ETL every morning and loads the rows with `wrangler d1 execute`.

Local development:

```
npm install
npx wrangler d1 execute vergabe --local --file=schema.sql
python etl/etl.py --day 2026-09-10 --out etl/out/d.sql && for f in etl/out/d*.sql; do npx wrangler d1 execute vergabe --local --file=$f; done
npx wrangler dev
```

## Provider, legal notice, privacy

Operated by Dr. Josua Decker, Viono Insights (https://viono-insights.de). Legal notice (Impressum, § 5 DDG): https://viono-insights.de/impressum.html, also served at `GET /impressum`. Privacy notice for this API (Art. 13 GDPR): `GET /datenschutz`. Contact: kontakt@viono-insights.de. The GitHub account that publishes this repository is an automated account operated with Claude on behalf of the provider.

## Disclosure

This service was built with substantial AI assistance (Claude); the provider reviews and is responsible for it. Issues and pull requests are welcome; automated contributions are labelled as such.
