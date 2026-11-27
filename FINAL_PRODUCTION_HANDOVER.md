# Kirana production handover

**Status on 27 November 2026, IST**

Mapbox deployed to the merchant site. Public checkout, live payment initiation and live refunds remain disabled.

The candidate keeps the rider layout approved on localhost and uses authenticated assignments, saved customer pins, store coordinates, live GPS and real order transitions. It replaces Geoapify in the candidate with Mapbox Matrix, Directions and Static Tiles. The browser holds the current trip geometry and processes GPS progress, camera location and maneuver changes locally. Foreground assignment checks return a compact unchanged response when the snapshot version matches. The customer address picker uses the same road map and saves a pin only after an explicit choice or device location.

Cloudflare is serving commit `957bd53` on the [storefront](https://blink-it.pages.dev/), [owner](https://blink-it.pages.dev/owner) and [rider](https://blink-it.pages.dev/rider) URLs. Pages deployment `c8c80e87-f58d-4285-93c9-31b326c85560` is bound to merchant Worker version `cc079ff4-6a3f-42d0-a9ed-8141ba28601d` at 100% traffic. Live checks verified all three pages, the new rider asset, Google sign-in availability, rider API authorization and the absence of the demo sign-in endpoint. The tile token accepted the live site origin and rejected a request without that origin. The separate server token passed Directions and Matrix requests. The Worker secrets were saved through the Cloudflare version upload. There were zero active assigned deliveries during verification. The rider page shows the store map when the assignment queue is empty.

Rollback checkpoints are Pages deployment `d1ff1272-a44c-4316-97e0-054802858f9a` and Worker version `105888ed-6cef-4ae5-954f-d6babdc04138`. The merchant and frozen benchmark Workers use disjoint D1 bindings. Deployment required no D1 migration or business-record writes.

## Evidence and open acceptance

| Area | Verified in isolated acceptance | Remaining hosted or merchant verification |
| --- | --- | --- |
| Catalog and settings | Owner catalog, categories, prices, images, variants, stock, branding and fulfillment controls covered by regressions. Storefront revalidation and immutable purchased prices verified. | Owner-led check against the merchant catalog and business settings. |
| Customer and rider | Three synthetic customers placed COD orders at distinct delivery pins. The owner prepared and assigned them. Live Mapbox optimized the route and rendered it in Android Chromium and iPhone WebKit emulation. iPhone WebKit verified that opening the address map waited for explicit pin selection. Android exercised GPS updates, recentering, pickup and all three COD completions. Customer and owner status matched, rider contact access closed after delivery, and the reserved stock ended at the expected quantity. | Fresh end-to-end hosted role sign-in and delivery with real assigned orders. Physical Android and iPhone GPS, permission and interrupted network checks. |
| Maps and credentials | The authorized account’s existing public token was used for isolated acceptance. The candidate’s backend uses a fixed provider host, actor-scoped order IDs, bounded coordinates, token separation in hosted builds and separate quotas. The browser requests tiles directly, with required Mapbox attribution. Tests cover unreachable stops, authorization, quota exhaustion and provider redirects. | Monitor account usage and complete authenticated production map verification on a physical phone. |
| Inventory and POS | Tests cover contention for the final available stock, stock restoration, idempotency, simultaneous checkout and price edits, selected SKU quantities and historical invoices. The 5,000-SKU local workload completed 800 online orders and 300 counter sales. | Reconcile the frozen hosted run and measure the final hosted revision. |
| Payments | Existing Standard Checkout and webhook fixtures cover signatures, exact amounts, duplicate delivery, interrupted sessions, late captures, refund review and COD reconciliation. | Post-rotation private UPI capture and authentic webhook check with express transaction authorization. Keep public checkout and live refunds disabled until commercial approval. |
| Production cleanup | The deployed bundle excludes demo auth, QA Worker entrypoints and seed migrations. Rider simulation controls and Geoapify requests are absent from the deployed code. Test fixtures remain in the repository. | Back up the actual merchant database and classify records before any removal. Preserve records of uncertain origin. A read-only merchant D1 audit found zero seeded demo accounts, orders tied to those IDs, benchmark SKUs and mock payment rows. Sixteen active catalog products matched the staging seed. The only other catalog product was inactive. The seed-matched products are referenced by 11 order lines and 11 stock-history rows. Seven of those order lines belong to open orders, so the catalog and the related order records were preserved. The prior Geoapify credential remains available for rollback. |

The candidate passed **55 regression tests**, type checking, the production asset build, D1 query-plan checks and production release packaging. Run `testing/mapbox-acceptance.mjs` with the isolated Mapbox credentials and Playwright to reproduce the live map check.

## Performance and free-tier budget

- The local mixed workload recorded **24,989 requests**, **139.94 ms p95**, **162.66 ms peak p95**, **447,254 D1 rows read**, **63,736 rows written**, **67.13 seconds aggregate workerd CPU** and zero errors. The run included 60 delivery lifecycles. It did not fetch Mapbox routes. Aggregate workerd CPU is a local process measurement.
- The live isolated three-stop Mapbox plan contained **249 road points**, **7,041 bytes of route JSON** and **7.68 km of road geometry**. The GPS and COD workflow reused it across three stops. The two cold plans took **88 ms and 718 ms** in browser end-to-end measurements. The requests reported **16 reads and 2 writes**, and **14 reads and 4 writes**, respectively. The two trip plans reserved **24 Matrix elements and two Directions requests**. One captured iPhone tile was **83,597 bytes** and five Android tiles totalled **376,822 bytes**. These are partial tile samples. Hosted per-invocation CPU and hosted p95 for this revision remain unmeasured.
- Workers Free lists **100,000 requests per day** and **10 ms HTTP CPU per invocation**. D1 Free lists **5 million reads** and **100,000 writes per day**, account-wide. Keep the existing **90,000-write safety ceiling** on hosted benchmarks and the **500 ms mixed-workload p95** target. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- Mapbox lists **100,000 Matrix elements**, **100,000 Directions requests** and **200,000 Static Tiles** per month in its free allowances. This installation reserves up to 2,500 Matrix elements, 2,500 Directions requests and 5,200 Static Tiles each UTC day. Tiles are split between address and rider views. The bounds model this installation’s requests. Shared-account projects and requests made outside the app still count toward billed account usage. [Mapbox pricing](https://www.mapbox.com/pricing/) · [Matrix billing](https://docs.mapbox.com/api/navigation/matrix/) · [Static Tiles API](https://docs.mapbox.com/api/maps/static-tiles/)
- An eight-stop cold trip uses **72 Matrix elements and one Directions request**. At 2,500 Matrix elements per day, full eight-stop trips plus one six-stop trip model **278 deliveries before replanning or retries**, assuming the Matrix budget is otherwise unused. This is a provider operation model. Actual one-rider capacity depends on roads, pickup, handoff and working time.

## Frozen benchmark and rollout

The earlier hosted endurance candidate stopped at the account-wide write guard after **160 online and 55 counter sales**. Its subsequent continuation ended **partial** at **382 online and 144 counter sales**, with zero unexpected request errors. These results belong to the frozen hosted revision. The full **28 November 05:35 IST** benchmark is still scheduled against its isolated configuration.

The merchant-site rollout used the existing database identifiers and kept all three financial flags disabled. After the scheduled benchmark reaches a terminal result, compare this deployed revision against the same latency, stock and quota criteria using synthetic data in isolated acceptance. Complete the authenticated production smoke checks before retiring the old provider credential.

## Daily operating guide

**Owner:** Sign in with Google at **Owner**. Use **Store settings** for the store details, location, delivery radius, PIN codes, hours, fees and fulfillment switches. Use **Catalog & stock** for products, categories, images, variants, prices and stock. Use **Counter** for walk-in sales. In **Orders**, accept an order, start packing, mark it ready and assign delivery orders to the rider. Open the completed order to review the invoice and reconcile COD. Review sale totals, exceptions and low stock in **Overview**.

**Rider:** Sign in with the authorized Google account at **Rider**. Confirm pickup when you have the orders, enable foreground GPS, and follow the next turn. Use recenter after moving the map. At the customer, open **Complete delivery** and record the actual COD amount when due. The next assigned stop appears automatically. If a pin is missing, open the assigned order for its saved address and contact details. Stop safely before interacting with the screen, and follow traffic rules.

**Independent stores:** Use dedicated Pages and Worker names, business and media D1 bindings, and per-store secrets. The supported release generator starts new merchant databases with the store settings and empty business records. Follow the [deployment instructions](README.md).

## Access and launch decisions

1. Arrange physical Android and iPhone acceptance with the intended shop owner and rider Google identities.
2. Resolve the seven open order lines before replacing the seeded product listings with the actual catalog. Preserve the order and stock history.
3. Authorize a private post-rotation UPI payment separately from commercial launch.
4. Approve public checkout and live financial operations after the hosted, payment and device checks pass.
