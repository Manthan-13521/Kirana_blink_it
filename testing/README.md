# Commercial acceptance testing

Run from the project root. Use Node.js with `node:sqlite`, the locked dependencies, and a local Wrangler installation. The scripts listed here use synthetic data. Browser checks against the merchant storefront only navigate, read public content and open sign-in entry points.

| Check | Command or evidence |
| --- | --- |
| TypeScript, production build, API regression and dependency audit | `npm run check && npm run build && npm test && npm run test:plans && npm audit --omit=dev --audit-level=high` |
| Browser end-to-end | Install Playwright and its supported browsers outside the application dependency tree. Point `KIRANA_PLAYWRIGHT_MODULE` at its absolute `index.mjs` path and run `node testing/browser-matrix.mjs`. Pass `image`, `hosted` or a device profile to rerun one group. |
| Target workload | `npm run benchmark -- 800 32` |
| Local stress | `npm run benchmark -- 1000 40` and `npm run benchmark -- 1500 48` |
| Long-term database fixture | `node testing/database-growth.mjs` |
| Independent release bundles and initial databases | `node testing/store-rehearsal.mjs` after the production build |
| Entire hosted target | `node tests/hosted-benchmark.mjs` with its required private configuration and current account quota evidence |

## Four-hour hosted endurance

Use the **existing isolated benchmark Worker** and its two synthetic databases. Keep the generated configs, credentials and raw logs in a private directory outside the repository. Do not use the merchant Worker or databases. Check the current Wrangler login and quota first.

1. Run `node testing/prepare-benchmark.mjs BENCHMARK_MANIFEST PRIVATE_MERCHANT_MANIFEST PRIVATE_WORKER_CONFIG PRIVATE_CLIENT_CONFIG`. The command verifies account and database bindings, applies migrations only to the synthetic databases and deploys a token-protected benchmark Worker with a short-lived credential. A dedicated seeded fixture must already contain 5,000 products and have no pending orders.
2. Run `node testing/endurance.mjs PRIVATE_CLIENT_CONFIG NEW_EVIDENCE.jsonl` from a persistent terminal. Use the scoped Cloudflare analytics token or set `KIRANA_WRANGLER_OAUTH_CONFIG` to the existing private Wrangler OAuth configuration file. The runner writes frequent checkpoints and recalculates the remaining quota against observed account usage. A bearer or quota failure creates a failure record.
3. Require a terminal `complete` record, elapsed time of at least four hours, no unexpected HTTP errors and clean before/after integrity checks. Partial JSONL files provide progress and diagnosis. Restart with a fresh path and credential if the process is interrupted. The bounded endurance run and full-volume hosted benchmark cover separate acceptance criteria.

## Acceptance records

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
