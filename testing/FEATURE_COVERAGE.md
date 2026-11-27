# Feature coverage

Each row describes a feature group and the strongest available evidence. Protect merchant data by using the local or hosted synthetic environment for mutations.

| Workspace | Feature group | Evidence | Acceptance gap |
| --- | --- | --- | --- |
| Customer | Catalog, categories, search, variants and stock | Local browser, API and indexed query regression | Real phone review |
| Customer | Basket edits and recovery | Browser quantity changes and reload, local synchronization checks | Physical phones and multi-device flow |
| Customer | Google identity, role redirect, logout and history | Authorized shopper session on hosted site, callback fixtures, all hosted sign-in entries | Physical-device recheck after credential rotation |
| Customer | Delivery area, slots, fees and pickup | Local delivery/pickup flows, admission races, all fulfillment switch combinations and private hosted COD handover | Physical device handover |
| Customer | COD, online payment and interruption recovery | Simulated orders under load, signed fixtures, previously verified hosted UPI capture | Independent webhook delivery and live refund acceptance |
| Customer | Tracking, invoice, cancellations and support | Ownership checks, status refresh, invoice/recovery regressions and synthetic refunds | Manual phone invoice download and support journey |
| Owner | Dashboard and sales summaries | Signed-in merchant owner in Safari, reporting regression and historical fixture | Merchant-observed reconciliation |
| Owner | Catalog, pricing, photos, brands, categories and units | Local browser, CRUD and validation regression, archival tests and price race | Merchant-guided bulk catalog and photo import |
| Owner | Stock, shortages, counter sales and expiry | Local regression, stock contention and workload checks | Real point-of-sale day |
| Owner | Orders, pickup, assignment, cases and cash | Local owner/rider lifecycle, race and reconciliation tests, read-only hosted payment queue | Owner-led handling on physical devices |
| Owner | Store controls, branding and team access | Stored settings, checkout guard, logo, real Google owner/rider authorization and one-active-rider regression | Independent merchant owner and rider setup |
| Rider | Assigned stops, state changes, COD and manual order | Local role and delivery fixtures, mobile viewport dashboard and real Google private COD delivery | Physical device workflow |
| Rider | Geoapify road plans, caching and quota fallback | Local signed-in routing tests and earlier hosted provider check | Daily provider consumption under actual delivery operations |
| Operations | Maintenance, media publication, archive and restores | Cron and archive tests, encrypted merchant export and local recovery rehearsal | Scheduled run and over-capacity rollover |
| Operations | Independent merchants | Two local release bundles, separate resources and empty business data | Fully provisioned second merchant |
| Operations | Workload and endurance | Target passed locally. Original bounded hosted four-hour endurance passed. | Full hosted target and candidate terminal result |
