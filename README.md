# Neighbourhood Kirana

A local, single-store application built with React, TypeScript, Tailwind CSS, Hono, Wrangler and D1. Hyderabad is sample data. Store identity, delivery area, hours, fees, windows and capacity are editable in the owner workspace.

## Run or inspect

Use Node.js 24 or later, then run:

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

## Fulfillment availability

In **Store settings → Delivery & pickup**, enable home delivery and store pickup independently. The master **Accept online orders** switch overrides both. With both methods disabled, the shop remains browsable and baskets stay available. The API and D1 enforce each setting for new orders while existing orders, pending payments, refunds, inventory operations and counter sales continue.

## Local functionality

- Storefront categories, weighted products, indexed search with regional aliases, basket, saved addresses, delivery eligibility, pickup and delivery windows, idempotent checkout, local payment simulator, order history, jsPDF bills and customer support requests.
- Owner catalog, CSV batch import and displayed-row export, image upload/replacement/removal, stock receipts and adjustments, expiry/low-stock alerts, counter sales, order preparation, shortage reporting, configured windows and capacity, store settings wizard, staff and one active rider, refund and reconciliation records, and sales reports.
- Rider assignment, Mapbox road routes, foreground GPS guidance, manual stop ordering, delivery status, failure reasons and COD confirmation. The address editor lets a signed-in customer place a pin on the map or use their current location.
- Installable PWA shell and in-app order notices. Local mode previews notifications. Staging supports Pages image publishing and configured Web Push. Merchant Google identity and Razorpay Standard Checkout require provider configuration.
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

Automated tests cover authorization, production exclusion of mock routes, search, shared-stock and slot races, payment replay after a dropped response, refunds, cash reconciliation, scheduled cleanup, and backup and archive recovery. The query-plan check covers 28 production query shapes using a 5,000-SKU and 20,000-order fixture. REA Chromium scenarios exercised desktop and 360/390 px mobile viewports, including guest pickup checkout, owner catalog and cash delivery. Physical device, Safari, PWA installation and hosted checks remain.

## Prepare another installation

Copy `deployment/store.example.json` outside source control and fill its non-secret store metadata and resource IDs. Build and run:

```sh
npm run release:prepare -- deployment/store.example.json /absolute/path/to/empty-review-directory
```

This command generates local Pages and Worker review files, dedicated D1 bindings, a bootstrap statement that preserves existing settings, and a release manifest. It excludes the demo catalog seed and disables mocks and order acceptance in the generated production configuration. The future verification workflow is in `.github/workflows/verify.yml`; it only runs local checks. The staging deploy command updates only the dedicated resources in the store manifest. Commercial launch and live payments require separate approval.

For an encrypted local backup, export a local D1 database to a protected file, then use `node tools/merchant-backup.mjs encrypt INPUT OUTPUT`. The passphrase comes from stdin. Restore to a separate local file with the corresponding `decrypt` command and verify it before use. The utility refuses to overwrite a destination and rejects a wrong passphrase or modified ciphertext. Store the merchant passphrase separately from the encrypted backup.

For a settled-order archive from a private local SQLite snapshot, run `node tools/archive-local.mjs LOCAL_SQLITE NEW_ARCHIVE CUTOFF_UNIX_SECONDS`. The export preserves order, item, ledger, timeline, support, refund and matching audit records and writes a SHA-256 trailer. Encrypt the export with the backup utility. The SQLite source remains intact, and a separate full database backup is required for restoration. Hosted archive scheduling, retention and verified recovery remain production gates.

## Artwork

Built-in ImageGen created the images used in `public/catalog/`. The product brief was a warm off-white, sixteen-cell standalone grocery photo sheet for tomatoes, onions, bananas, coriander, milk, eggs, bread, paneer, rice, dal, atta, oranges, potatoes, tea, cleaning spray and chips. The hero brief was a landscape editorial still life of a cream grocery tote spilling tomatoes, greens, peppers, citrus, carrots and bread on a golden tabletop, with empty space at left for the storefront text. The app uses optimized WebP derivatives.

## Deploy a staging store

Use separate Pages, Workers and D1 resources for each store. Copy `deployment/store.example.json` into an untracked configuration file, set the dedicated resource names and IDs, and optionally add `googleOrigin` with the exact HTTPS storefront origin. Keep `accepting` and `enable_online` at zero. Create the two dedicated D1 databases and a Direct Upload Pages project once. Use a `-staging` suffix for the store slug. A shorter Pages project name is supported when `googleOrigin` matches its exact HTTPS Pages hostname. The current preview is at [blink-it.pages.dev](https://blink-it.pages.dev/). Build and deploy future staging releases with `npm run deploy:staging -- STORE_JSON`. Add `--dry-run` for a local build and Worker bundle without a remote mutation.

For a manual release, generate the bundle with `npm run build` followed by `npm run release:prepare -- STORE_JSON EMPTY_RELEASE_DIR staging`. Use Wrangler in the generated Worker directory with access to the project's installed Node dependencies. Apply the migrations to `DB` and `MEDIA` with `wrangler d1 migrations apply BINDING --remote`, initialize `DB` with `initialize-store.sql`, and run `wrangler deploy`. For a new demonstration database only, `deployment/staging-catalog.sql` optionally imports synthetic products and categories. Run `wrangler pages deploy dist --project-name YOUR_PAGES_PROJECT --branch main` from the generated Pages directory. The Pages Function forwards API and media requests over a service binding. Keep the public Worker route disabled.

### Staging provider configuration

Add the following values on the **`kirana-blink-it-staging-api` Worker** in Cloudflare → Settings → Variables and Secrets. Independent deployments use their own `<store-slug>-api` Worker. Pages receives the Worker service binding, with credentials held on the Worker.

| Name | Type | Value |
| --- | --- | --- |
| `GOOGLE_ORIGIN` | Public deployment variable | `https://blink-it.pages.dev`. Set `googleOrigin` in the store manifest. |
| `GOOGLE_CLIENT_ID` | Worker secret | Web OAuth client ID from Google Cloud. |
| `GOOGLE_CLIENT_SECRET` | Worker secret | Secret for the same web OAuth client. |
| `GOOGLE_OWNER_EMAILS` | Worker secret | Comma-separated allowed owner Gmail or Google Workspace addresses. |
| `GOOGLE_RIDER_EMAIL` | Optional Worker secret | Allowed Google address for the rider, or issue an email-bound invitation from the owner dashboard. |
| `RAZORPAY_KEY_ID` | Worker secret | Razorpay key ID matching `razorpayMode`. Use a freshly generated key for Live Mode. |
| `RAZORPAY_KEY_SECRET` | Worker secret | Secret for the same Razorpay key. |
| `RAZORPAY_WEBHOOK_SECRET` | Worker secret | Independent signing secret for the webhook in the same Razorpay mode. |
| `RAZORPAY_UPI_CONFIG_ID` | Worker secret | Razorpay Live Checkout Payment Configuration ID for a UPI-only configuration, beginning with `config_`. |
| `MAPBOX_ROUTING_TOKEN` | Worker secret | Dedicated least-privilege access token for the Worker’s Matrix and Directions requests. |
| `MAPBOX_TILE_TOKEN` | Worker secret | Dedicated `pk` token for Static Tiles. Limit scopes and allow only this merchant’s web origins. The authorized browser receives this public token at runtime. |
| `STAGING_CHECKOUT_EMAILS` | Optional Worker secret | Comma-separated Google addresses authorized for private staging checkout. Leave unset until verification is approved. |

1. In Google Auth Platform, configure the consent screen, add intended test users while the app is in Testing, and create a **Web application** client. Add `https://blink-it.pages.dev` as an authorized JavaScript origin and `https://blink-it.pages.dev/api/auth/google/callback` as the authorized redirect URI. After Google verifies the identity, the Worker sends owners and invited staff to `/owner`, the authorized rider to `/rider`, and customers to the storefront. Issue team invitations from that store's owner dashboard. Sign out and back in with Google to pick up a newly configured role. [Google OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server)
2. In Razorpay **Account & Settings → Business website detail**, confirm the storefront is approved. Under **Capture and refund settings**, confirm automatic capture. Under **Checkout settings → Payment Configuration**, create a dedicated configuration with UPI enabled and cards, EMI, netbanking and wallets disabled. Save it and re-open it to confirm the switches persisted. If creation selected it as the merchant default, restore the previous default through **Save as default → Save all changes**. Save the dedicated configuration ID as `RAZORPAY_UPI_CONFIG_ID`. The Worker passes this ID to Razorpay when it creates an order, and the storefront independently requests the UPI-only display. [Razorpay payment configuration](https://razorpay.com/blog/checkout-payment-configuration-razorpay/) · [Cloudflare Free Services terms](https://www.cloudflare.com/terms/)
3. Provision two distinct Mapbox tokens for the store and configure them as Worker secrets. Use an origin-restricted public tile token with `styles:tiles`. Use a separate token for server-side routing. Verify three assigned delivery orders in isolated acceptance before switching hosted traffic. [Mapbox token management](https://docs.mapbox.com/accounts/guides/tokens/)

Staging uses the production entrypoint with demo authentication and mock payment routes excluded. `razorpayMode` selects the key type. `publicCheckout`, `razorpayLiveCheckout` and `razorpayLiveRefunds` are separate manifest booleans and default to false. Leave all three false for the current deployment. The webhook and already-created order verification can run while collection is off. After approval for a private live checkout test, keep `publicCheckout` false, add only the approved staging test shopper to `STAGING_CHECKOUT_EMAILS`, enable `razorpayLiveCheckout` and switch on the intended fulfillment/payment options in Store Settings. Changing the allowlist invalidates existing checkout grants. Staging never supports public ordering. A production deployment requires explicitly enabling `publicCheckout`.

### Manual acceptance sequence

1. In the existing Google Cloud project, confirm the Web application client allows `https://blink-it.pages.dev/api/auth/google/callback`. Keep the project External and Testing. On Audience → Test users → Add users, save the intended accounts if needed. Google documents a test-user exception for the app's basic identity scopes. The test-user list does not configure Cloudflare or grant Kirana roles. [Google Audience documentation](https://support.google.com/cloud/answer/15549945)
2. In Cloudflare Workers & Pages → `kirana-blink-it-staging-api` → Settings → Variables and Secrets, save the rotated `GOOGLE_CLIENT_SECRET` as a **Secret**. Keep `GOOGLE_ORIGIN=https://blink-it.pages.dev`. Save the owner allowlist and either set the confirmed `GOOGLE_RIDER_EMAIL` or issue an owner invitation. Refresh `https://blink-it.pages.dev/api/auth/google/status` and expect `{"enabled":true}`. Verify actual sign-in from the storefront, `/owner`, and `/rider` with three separate accounts.
3. Set `STAGING_CHECKOUT_EMAILS` to the authorized shopper and sign out and back in as that shopper. In **Store Settings → Delivery & Pickup**, enable the desired fulfillment methods and enable **Accept online orders** and **Enable cash payments**. Complete a pickup and a home-delivery COD order. Check that an unlisted browser still sees online ordering closed.
4. Verify owner acceptance, packing and ready states. For home delivery, assign the rider and confirm cash collection and reconciliation. The rider can compare an automatic road route and a manually reordered route. Keep `PUBLIC_CHECKOUT` and `RAZORPAY_LIVE_REFUNDS` disabled throughout.
5. Rotate exposed credentials before opening live checkout. In Razorpay **Account & Settings → Business website detail → Regenerate Key**, obtain the new Live key pair and save it as the `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` Worker secrets. Open **Account & Settings → Webhooks → Edit** for `https://blink-it.pages.dev/api/webhooks/razorpay`, rotate its signing secret, and save the same value as `RAZORPAY_WEBHOOK_SECRET` on the Worker. Confirm the endpoint is enabled for `payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed` and `refund.failed`. Use a read-only Razorpay Orders API request for the merchant key and a signed no-op to check the deployed Worker before opening the payment modal. [Razorpay webhook verification](https://razorpay.com/docs/webhooks/validate-test/)
6. With public checkout and live refunds disabled, enable Live Checkout only for the approved private shopper. Open Standard Checkout and verify that only UPI is offered, then close the modal. For the separately authorized payment, confirm the order moves to **Order confirmed** after capture and appears in **My Orders** and the owner queue. Verify the actual Razorpay webhook delivery, tracking and invoice. Close the temporary live checkout gate when the acceptance session ends.

The owner can turn off either payment method independently. When both are off, the storefront can still be browsed and the counter can sell. The public launch switch on the Worker still requires separate authorization. For variants, assign the same **Variant group** to each related SKU. Use the stock dialog to compare stock available for sale with stock reserved for open orders.

For updates, reuse the existing manifest and preserve the preceding deployment for rollback. Keep demonstration imports out of existing merchant databases.

## Optional services and store maintenance

- **Images.** The owner uploads, replaces or removes product images from the dashboard. The storefront serves validated images immediately through Pages, using a dedicated capped D1 media binding while assets await static publication. Safari can send JPEG when the browser cannot encode WebP. The static publisher creates a dedicated Pages deployment and leaves the previous release in service if any source image is unavailable. Limits are 32 KiB per image, 300 uploads per UTC day, 6,500 retained versions and 192 MiB of image payloads.
- **Routing.** Riders get up to eight stops per trip, prioritized by delivery window and sequenced using directed Mapbox road costs. The browser keeps the active route and GPS progress in memory. Riders can use manual delivery and Google Maps when directions are unavailable. The Worker reserves separate UTC-day budgets of 2,500 Matrix elements, 2,500 Directions requests, 4,000 rider Static Tiles and 1,200 address Static Tiles. The browser requests tiles directly from Mapbox and uses provider caching. The budgets cover this installation’s application traffic. An account-wide usage limit or separate allocation is needed to control other Mapbox traffic. [Mapbox pricing](https://www.mapbox.com/pricing/) · [Static Tiles API](https://docs.mapbox.com/api/maps/static-tiles/)
- **Web Push.** Run `node tools/create-vapid.mjs PRIVATE_VAPID_FILE mailto:STORE_SUPPORT_EMAIL` and send that file to the dedicated Worker with `wrangler secret bulk`. Keep it outside the repository. Customers opt in individually. Push notifications contain no order details. The app limits sends, removes expired subscriptions and preserves its in-app notices.
- **Razorpay Standard Checkout.** The app reserves stock before creating a Razorpay Order. Razorpay uses the store order UUID as its unique receipt. A verified capture confirms the order. Payment failures preserve the reservation for retries. Abandoned reservations expire after 15 minutes and the scheduled sweep releases the stock and slot. Late captures create refund review jobs. Live refunds require an owner action for the specific job and a separate approval flag. The scheduler submits Test Mode jobs only. Provider failures stay visible for manual review. [Razorpay idempotent refunds](https://hdfcbank-collectnow-docs.razorpay.com/api/refunds/normal-refunds-idempotent/)

After selecting store details, create the dedicated staging resources with `npm run setup:staging -- STORE-staging PRIVATE_CONFIG --create`. Use `--dry-run` to review the intended resource names. Then run `npm run deploy:staging -- PRIVATE_CONFIG`. Measure provisioning time with the merchant's actual accounts and network.

For repeatable maintenance, keep the generated Worker configuration in a private directory on a merchant-controlled runner and schedule `node tools/maintenance.mjs PRIVATE_CONFIG GENERATED_WORKER_CONFIG PRIVATE_BACKUP_DIR` daily. Pass a merchant-held passphrase through stdin via the runner's secret mechanism. The command publishes a fully verified encrypted backup, exports a settled-order archive and promotes active product images to their Pages project. Add `--backup-only` for a backup that skips publication. Backups page through all eligible settled records and the authenticated archive file list is recorded in `verified.json`. The command records completed jobs by the shop's India calendar day and uses a local SQLite lock that releases on runner exit. Restart an interrupted run after its provider commands have exited. Review and retain backups outside that machine. The archive export preserves the live database. A bounded live-data retention and archive retrieval policy is still required before long-term operation at target volume. [Recovery procedure](testing/BACKUP_RECOVERY.md)

To retrieve a historical bill as the merchant holding the passphrase, run `node tools/backup-d1.mjs invoice SETTLED.ndjson.enc NEW_PRIVATE_INVOICE.json ORDER_ID` with the stdin secret. The command verifies the encrypted archive and checksum before exporting the billing snapshot, item lines and refunds.

To verify or recover a backup, run `node tools/backup-d1.mjs verify BACKUP.sql.enc NEW_PRIVATE_RESTORE_DIR` with the same stdin secret. The command authenticates the backup, restores it to a fresh SQLite file and checks integrity, foreign keys and business or media totals. To restore to Cloudflare, use a new empty D1 database, validate counts, revoke restored sessions and test recovery before switching any live binding.

The owner can check storage and optional-service usage from Overview. Run `node tools/quota-report.mjs ACCOUNT_ID WORKER_NAME` with a scoped Account Analytics Read token in `CLOUDFLARE_API_TOKEN` for the account-wide UTC-day metrics. Cloudflare telemetry can be delayed. The hosted benchmark uses a separate expiring bearer-gated Worker and dedicated synthetic D1 databases. Its seed tool requires a fresh quota report and budgets each batch. Run a full target workload after the 5,000-SKU fixture is complete and the account has enough new-day write headroom.

## Staging verification

- Hosted smoke completed 30 online orders and 12 counter sales with 180 synthetic SKUs and six concurrent shoppers. It handled 506 requests with zero errors, 160 / 335 / 392 ms p50 / p95 / p99, and 6,135 reads and 2,605 writes in D1 metadata. Cloudflare reported 8.85 ms p99 CPU on the separate synthetic Worker.
- The local 5,000-SKU test completed 800 online orders and 300 counter sales, using 396,876 reads and 63,736 writes. The prior local measurement was 70,523 writes. The optimized run handled 24,989 requests with zero errors and 59 / 128 / 154 ms p50 / p95 / p99.
- Hosted Pages image publication was verified by comparing original and served bytes. Verified recovery restored a staging media backup with two images and a separate D1 backup with 42 synthetic orders.
