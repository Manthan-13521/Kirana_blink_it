# Performance measurements

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

Candidate application [569498a](https://github.com/Manthan-13521/Kirana_blink_it/commit/569498a) is on Pages `099bfc28` and Worker `105888ed-6cef-4ae5-954f-d6babdc04138`. The bounded repeat endurance run started at 16:22:21 IST. The first run and its terminal evidence remain intact. The full sales harness now distributes placements across actual remaining fulfillment slots and includes owner reconciliation for cash deliveries.

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
