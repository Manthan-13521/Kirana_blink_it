# Commercial acceptance testing

Run from the project root. Use Node.js with `node:sqlite`, the locked dependencies, and a local Wrangler installation. The scripts listed here use synthetic data. Browser checks against the merchant storefront only navigate, read public content and open sign-in entry points.

| Check | Command or evidence |
| --- | --- |
| TypeScript, production build, API regression and dependency audit | `npm run check && npm run build && npm test && npm run test:plans && npm audit --omit=dev --audit-level=high` |
| Browser end-to-end | Install Playwright and its supported browsers outside the application dependency tree. Point `KIRANA_PLAYWRIGHT_MODULE` at its absolute `index.mjs` path and run `node testing/browser-matrix.mjs`. Pass `image`, `hosted` or a device profile to rerun one group. |
| Target workload | `npm run benchmark -- 800 32` |
| Local stress | `npm run benchmark -- 1000 40` and `npm run benchmark -- 1500 48` |
| Long-term database fixture | `node testing/database-growth.mjs` |
| Synthetic archival and rollover | `node testing/database-growth.mjs --rollover-rehearsal` |
| Independent release bundles and initial databases | `node testing/store-rehearsal.mjs` after the production build |
| Entire hosted target | `node tests/hosted-benchmark.mjs` with its required private configuration and current account quota evidence |

## Four-hour hosted endurance

Use the **existing isolated benchmark Worker** and its two synthetic databases. Keep the generated configs, credentials and raw logs in a private directory outside the repository. Do not use the merchant Worker or databases. Check the current Wrangler login and quota first.

1. Run `node testing/prepare-benchmark.mjs BENCH_WRANGLER STORE_MANIFEST OLD_BENCH_CLIENT NEW_WRANGLER NEW_CLIENT ACCOUNT_ID RECENT_SEED_WRITES`. Set `RECENT_SEED_WRITES` to 0 once analytics accounts for earlier seed activity. The command verifies account and database bindings, applies migrations only to the synthetic databases and deploys a token-protected benchmark Worker with a short-lived credential. A dedicated seeded fixture must already contain 5,000 products and have no pending orders.
2. Run `node testing/endurance.mjs PRIVATE_CLIENT_CONFIG NEW_EVIDENCE.jsonl` from a persistent terminal. Use the scoped Cloudflare analytics token or set `KIRANA_WRANGLER_OAUTH_CONFIG` to the existing private Wrangler OAuth configuration file. The runner writes frequent checkpoints and recalculates the remaining quota against observed account usage. A bearer or quota failure creates a failure record.
3. Require a terminal `complete` record, elapsed time of at least four hours, no unexpected HTTP errors and clean before/after integrity checks. Partial JSONL files provide progress and diagnosis. Restart with a fresh path and credential if the process is interrupted. The bounded endurance run and full-volume hosted benchmark cover separate acceptance criteria.
4. Read the original log without changing it using `node testing/report-endurance.mjs EVIDENCE.jsonl`. The report prints a partial status until final latency and integrity records are available.

## Full hosted sales target

After the candidate endurance ends and enough UTC-day quota is available, renew the benchmark credential as above. Use a scoped Cloudflare Analytics Read token with `node tools/quota-report.mjs ACCOUNT_ID kirana-benchmark-staging-api > PRIVATE_QUOTA.json`. The file must be less than one minute old when passing it to `node tests/hosted-benchmark.mjs NEW_CLIENT target PRIVATE_QUOTA.json`. Supply the scoped token or `KIRANA_WRANGLER_OAUTH_CONFIG` to this process so it can refresh analytics during the test. The harness reserves available fulfillment windows before placing orders, reconciles simulated delivery cash and checks database invariants before and after. Use a new evidence file for each test run.

## Acceptance records

- [27 November sanitized measurements](evidence/2026-11-27.json)
- [Feature coverage](FEATURE_COVERAGE.md)
- [Security review](SECURITY_REPORT.md)
- [Payment acceptance](PAYMENT_ACCEPTANCE.md)
- [Cloudflare resources](CLOUDFLARE_USAGE.md)
- [Database integrity](DATABASE_INTEGRITY.md)
- [Backup and recovery](BACKUP_RECOVERY.md)
- [Issue tracker](BUG_TRACKER.md)
- [Before and after performance](PERFORMANCE.md)
- [Shopkeeper tryout](SHOPKEEPER_USABILITY.md)
- [Shopkeeper handover guide](SHOPKEEPER_HANDOVER.md)
- [Commercial release verdict](RELEASE_ACCEPTANCE.md)
