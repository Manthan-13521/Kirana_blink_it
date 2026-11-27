# Commercial release acceptance

**Verdict FAIL for commercial launch.** The production acceptance brief requires a completed four-hour hosted run, the full hosted target, verified credentialed workspaces and the operational/data-retention gates below. These remain open. Public checkout and live payment initiation stay disabled.

## Verified

- Local target reached 800 online orders and 300 counter sales across 5,000 SKUs, with 24,989 requests, zero errors and p50/p95/p99 of 64.80/140.96/182.71 ms. Higher local stress tests and resource counts are in the [performance report](PERFORMANCE.md).
- A private, encrypted copy of the merchant business and media data passed authenticated decryption and SQLite integrity checks. The separate 90-day history test checked 99,000 synthetic orders.
- Hosted storefront, customer, owner and rider Google entry points rendered. The existing authenticated owner dashboard in Safari showed the earlier ₹12 UPI payment as paid and completed. This cycle made no new real payment or refund.
- A two-store local preparation rehearsal verified separate database identities, bindings, clean starting data and closed initial checkout.
- The full local regression suite passed 38 tests. The owner photo fix retries an interrupted upload with no redundant product update, verified in iPhone WebKit. The separate test harness uses an OS-assigned debug port after concurrent Wrangler previews hit a port collision. All 28 query-plan shapes and the production dependency audit passed.

## Open acceptance gates

- The bounded hosted endurance run began at 11:22:43 IST on 27 November 2026. Completion is scheduled for approximately 15:22:43 IST if the runner and quota remain available. Require the final saved checkpoint with timing and database invariants.
- The full 5,000-SKU hosted 800 online plus 300 counter run has a separate quota gate. The next UTC quota window starts at 05:30 IST on 28 November. Confirm actual headroom before starting it.
- Confirm production Razorpay webhook delivery after credential rotation and test the full credentialed rider workflow. The merchant should operate the store in a supervised acceptance round on their own devices.
- Rehearse long-term rollover, unattended backup scheduling, an independent hosted merchant setup, physical phones and supported Firefox. Obtain actual provider usage and mobile INP where available.

The [playbook](README.md) explains how to reproduce the checks. The [resource report](CLOUDFLARE_USAGE.md) explains Free limits and the stop condition.
