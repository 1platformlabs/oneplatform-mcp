# OnePlatform MCP server

Connects a coding agent to the OnePlatform documentation and to the OnePlatform API with your own keys, on
**QA by default**.

## Tools

Three documentation tools work without keys: `docs_search`, `docs_get_page` and `api_get_operation`. The
documentation itself is written in Spanish. With keys, the server adds the API tools, grouped by product vertical
(*toolset*):

| Toolset | What the agent can do |
|---|---|
| `account` | Profile, balance history, consumption, businesses and notices. Always enabled: this is where the `businessId` comes from |
| `payments` | Payment links (list, view, **create** and **cancel**) and transactions |
| `payouts` | Withdrawable balance, movements, withdrawals, withdrawal methods (masked) and charges that can move to the withdrawable balance (read only) |
| `subscriptions` | The business's plans, subscriptions and customers; **create, edit, publish and archive** plans, **create and edit** customers, **issue** an invitation and **cancel** a subscription |
| `terminal` | Card terminal requests, their status and the detail of a terminal payment; **create, correct and withdraw** a request (submission and documents stay in the dashboard) |
| `invoicing` | Electronic invoices (read only: the MCP does not issue or void) |
| `shipping` | Shipments (read only: the MCP does not dispatch) |
| `sites` | Sites, articles, generation jobs, categories and search performance |
| `analytics` | Analytics status, property, streams, dimensions, key events, tag and metrics; ad status, accounts, revenue, alerts and policy issues; heatmap sites, maps and snapshots (read only) |
| `email` | Transactional email senders, templates, quota and messages; business email conversations, per-address mailbox (`address_id`, `folder`) and per-folder counts |
| `domains` | Domains, availability, prices, transfers and email records (read only) |
| `telemetry` | Projects, errors, latest event, logs, performance and usage; **mark an error** as resolved or ignored |
| `sales` | Readiness, channels, offers, leads, board and funnel report |
| `agents` | Agents, catalog, tools, budget, runs and pending actions; **stop** a run; knowledge base sources, usage and sync selection, and **try a search** in it (charged per search) |
| `scheduling` | Calendar, visits, free slots, advisors and booking links; **book, move, reassign, complete and cancel** a visit; **get** the booking link of a record or an offer's own link (without revoking the current one) |
| `social` | Settings, portfolios, connected accounts, posts, calendar, comments, analytics and approvals; **create and edit** a draft, **schedule** (or send for approval), **move** and **cancel** a post |
| `tasks` | Tasks, subtasks, the available-subtasks inbox and files; **create, edit and assign** tasks, **create** subtasks and **take or complete** a subtask |
| `studio` | Creative studio template catalog, orders, delivered pieces and their links, debts and presenters (read only) |
| `prospecting` | Goals, readiness, funnel, metrics and prospect list **without contact data**; **add** and **import** prospects (the MCP never approves or sends messages) |
| `coupons` | Coupons of the workspace and its stores: list, view and export a batch as CSV; **create** a workspace coupon and **edit** it (pause, reactivate or archive) |
| `data` | Data catalog, queries over your own copies (merchants, charges, transactions, funnel, invoices, your stores' sales) and the list of dashboards (read-only: the MCP creates no dashboards and no deliveries) |

All toolsets are listed by default. For a client that supports few tools, pick the verticals you use:
`ONEPLATFORM_TOOLSETS=payments,shipping` (local) or the `X-OnePlatform-Toolsets: payments,shipping` header (hosted).
`all` lists everything. The Spanish names used up to 0.3.0 (`cuenta`, `pagos`, `envios`…) are still accepted as
aliases.

Writes (in bold) do not charge balance on the spot, do not issue tax documents and do not move money, and the
client asks for confirmation before running them. Three known exceptions, the same as in the dashboard: booking,
moving or cancelling a visit sends the scheduling notices to the person and the advisor, scheduling a post
queues it to go out on the network on the chosen date, when it is charged (cancelling it before costs nothing), and
a knowledge base search (`searchKnowledge`) charges one search from the balance on every call, also when nothing is
found (US$0.02 at the time of writing; the tool description states it).
Publishing right away, approving, replying to comments, ordering studio pieces and paying stay outside the MCP. In
`prospecting`, approving, sending, marking as sent, changing the mode, handing over to sales, excluding companies
and reading contact data also stay outside: drafts are reviewed by a person in the dashboard. In `coupons`, balance
redemption, the stores' redemption protocol, batch issuance and creating a store coupon (which may charge its fee)
stay outside; a store's coupons can be read but are edited only in the dashboard. In the knowledge base, uploading, reindexing and deleting a source (indexing is
charged and deleting does not refund it) and changing which FAQs and sites stay in sync also stay outside. In `social` the tools work on the
person's own portfolio: the MCP does not forward the header to act on someone else's portfolio. The exact list is in
[`tools.manifest.json`](tools.manifest.json) and what can never be exposed, in [`denylist.json`](denylist.json):
administration, credentials, webhooks, charges, tax issuance and money movements. Payouts and domains are read only.

“Resend link” (`sendPaymentLinkAgain`, VD-30) is explicitly excluded: it emails a customer and needs a person's
action in the dashboard. The `data` toolset only keeps reads. The idempotent creation of the starter dashboard
(`initializeDataDashboard`) is excluded too: listing dashboards from the MCP does not create the starter dashboard
or its seed mark. `queryData.time_field` can query by creation date (`created_date`) or payment date (`paid_date`)
when the dataset's catalog allows it; it keeps `local_date` by default for existing dashboards.

## Local use (stdio)

```bash
ONEPLATFORM_APP_KEY=ak-XXXX… ONEPLATFORM_USER_KEY=sk-XXXX… npx -y @oneplatformlabs/mcp
```

| Variable | Value |
|---|---|
| `ONEPLATFORM_APP_KEY` | App key (`ak-…`). Optional: without keys only the documentation tools are available |
| `ONEPLATFORM_USER_KEY` | User key (`sk-…`) |
| `ONEPLATFORM_ENV` | `qa` (default) or `prod` |
| `ONEPLATFORM_TOOLSETS` | Optional: comma-separated verticals to list (default: all) |

Per-client setup: https://developer.1platform.pro/docs/saas/1platform-api/integrar-con-ia

## Hosted use (HTTP)

`node dist/cli.js --http` serves stateless Streamable HTTP on `POST /mcp` and `GET /healthz`. Keys arrive in
`X-OnePlatform-App-Key` and `X-OnePlatform-User-Key` on every request; the environment is set by `ONEPLATFORM_ENV` at
startup. Limits: 30 requests per minute per IP, 120 per key pair and 256 KiB per body.

| URL | API |
|---|---|
| `https://mcp-qa.1platform.pro/mcp` | QA |
| `https://mcp.1platform.pro/mcp` | Production |

The URL decides the environment; no header or parameter changes it.

```bash
claude mcp add --transport http oneplatform https://mcp-qa.1platform.pro/mcp \
  --header "X-OnePlatform-App-Key: $ONEPLATFORM_APP_KEY" \
  --header "X-OnePlatform-User-Key: $ONEPLATFORM_USER_KEY"
```

### Deployment

| Variable | Value |
|---|---|
| `ONEPLATFORM_API_URL` | Internal API URL of the same environment (`http(s)://host[:port]/api/v1`). Without it, the public one |
| `MCP_TRUSTED_PROXY_CIDRS` | Trusted public hops in addition to the private ones (`["185.125.168.236/32"]`). An invalid entry, or one wider than /16 (IPv4) or /32 (IPv6), stops the process |

The client IP is resolved behind Cloudflare and the front door with a port of the API's resolver
([`src/http/client-address.ts`](src/http/client-address.ts), shared vectors in
[`test/vectors/client-address.json`](test/vectors/client-address.json)). That IP rate-limits the client in the MCP
and travels to the API as the only `X-Forwarded-For` entry, written anew and never copied from the request: the
container calls the API over the private Docker network, so the API counts one bucket per client.

That network is `mcp-net-{qa,prod}`: the Core compose creates it with an explicit subnet and only the API and this
container are on it (until #6 the MCP shared the telemetry engine's network). That is why the Core deploys first:
without the network, `up` fails and the deploy goes back to the previous image. An old Core branch on QA takes the
API off the network until it brings in `main`.

`deploy/compose.{qa,prod}.yml` and [`deploy/remote-deploy.sh`](deploy/remote-deploy.sh) (forced command of the deploy
key: `<qa|prod> <main sha>` or `<qa|prod> rollback`); the `Deploy hosted MCP` workflow deploys QA and then production
on every push to `main` when the `MCP_DEPLOY_ENABLED` variable is `true`.

## Documentation freshness

The documentation tools read the `llms.txt`, the Markdown pages and the OpenAPI published by the portal, with a
ten-minute cache. The portal must publish its updated contract for `api_get_operation` to return it; reinstalling the
MCP package does not fix an outdated specification on the portal.

`npm run check:docs-freshness` compares the portal's paths, operations, schemas and authentication with the live
API. It fails on differences or download errors, with no silent fallback; each download has 120 s and a single retry
on a network error or timeout (not on an HTTP error). It ignores prose and sanitized examples; it does not replace
editorial review. It no longer runs in GitHub Actions: run it locally (`/local-checks`, `npm run check:docs-freshness`).
To verify a candidate portal, set `ONEPLATFORM_DOCS_OPENAPI_URL` to its OpenAPI; for a local bench you can also set
`ONEP_API_OPENAPI_URL`. Those URLs are never printed.

Tool generation (`fetch-openapi` and `check:tools`) uses the API's public OpenAPI directly, so an outdated copy on
the portal cannot hide changes to the executable tools. The allowlist, the toolsets and the write limits stay in
`tools.manifest.json` and `denylist.json`.
