# Commercial release acceptance

**Verdict FAIL for commercial launch.** Hosted target capacity and latency, post-rotation Razorpay replay, and production rollover remain open. Public checkout, live payment initiation and live refunds are disabled.

## 27 November follow-up

| Gate | Result | Evidence |
| --- | --- | --- |
| Complete the original four-hour endurance run | PASS | 11:22:43 to 15:22:48 IST, 6,919 requests, 172 online orders, 60 counter sales, zero unexpected errors, peak 100 clients. No quota stop. |
| Hosted latency and target workload | FAIL | Endurance p50/p95/p99 were 230/728/971 ms. Catalog p95 was 754 ms. Endurance used 132,910 D1 reads and 14,050 writes. Sampled Worker CPU p50/p99 were 2.12/6.17 ms. Full 5,000-SKU, 800 online and 300 counter test awaits an eligible UTC quota window. |
| Endurance integrity | PASS | 5,000 SKUs, minimum stock 180, zero pending payments, unexplained totals, payment mismatches or duplicate completion events. |
| Existing authentic Razorpay delivery | PASS | Provider history confirmed HTTP 200 for `payment.captured` and `order.paid` at 11:07:28 IST. D1 recorded one matched-time Live capture. |
| Current secret alignment and provider replay | FAIL | The old saved secret produced HTTP 403 on the local diagnostic. The successful provider attempts establish the earlier delivery, while a fresh post-rotation event and provider replay still need verification. |
| Private rider workflow | PASS | Three real Google sign-ins, private COD order, owner assignment, rider completion, shopper tracking and cash reconciliation. One deduction and zero provider charges. Temporary private checkout access was revoked. |
| Unattended backup and restoration | PASS | The launchd job completed a merchant backup in the private Application Support directory. Both stores restored with valid integrity and foreign keys. Daily schedule installed. |
| Hosted rollover rehearsal | PASS | Two isolated synthetic D1 databases. Candidate matched source order history, invoices, payment identifiers and inventory, with an original recovery bookmark. |
| Live rollover, physical-device and independent merchant acceptance | FAIL | Live retention and cutover, a physical phone workflow and independent provider accounts remain open. |

The [final endurance report](evidence/endurance-2026-11-27-final.json) records full endpoint timings and the validated terminal checks. The earlier summary below documents the release state before this follow-up.

## Verified

- Local target reached 800 online orders and 300 counter sales across 5,000 SKUs, with 24,989 requests, zero errors and p50/p95/p99 of 64.80/140.96/182.71 ms. Higher local stress tests and resource counts are in the [performance report](PERFORMANCE.md).
- A private, encrypted copy of the merchant business and media data passed authenticated decryption and SQLite integrity checks. The separate 90-day history test checked 99,000 synthetic orders.
- Hosted storefront, customer, owner and rider Google entry points rendered. The existing authenticated owner dashboard in Safari showed the earlier ₹12 UPI payment as paid and completed. This cycle made no new real payment or refund.
- A two-store local preparation rehearsal verified separate database identities, bindings, clean starting data and closed initial checkout.
- The full local regression suite passed 38 tests. The owner photo fix retries an interrupted upload with no redundant product update, verified in iPhone WebKit. The separate test harness uses an OS-assigned debug port after concurrent Wrangler previews hit a port collision. All 28 query-plan shapes and the production dependency audit passed.
- Application source revision [3369af0](https://github.com/Manthan-13521/Kirana_blink_it/commit/3369af01d56655884e8812652c79eb154a785b9e) passed [GitHub CI](https://github.com/Manthan-13521/Kirana_blink_it/actions/runs/45950306654) and was released to [the storefront](https://blink-it.pages.dev). Pages deployment `566b7fe1` and Worker version `89843ff2-806c-4325-a54c-efbf7e766a9c` include this QA release. The deployed photo bundle, all three sign-in entry points and closed checkout were rechecked. Merchant order, refund and media totals matched the pre-release encrypted backup.
- Follow-up application revision [9bf036c](https://github.com/Manthan-13521/Kirana_blink_it/commit/9bf036c) passed [GitHub CI](https://github.com/Manthan-13521/Kirana_blink_it/actions/runs/45952578633) and 38 local tests. Pages deployment `cd234fa9` and merchant Worker `5fd269aa-8f26-4ddc-92ca-faa0bfc15c1f` are live. App health, Google availability, rider allowlist binding and closed checkout were verified. Privacy-safe capture logs are enabled with generic invocation logs off. The local signed event regression verified a single update, and a duplicate delivered with no second update.
- Signed-in Google rider access worked on the live site. The merchant DB had one linked active rider and zero delivery orders. The Firefox desktop matrix passed all 10 checks on macOS.
- Synthetic rollover archived 33,000 of 99,000 orders and produced a 104.7 MB candidate from a 169.6 MB source with matching stock and gross totals. The archived invoice and its original items were retrieved. The native scheduler passed the offline synthetic backup/restore fixture. An unattended merchant run from the Documents workspace was denied access to its passphrase file by macOS.

## Rollback

The Pages rollback point for the follow-up is `566b7fe1`. In the `blink-it` Pages project, open **Deployments**, choose that entry's actions menu and select **Rollback to this deployment**. Confirm the immediately preceding merchant Worker version in **Deployments** before API rollback, since the rider secret was added between application releases. The follow-up added no schema migration, so application rollback keeps both D1 databases in place. Check Pages service binding, checkout flags, Google and rider access, and merchant totals after rollback. [Pages rollback](https://developers.cloudflare.com/pages/configuration/rollbacks/) · [Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

## Earlier acceptance snapshot

- The bounded hosted endurance run began at 11:22:43 IST on 27 November 2026. At the 12:04:14 IST checkpoint it had 931 requests, zero unexpected errors, 27 completed online orders, 9 counter sales, 16,154 D1 reads and 2,194 D1 writes. It continued without a quota stop at that checkpoint. Completion is expected around 15:22:43 IST if the runner and quota remain available. Final timing, latency and database invariants require its terminal record.
- The full 5,000-SKU hosted 800 online plus 300 counter run has a separate quota gate. The next UTC quota window starts at 05:30 IST on 28 November. Confirm actual headroom before starting it.
- Match the Razorpay and Worker signing secret through coordinated rotation, then observe an authentic eligible delivery and its replay or retry. The old saved secret returned application HTTP 403. The diagnostic cannot establish Razorpay's actual delivery result.
- Assign and complete a private delivery from a separate authorized fixture. The approved Google account now routes to the rider workspace, so use a distinct authorized customer for a new shopper session.
- Approve a live retention policy, verify the hosted rollover and secure unattended backup runner, and complete the independent hosted store and phone acceptance. Obtain actual routing usage and mobile INP where available.

The [playbook](README.md) explains how to reproduce the checks. The [resource report](CLOUDFLARE_USAGE.md) explains Free limits and the stop condition.
