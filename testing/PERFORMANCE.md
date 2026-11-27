# Performance measurements

## Hosted latency phase isolation · 27 November 2026

Two controlled diagnostics compared identical requests to the synthetic Worker directly and through a temporary Pages service binding. The complete timing run returned HTTP 200 for all 680 requests. All observed edge codes were `BOM` (Mumbai). The D1 control reported an APAC primary. The probe used only synthetic data, made no writes and was removed after measurement. [Sanitized timing evidence](evidence/latency-phases-2026-11-27.json)

| Request and connection mode | Direct Worker p95 | Pages p95 |
| --- | ---: | ---: |
| Search, reused connection, serial | 128 ms | 144 ms |
| Search, new connection, serial | 196 ms | 267 ms |
| Search, 32 concurrent per wave, HTTP/2 pooling | 272 ms | 361 ms |
| Search, 32 concurrent per wave, every connection new | 1,424 ms | 976 ms |
| No-D1 health, 32 concurrent, HTTP/2 pooling | 142 ms | 175 ms |
| No-D1 health, 32 concurrent, every connection new | 826 ms | 888 ms |
| Product details, reused connection, serial | 118 ms | 138 ms |

- In serial Pages search, fresh DNS/TCP/TLS p95 were 4.1/27.3/39.1 ms, and connection readiness p95 was 68 ms. With 32 fresh connections, TCP establishment alone reached 799 ms p95 and search time to first byte was 974 ms. Search after connection readiness was 153 ms p95. The no-D1 health control also showed the TCP tail. This identifies connection establishment as the largest measured component of the fresh-connection tail on this path. It does not identify the underlying cause of that TCP delay or prove the cause of the entire earlier mixed workload.
- In the pooled Pages search bursts, D1 call wall time was 218 ms p95 and SQLite was 0.66 ms p95. The Pages-to-Worker binding wait including the Worker was 222 ms p95. The paired difference outside the measured Worker app was 6 ms p50 and 59 ms p95 in pooled waves, and 0 ms p50 and 11 ms p95 in serial reused requests. This difference includes the wrapper and scheduling. A serial Pages `SELECT 1` control measured 101 ms D1 wall p95 and 0.125 ms SQL p95. D1 wall includes service transit, database dispatch and returned results. Cloudflare did not expose their individual contribution or isolate scheduler queue time. The controlled period's sampled Worker CPU was 1.03 ms p50 and 6.81 ms p99 across 651 invocations, including simultaneous synthetic endurance traffic. Worker CPU and Cloudflare wall timing are separate measurements. [D1 timing fields](https://developers.cloudflare.com/d1/worker-api/return-object/) · [Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
- A reused serial search downloaded a 249-byte compressed response with under 1 ms p95 after first byte on Pages. In a 32-stream pooled wave, the after-first-byte phase reached 70 ms p95 even for 249 bytes, so this interval includes multiplexing and delivery effects. Local JSON serialization of the uncompressed 3,875-byte listing was 0.0058 ms p95 per operation across batch averages. The hosted Workers clock advances at I/O boundaries, so these headers cannot provide a standalone hosted serialization measurement. [Workers timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)
- The Pages probe observed a limited number of first requests in a new probe isolate. The baseline Worker stayed running, so no forced cold-versus-warm claim is made. Other Indian regions and carrier networks were unavailable for this comparison. Both benchmark and merchant D1 had read replication disabled. Cloudflare charges ordinary read and write usage for replication with no extra replica fee. Unconstrained reads can lag current inventory and prices, while `first-primary` retains the primary trip. No placement, routing or consistency settings changed. [D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/) · [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

The storefront already uses same-origin API requests, lazy product images, paginated listings, debounced search and visible-tab order polling. The startup trace exposed a separate browser delay: catalog and categories started only after store settings returned. The frontend now fetches all three concurrently, renders against the fetched store configuration and keeps quantity controls disabled until basket restoration finishes.

Five fresh Moto G4 Chromium contexts per build used the same 150 ms network latency, 200 KB/s down and 4× CPU slowdown. The median catalog start went from 226 ms after the store request started to 1 ms before it. First visible product cards improved from 1,973 to 1,413 ms median. LCP was 1,436 versus 1,428 ms median. The worst product-card sample was 2,592 ms after the change versus 2,094 ms before, with the slow candidate sample delayed before its API requests started. This lab result confirms removal of the dependency and a median improvement. The sample does not establish a mobile tail improvement or physical-device performance. [Deployment](https://d1ff1272.blink-it.pages.dev) · [Regression CI](https://github.com/Manthan-13521/Kirana_blink_it/actions/runs/45988013148)

## Catalog release comparison · 27 November 2026

Two baseline and two candidate runs used the same 5,000 synthetic SKUs, query mix, local client and six bursts each at 32 and 100 clients. Each run measured 792 browse, search and detail requests. No errors or D1 writes occurred. [Sanitized measurements](evidence/catalog-2026-11-27.json)

| Endpoint or metric | Baseline, two runs | Candidate, two runs |
| --- | ---: | ---: |
| Overall HTTP p95 | 706 / 813 ms | 748 / 697 ms |
| Search HTTP p95 at 32 clients | 781 / 780 ms | 764 / 696 ms |
| Search HTTP p95 at 100 clients | 785 / 1,759 ms | 706 / 697 ms |
| Detail HTTP p95 at 32 clients | 693 / 707 ms | 754 / 668 ms |
| Detail HTTP p95 at 100 clients | 256 / 1,672 ms | 736 / 696 ms |
| Total D1 statements per run | 1,056 | 792 |
| Total D1 rows read per run | 5,544 | 7,656 |

Search now resolves synonyms in the same D1 statement as the indexed result page. Variant details group their SQL reads into one D1 call. The search saves one trip per request and reads eight more D1 rows per search in this fixture. The comparison's aggregate p95 still exceeds 500 ms. On the candidate, aggregate D1 SQL p95 was 0.50–0.56 ms, D1 wall p95 was 172–182 ms and time to response headers closely followed full response latency. These measures use different boundaries. They suggest that SQL execution and body transfer contribute little to the tail. Connection setup, network path and platform queueing were not individually isolated. Baseline SQL telemetry was unavailable.

The public catalog always revalidates against current D1 data. An unchanged validator now returns 304 with zero body bytes, verified on hosted browsing, search and product variant routes. Stock, price and availability changes take effect on the next request. Private requests retain `no-store`. The load comparison uses full bodies for both revisions, so it excludes the bandwidth benefit of conditional requests.

Candidate application [569498a](https://github.com/Manthan-13521/Kirana_blink_it/commit/569498a) was released to Pages `099bfc28` and Worker `105888ed-6cef-4ae5-954f-d6babdc04138`. The bounded repeat endurance run started at 16:22:21 IST. The first run and its terminal evidence remain intact. The full sales harness now distributes placements across actual remaining fulfillment slots and includes owner reconciliation for cash deliveries.

## Earlier workload and storage measurements

Local Wrangler with 5,000 SKUs, 300 counter sales and 60 home deliveries. Payments were simulated. Order and POS totals reflect completed transactions.

| Online | Peak shoppers | Requests | HTTP p50/p95/p99 (ms) | Peak p95/p99 (ms) | D1 reads/writes | Errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 800 | 32 | 24,989 | 64.80 / 140.96 / 182.71 | 175.80 / 212.98 | 396,046 / 63,736 | 0 |
| 1,000 | 40 | 31,056 | 90.37 / 292.76 / 406.96 | 382.45 / 449.33 | 546,898 / 76,872 | 0 |
| 1,500 | 48 | 46,222 | 66.33 / 221.03 / 271.59 | 263.86 / 315.25 | 1,027,387 / 109,700 | 0 |

The prior documented target with 32 shoppers measured 160.01 ms p95 and 70,523 D1 writes. The current target reduced writes by 9.6%. Wall time was 47.32 seconds, with 64.95 cumulative workerd CPU seconds and 1,549.7 MiB peak local process-group RSS. The 1,000 and 1,500 runs used greater peak concurrency and should not be read as matched before/after latency comparisons. The 1,500 run exceeded the published D1 Free write allowance. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

The synthetic 90-day history contained 99,000 orders, 297,000 stock movements, 5,000 SKUs and a separate 37.2 MB media database. Business allocation was 57.9 MB at 30 days, 113.8 MB at 60 days and 169.6 MB at 90 days. The independent end-to-end target run added 4.01 MB in a single modeled day. Basket mix, audit activity and product changes affect growth. These measurements establish the need for a rollover rehearsal.

The isolated 5,000-SKU browsing run reached 32 concurrent clients and completed 545 hosted requests with zero errors and zero writes. Combined p50/p95/p99 were 146/193/661 ms. Catalog p95 was 187 ms across 512 calls. The 32-call store endpoint sample had a 682 ms p95, above the 500 ms goal. Four separated 32-call waves yielded a first-wave p95 of 725 ms and subsequent values of 124–198 ms. This exposes a first-wave tail that merits remeasurement under the full hosted target. It does not establish whether the latency came from the network, Worker startup or D1.

After deployment, throttled hosted Android Chromium lab samples recorded 1.49–1.90 seconds LCP and 0.059 CLS. INP and field Core Web Vitals remain open. The four-hour bounded run records its maximum attempted concurrency and automatic endpoint timings.
