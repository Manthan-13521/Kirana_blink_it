# Database integrity

The 5,000-SKU local target completed 800 online orders and 300 counter sales. D1 triggers guard stock, checkout price snapshots, fulfillment settings revision and slot admission inside the transaction. The price-update regression verifies that a successful pre-change order keeps its original invoice amount, or a stale quote is rejected. A refreshed quote uses the new price.

Local regression covers final-unit POS/online competition, slot contention, order replay after a lost response, repeated payment confirmation, overlapping refunds, pending orders during a store pause and exhaustion of local test reservations. The hosted runner records order totals, completed and pending counts, payment mismatches, duplicate terminal events, inventory and storage using aggregate-only integrity data. Its final check requires outcomes to match the number of successful synthetic sales.

The isolated historical fixture used production schema and stock triggers to seed 33,000, 66,000 and 99,000 finished orders, with three item lines each, plus payment and audit records, customer accounts and images. Owner 30-day report queries remained around 43 ms p95 in SQLite. Report response time through the hosted Worker was outside this fixture's scope. Direct historical seeding assumes earlier business operations succeeded and is separate from the end-to-end workload.

Some concurrency combinations, including rider confirmation racing an owner cancellation, still need dedicated acceptance evidence. Local query-plan checks and bounded historical reports do not establish long-term hosted D1 retention.
