# Backup and recovery

- A private merchant export started on 27 November 2026 at 11:17 IST. Business DB, media DB and settled archive were encrypted. Authenticated decryption and SQLite integrity and foreign-key checks passed before hosted synthetic writes began. The encrypted files and the backup key are held outside the public source tree.
- A separate synthetic test paged and encrypted 1,100 settled orders. It restored a private SQLite copy, verified database integrity and invoice records, and kept unresolved, unreconciled, open-case and recent records outside the settled export.
- Worker Cron tests verify eligible temporary-data removal without touching retained financial records. A merchant maintenance dry rehearsal executed the backup-only workflow twice on the same UTC day and produced one verified backup and one completion marker. Evidence of an unattended successful run on the merchant-controlled schedule is still required.
- The archive copy leaves active business tables intact. A long-term, approved read path and rollover procedure for reaching the D1 per-database limit remain release gates. No live-data trimming or import into the merchant database occurred.

Recovery uses the procedure in the [store README](../README.md). Restore first into a private, separate SQLite file or approved test database and compare integrity and sample back-office totals before considering a production recovery.
