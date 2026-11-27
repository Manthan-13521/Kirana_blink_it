# Backup and recovery

- A private merchant export started on 27 November 2026 at 11:17 IST. Business DB, media DB and settled archive were encrypted. Authenticated decryption and SQLite integrity and foreign-key checks passed before hosted synthetic writes began. The encrypted files and the backup key are held outside the public source tree.
- A separate synthetic test paged and encrypted 1,100 settled orders. It restored a private SQLite copy, verified database integrity and invoice records, and kept unresolved, unreconciled, open-case and recent records outside the settled export.
- Worker Cron tests verify eligible temporary-data removal without touching retained financial records. A merchant maintenance dry rehearsal executed the backup-only workflow twice on the same UTC day and produced one verified backup and one completion marker. Evidence of an unattended successful run on the merchant-controlled schedule is still required.
- The archive copy leaves active business tables intact. A long-term, approved read path and rollover procedure for reaching the D1 per-database limit remain release gates. No live-data trimming or import into the merchant database occurred.

Recovery uses the procedure in the [store README](../README.md). Restore first into a private, separate SQLite file or approved test database and compare integrity and sample back-office totals before considering a production recovery.

## Rollover rehearsal

Run `node testing/database-growth.mjs --rollover-rehearsal` from the repository. This command creates and uses disposable synthetic SQLite files. Its cutoff selects the oldest 33,000 fixtures for a measured exercise. The production retention period remains an operator decision.

On 27 November, the rehearsal authenticated seven encrypted archive pages, recovered a paid invoice with its three original item lines, and made a 104,726,528-byte candidate from a 169,566,208-byte source. Combined order counts and gross totals matched, stock matched, and source data was preserved. Candidate SQLite and foreign-key integrity checks passed.

To find an archived invoice by order ID, pass the dated private backup folder, or the individual encrypted page, to `node tools/backup-d1.mjs invoice DATED_BACKUP_FOLDER NEW_PRIVATE_INVOICE.json ORDER_ID`. Supply the merchant-controlled passphrase on stdin. The folder mode authenticates its archive pages before emitting the invoice. Keep the result outside the repository.

Before a live cutover, approve the retention and access policy, verify statutory records with the merchant, and rehearse a new isolated D1 binding under Free quota. Preserve the old DB and a verified backup. Pause and drain writers for the final import, reconcile stock, refunds and exactly-once checkout history, and verify report and invoice lookups across both periods. The live application still needs historical lookup and replay protection across the rollover boundary. Use a maintenance window for a large D1 export, since Cloudflare documents possible database unavailability during export. [Cloudflare D1 export behavior](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)
