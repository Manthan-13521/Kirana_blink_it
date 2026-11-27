# Rider navigation acceptance

This report preserves the earlier Geoapify preview evidence. See [FINAL_PRODUCTION_HANDOVER.md](../FINAL_PRODUCTION_HANDOVER.md) for the Mapbox production candidate.

The isolated preview used synthetic Hyderabad orders, local Wrangler and D1, and live Geoapify road, matrix and map tile responses. It did not use the hosted merchant database or the frozen hosted benchmark. The dates and benchmarks below concern this rider feature.

## Route fixtures

| Assigned locations | Trip sizes | Actual road distance | Route duration | Routing credits reserved | Cold tile credits reserved |
| ---: | --- | ---: | ---: | ---: | ---: |
| 3 | 3 | 9.8 km | 12 min | 15 | 1.5 |
| 5 | 5 | 18.6 km | 24 min | 35 | 0 |
| 10 | 8 + 2 | 28.6 km | 42 min | 88 | 2.75 |
| 20 | 8 + 8 + 4 | 50.0 km | 72 min | 184 | 0.75 |
| 45 | 8 + 8 + 8 + 8 + 8 + 5 | 106.1 km | 158 min | 435 | 2.5 |

These were successive fixture sizes in one local preview. Tile reuse across viewport visits reduced cold tile costs. The local resource ledger counts provider credits reserved by successful requests using Geoapify's published tariffs. The 45-location case produced 3,368 road vertices and 399 instructions. Its optimized road matrix estimate was 9,456 seconds compared with 13,197 seconds using the original within-trip order, a 28.4% reduction. The Routing API measured the drawn route separately. Times are driving estimates from the store to each trip's last stop and exclude service time, traffic guarantees and returns to the store.

## Credit projections for a full day

The app enforces 2,100 combined credits per UTC day, allocated as 1,500 for routing and 600 for cold tiles. The Free provider plan advertises 3,000 credits a day and 5 requests per second. The figures below assume one calculation per dispatch, a distinct delivery pin per order, up to eight stops per trip and 40 cold tiles per trip. The app uses manual pins and browser GPS. This version makes zero geocoding and autocomplete calls. Costs increase with extra replanning, new address APIs or wider map use. Cache hits reduce costs.

| Daily home deliveries | Trips | Routing | Cold map tiles | Geocoding and autocomplete | Combined |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 45 | 6 | 435 | 60 | 0 | 495 |
| 60 | 8 | 584 | 80 | 0 | 664 |
| 100 | 13 | 984 | 130 | 0 | 1,114 |
| 200 | 25 | 2,000 | 250 | 0 | 2,250 |
| 800 | 100 | 8,000 | 1,000 | 0 | 9,000 |

At these assumptions, the routing split permits up to 150 deliveries before retries, other routing or provider usage are considered. This is an API-budget estimate. Actual rider throughput depends on travel, handoff and store return time. The 800 daily online order target includes pickup and is separate from the home delivery estimate.

Leaflet was already in use, so no new mapping dependency was added. The Worker uses Geoapify's directed road matrix to solve the fastest within-trip visiting order and fetches geometry and instructions for that order. The synchronous Route Planner starts at 81 matrix credits for an eight-stop trip plus the store, before any additional routing call for directions. The chosen matrix plus directions costs 80 on a cold eight-stop trip. Map tiles are served through a rider-authenticated proxy with Geoapify and OpenStreetMap attribution and cache reuse. Route plans and matrices expire after 30 minutes. GPS updates remain in the browser. A confirmed route deviation or an explicit recalculation can send rounded rider coordinates. Plans requested from the rider’s GPS position are excluded from the persistent cache.

[Geoapify pricing](https://www.geoapify.com/pricing/) · [Route Matrix pricing](https://apidocs.geoapify.com/docs/routing/route-matrix/) · [Routing pricing](https://apidocs.geoapify.com/docs/routing/) · [Route Planner pricing](https://apidocs.geoapify.com/docs/route-planner) · [Map tiles and caching](https://www.geoapify.com/map-tiles/) · [Geoapify Free terms](https://www.geoapify.com/terms-and-conditions/)

## Browser acceptance and Cloudflare measurements

- macOS Safari displayed the interactive map, attribution, and real numbered road route. Pixel 7 Chromium and iPhone 15 WebKit emulation covered tile rendering and mobile layout. The latest fixture used 45 distinct pins sampled from verified road geometry.
- Chromium checked zoom, all-stop view, synthetic GPS, instruction progression from “Drive east” to “Turn left,” off-road detection, explicit GPS rerouting, moving a stop, and the Google Maps fallback. Completion reconciled ₹78 of synthetic COD with the invoice and reserved inventory. GPS samples and delivery completion made zero routing requests. A simulated routing quota response left the pins and fallback available. The GPS-origin plan was absent from the D1 cache.
- Across four successful final routing API calls, local Wrangler reported 112 reads and 15 writes. The first eight-stop cold calculation took 1.11 s end to end with 28 reads and 6 writes. GPS rerouting used 29 reads and 1 write. The manual seven-stop calculation used 26 reads and 3 writes. The latest workflow reserved 175 routing credits plus 4 tile credits. Across 20 observed successful tile requests, including cache hits, the local runtime recorded 126 reads and 20 writes. These are D1 rows, including local SQLite accounting for indexes. The one simulated HTTP 429 is excluded.
- The eight-stop optimizer alone measured 0.264 ms p95 across 500 local runs. The workerd process used 2.37 seconds of aggregate CPU for the final fixture run, including creating and dispatching the synthetic orders, browser navigation and fixture checks. Hosted per-invocation Worker CPU remains unmeasured.
- All 44 regression tests passed. Type checking, production asset build, SQLite query plans, and local release packaging passed. The D1 plan uses primary-key lookups for selected stops and the expiration index for cache cleanup. The npm production dependency audit reported zero advisories. A warm routing cache and warm tile access at the enforced cap passed targeted regression checks.
- The preview displays up to 60 active assignments at once, with further assignments appearing as stops are closed. GPS is foreground-only and requires permission. Physical phone GPS, hosted Worker CPU and edge cache behavior remain production acceptance checks. Apply migration 0023 before deploying the revised Worker, and confirm the Geoapify Free production terms for the merchant project.

[Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/) · [Geoapify terms](https://www.geoapify.com/terms-and-conditions/)

## Foreground navigation preview, 27 November 2026

- The local demo starts a disposable loopback Worker and database. With `GEOAPIFY_KEY` set, run `npm run demo:rider` for 45 synthetic deliveries. Build with `npm run build` and run `node testing/rider-navigation-demo.mjs 10` for a smaller case. The supported fixture sizes are 3, 5, 10, 20 and 45. In the dashboard, choose **Continue as demo rider**, then **Start simulation**. **Delivery options** contains the real GPS switch and Google Maps fallback.
- Public partner references informed the pickup and delivery workflow. Google Maps informed the next-instruction and recenter controls. The existing Leaflet raster renderer supports the chosen north-up camera and avoids adding a separate WebGL map dependency. [Blinkit](https://play.google.com/store/apps/details?id=app.blinkit.onboarding) · [Swiggy](https://play.google.com/store/apps/details?id=in.swiggy.deliveryapp) · [Zomato](https://play.google.com/store/apps/details?id=com.zomato.delivery) · [Google Maps](https://support.google.com/maps/answer/3273406) · [MapLibre](https://maplibre.org/maplibre-gl-js/docs/guides/leaflet-migration-guide/)
- Automated Android Chromium verified moving simulation, heading, changing instructions, zoom and recenter, navigation during a simulated network interruption, and synthetic COD completion followed by the next customer with zero routing calls. The eight-stop plan contained 667 road points. It used 80 reserved routing credits, a 17,518-byte JSON response and approximately 1.26 seconds on the local Worker. Three observed tile responses transferred 163,637 bytes of PNG payload. This tile sample was partial. A later 350-ms, 50-kB/s throttled run rendered its first road tile in 6.84 seconds.
- The separate GPS browser run verified the weak-signal message. It stopped before the permission-denial and end-to-end reroute checks after its next sample was rejected as a jump and the displayed fix expired. Unit checks cover jump and weak-fix rejection, arrival, confirmed deviation, and recovery.
- Live tracking requires geolocation permission and a foreground browser on a secure origin. The location watch stops when the page is hidden and restarts when shown. A locked screen or background tab can interrupt guidance. [W3C Geolocation](https://www.w3.org/TR/geolocation/)
- The isolated workspace passed all 54 regression tests, its production build, type check and D1 query-plan checks. A separate demo seeder smoke test created three ready deliveries. The hosted stress test and 05:35 IST benchmark were kept separate. Hosted acceptance, per-invocation Worker CPU, device-level GPS testing and a complete measurement of daily delivery capacity remain unverified.
