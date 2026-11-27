# Commercial release acceptance

**Verdict FAIL for commercial launch.** The production acceptance brief requires a completed four-hour hosted run, the full hosted target, verified credentialed workspaces and the operational/data-retention gates below. These remain open. Public checkout and live payment initiation stay disabled.

## Verified

- Local target reached 800 online orders and 300 counter sales across 5,000 SKUs, with 24,989 requests, zero errors and p50/p95/p99 of 64.80/140.96/182.71 ms. Higher local stress tests and resource counts are in the [performance report](PERFORMANCE.md).
- A private, encrypted copy of the merchant business and media data passed authenticated decryption and SQLite integrity checks. The separate 90-day history test checked 99,000 synthetic orders.
- Hosted storefront, customer, owner and rider Google entry points rendered. The existing authenticated owner dashboard in Safari showed the earlier ₹12 UPI payment as paid and completed. This cycle made no new real payment or refund.
- A two-store local preparation rehearsal verified separate database identities, bindings, clean starting data and closed initial checkout.
- The full local regression suite passed 38 tests. The owner photo fix retries an interrupted upload with no redundant product update, verified in iPhone WebKit. The separate test harness uses an OS-assigned debug port after concurrent Wrangler previews hit a port collision. All 28 query-plan shapes and the production dependency audit passed.
- Application source revision [3369af0](https://github.com/Manthan-13521/Kirana_blink_it/commit/3369af01d56655884e8812652c79eb154a785b9e) passed [GitHub CI](https://github.com/Manthan-13521/Kirana_blink_it/actions/runs/45950306654) and was released to [the storefront](https://blink-it.pages.dev). Pages deployment `566b7fe1` and Worker version `89843ff2-806c-4325-a54c-efbf7e766a9c` include this QA release. The deployed photo bundle, all three sign-in entry points and closed checkout were rechecked. Merchant order, refund and media totals matched the pre-release encrypted backup.

## Rollback

The previous Pages production deployment is `f972e81a-3456-4a2e-b6a0-f9f93febc026`. In the `blink-it` Pages project, open **Deployments**, choose that entry's actions menu and select **Rollback to this deployment**. The previous merchant Worker version is `094e1450-922c-453b-88e2-c7e534ef1566`. If the API also requires rollback, use `wrangler rollback 094e1450-922c-453b-88e2-c7e534ef1566 --name kirana-blink-it-staging-api` with the existing authorized account. The release added no schema migration, so rollback keeps both D1 databases in place. Check the Pages service binding, the Worker flags, Google status and the merchant totals after rollback. [Pages rollback](https://developers.cloudflare.com/pages/configuration/rollbacks/) · [Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

## Open acceptance gates

- The bounded hosted endurance run began at 11:22:43 IST on 27 November 2026. Completion is scheduled for approximately 15:22:43 IST if the runner and quota remain available. Require the final saved checkpoint with timing and database invariants.
- The full 5,000-SKU hosted 800 online plus 300 counter run has a separate quota gate. The next UTC quota window starts at 05:30 IST on 28 November. Confirm actual headroom before starting it.
- Confirm production Razorpay webhook delivery after credential rotation and test the full credentialed rider workflow. The merchant should operate the store in a supervised acceptance round on their own devices.
- Rehearse long-term rollover, unattended backup scheduling, an independent hosted merchant setup, physical phones and supported Firefox. Obtain actual provider usage and mobile INP where available.

The [playbook](README.md) explains how to reproduce the checks. The [resource report](CLOUDFLARE_USAGE.md) explains Free limits and the stop condition.
