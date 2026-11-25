# Neighbourhood Kirana

A local, single-store application built with React, TypeScript, Tailwind CSS, Hono, Wrangler and D1. Hyderabad is sample data. Store identity, delivery area, hours, fees, windows and capacity are editable in the owner workspace.

## Run or inspect

Use Node.js 22.12 or later, then run:

```sh
npm ci
npm run dev
```

| Workspace | URL | Demo sign-in |
|---|---|---|
| Customer | http://127.0.0.1:8787/ | **Sign in → Continue as demo customer** |
| Store owner | http://127.0.0.1:8787/owner | **Sign in as owner → Continue as demo owner** |
| Delivery partner | http://127.0.0.1:8787/rider | **Sign in as rider → Continue as demo rider** |

Use different browser profiles if you want to keep multiple role sessions open simultaneously. The standard launch binds to loopback and uses local state under `.wrangler/state`. No API token is required.

### Try a complete order

1. Add a product as the demo customer. Choose a pickup slot or home delivery to the saved demo address. Select cash or online test payment. For an online order, use the on-screen simulator.
2. In **Owner → Orders**, accept, pack and mark the order ready. Collect pickup orders in the owner workspace. For delivery, assign the active rider.
3. In **Rider**, open the stop, confirm pickup, then record delivery or failure. For cash, enter the order total. The owner can then reconcile collection.
4. Reopen the order as the customer for the timeline, bill and support options. Use **Owner → Counter sales** to exercise the same stock checks for walk-ins.

## Local functionality

- Storefront categories, weighted products, indexed search with regional aliases, basket, saved addresses, delivery eligibility, pickup and delivery windows, idempotent checkout, local payment simulator, order history, jsPDF bills and customer support requests.
- Owner catalog, CSV batch import and displayed-row export, image upload/replacement/removal, stock receipts and adjustments, expiry/low-stock alerts, counter sales, order preparation, shortage reporting, configured windows and capacity, store settings wizard, staff and one active rider, refund and reconciliation records, and sales reports.
- Rider assignment, manual route sequence and local distance-based suggestions, separate pickup/delivery status, failure reasons, cash confirmation and collection summary. OpenStreetMap navigation is a user-initiated link. The local Leaflet pin editor uses coordinates and no live tile service.
- Installable PWA shell and in-app order notices. Browser notification preview is local. No Google identity, Razorpay capture/refund, deployed Pages image publisher, hosted routing or remote Web Push delivery is active.
- D1 batches and triggers guard stock, pricing, cumulative capacity, refund limits and, for accepted checkouts, server-calculated totals. Account and order scopes are checked on the server. Scheduled cleanup expires pending local mock payments and eligible sessions, abandoned carts, invites, notices and retired media. Required order, financial and dispute data remains durable.

Item shortages generate an audited customer notice; the owner can contact the shopper or cancel and refund. The local workflow does not silently substitute products or partially reprice an accepted basket. The encrypted export utility supports merchant-held backups; automated long-horizon cloud archival and merchant-specific invoice compliance require hosted validation.

## Verify locally

```sh
npm run check
npm run build
npm test
npm run test:plans
npm run benchmark -- 800
npm run benchmark -- 1000
npm run benchmark -- 1500
```

Each measured run used a disposable local Wrangler and D1 instance with 5,000 SKUs, 300 counter sales and 60 home deliveries. The workload modeled 24 browse requests per shopping session and 32 concurrent shoppers during the compressed peak, followed by 16. Local D1 operation counts come from query metadata. HTTP latency includes local networking, server work and response parsing.

| Online orders | HTTP calls | p50 / p95 / p99 (ms) | Peak p95 / p99 (ms) | D1 rows read / written | Errors |
|---:|---:|---:|---:|---:|---:|
| 800 | 24,989 | 75.67 / 160.01 / 201.85 | 186.26 / 227.49 | 406,095 / 70,523 | 0 |
| 1,000 | 31,056 | 63.01 / 129.86 / 162.24 | 148.25 / 253.30 | 559,602 / 85,326 | 0 |
| 1,500 | 46,222 | 58.26 / 127.84 / 161.33 | 156.10 / 201.81 | 1,046,468 / 122,320 | 0 |

| Online orders | Wall time (s) | Local workerd CPU (s) | Peak local workerd RSS (MiB) | Business DB growth | D1 statements |
|---:|---:|---:|---:|---:|---:|
| 800 | 53.36 | 72.60 | 1,485.2 | +3.98 MB | 57,168 |
| 1,000 | 55.83 | 76.33 | 1,796.7 | +4.80 MB | 70,169 |
| 1,500 | 78.66 | 107.17 | 1,802.5 | +6.84 MB | 102,667 |

Workerd CPU and RSS describe the local emulator process group. Cloudflare Worker isolate CPU, overhead and usage still need hosted measurement. The target run's metered requests, reads and writes fit the published daily free allowances. The 1,500-order stress run exceeded the daily D1 write allowance. The target fixture added 3.98 MB per day of simulated business data. At a constant rate, an initially small database would approach the 500 MB D1 Free per-database limit in roughly four months. Actual basket size, history, indexes, retention and maintenance will affect that estimate. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Thirteen automated tests cover authorization, production exclusion of mock routes, search, shared-stock and slot races, payment replay after a dropped response, refunds, cash reconciliation, scheduled cleanup, and backup and archive recovery. The query-plan check covers 28 production query shapes using a 5,000-SKU and 20,000-order fixture. REA Chromium scenarios exercised desktop and 360/390 px mobile viewports, including guest pickup checkout, owner catalog and cash delivery. Physical device, Safari, PWA installation and hosted checks remain.

## Prepare another installation

Copy `deployment/store.example.json` outside source control and fill its non-secret store metadata and resource IDs. Build and run:

```sh
npm run release:prepare -- deployment/store.example.json /absolute/path/to/empty-review-directory
```

This command generates local Pages and Worker review files, dedicated D1 bindings, a bootstrap statement that preserves existing settings, and a release manifest. It excludes the demo catalog seed and disables mocks and order acceptance in the generated production configuration. The future verification workflow is in `.github/workflows/verify.yml`; it only runs local checks. External provisioning, provider credentials, live payments, any remote push and public release are approval-gated.

For an encrypted local backup, export a local D1 database to a protected file, then use `node tools/merchant-backup.mjs encrypt INPUT OUTPUT`. The passphrase comes from stdin. Restore to a separate local file with the corresponding `decrypt` command and verify it before use. The utility refuses to overwrite a destination and rejects a wrong passphrase or modified ciphertext. Store the merchant passphrase separately from the encrypted backup.

For a settled-order archive from a private local SQLite snapshot, run `node tools/archive-local.mjs LOCAL_SQLITE NEW_ARCHIVE CUTOFF_UNIX_SECONDS`. The export preserves order, item, ledger, timeline, support, refund and matching audit records and writes a SHA-256 trailer. Encrypt the export with the backup utility. The SQLite source remains intact, and a separate full database backup is required for restoration. Hosted archive scheduling, retention and verified recovery remain production gates.

## Artwork

Built-in ImageGen created the images used in `public/catalog/`. The product brief was a warm off-white, sixteen-cell standalone grocery photo sheet for tomatoes, onions, bananas, coriander, milk, eggs, bread, paneer, rice, dal, atta, oranges, potatoes, tea, cleaning spray and chips. The hero brief was a landscape editorial still life of a cream grocery tote spilling tomatoes, greens, peppers, citrus, carrots and bread on a golden tabletop, with empty space at left for the storefront text. The app uses optimized WebP derivatives.

## Deploy a staging store

Use separate Pages, Workers and D1 resources for each store. Copy `deployment/store.example.json` into an untracked configuration file, set the dedicated resource names and IDs, and optionally add `googleOrigin` with the exact HTTPS storefront origin. Keep `accepting` and `enable_online` at zero. Create the two dedicated D1 databases and a Direct Upload Pages project once. Name the store slug and Pages project with a `-staging` suffix. Build and deploy future staging releases with `npm run deploy:staging -- STORE_JSON`. Add `--dry-run` for a local build and Worker bundle without a remote mutation.

For a manual release, generate the bundle with `npm run build` followed by `npm run release:prepare -- STORE_JSON EMPTY_RELEASE_DIR staging`. Use Wrangler in the generated Worker directory with access to the project's installed Node dependencies. Apply the migrations to `DB` and `MEDIA` with `wrangler d1 migrations apply BINDING --remote`, initialize `DB` with `initialize-store.sql`, and run `wrangler deploy`. For a new demonstration database only, `deployment/staging-catalog.sql` optionally imports synthetic products and categories. Run `wrangler pages deploy dist --project-name YOUR_PAGES_PROJECT --branch main` from the generated Pages directory. The Pages Function forwards API and media requests over a service binding. Keep the public Worker route disabled.

In Google Cloud, create a Web application OAuth client with the redirect URI `STOREFRONT_ORIGIN/api/auth/google/callback`, and add staging test users to the consent screen. Provision `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OWNER_EMAILS` and `GOOGLE_RIDER_EMAIL` as secrets on the dedicated Worker. The elevated allowlists accept Google-owned Gmail or Google Workspace identities. Use `/owner` and `/rider` directly. Verify sign-in and role boundaries before allowing test accounts to use the store. [Google Web Server OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server).

Staging compiles the production entrypoint, excludes the demo seed and mock routes, and disables online checkout at the API. For an update, use the same store configuration, apply additive migrations, keep the previous deployment available for rollback, and smoke-test the Pages and API endpoints. Avoid rerunning the demonstration import on a working merchant store.
