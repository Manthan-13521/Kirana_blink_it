# Cloudflare resource usage

The Workers dashboard showed Free as the current plan. The account reported six D1 databases and five Pages projects before testing. The account-wide billing endpoint did not return a usable subscription list under the existing authorization.

| Meter | Free limit documented by Cloudflare | Commercial test warning / stop |
| --- | ---: | --- |
| Worker requests per UTC day | 100,000 | Endurance stops before 70,000 projected account requests |
| Worker CPU and memory | 10 ms CPU per request, 128 MB per isolate | Observe hosted analytics and investigate CPU tails. Local workerd RSS has a different scope. |
| Worker subrequests | 50 per request | Check the busiest route and bound parallel external calls |
| D1 reads/rows written per UTC day | 5,000,000 / 100,000 | Stop endurance before 3,500,000 / 70,000 projected account rows |
| D1 allocation | 500 MB per database, 5 GB per account, 10 DBs | Verify storage trend and an approved business-data rollover before relying on long-term use |
| D1 queries per Worker invocation | 50 | D1 counts a batch as one network query. Fixture headers count statements. |
| Worker cron | 5 triggers per account | Keep per-store plans and automatic maintenance within the account cap |

Official limits and pricing. [Workers](https://developers.cloudflare.com/workers/platform/limits/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)

Completing the isolated catalog from 4,180 to 5,000 SKUs consumed 31,160 writes and 26,243 reads. Post-seed account telemetry reported 31,257 writes for 27 November UTC. The full target harness requires that current writes plus its 76,000-row reserve stay below 90,000. It was blocked on that UTC day. The local target's 63,736 writes, added to the seed-day baseline, also exceed the operating safety budget. Run the full target on a day with enough independently verified shared headroom.

Hosted endurance queries the shared Cloudflare metrics regularly and checks both analytics and fixture-side operation counts before starting the next work group. Early analytics showed a sample p50 of 3.03 ms and p99 of 10.43 ms CPU at 111 requests with zero observed errors. Compare the upper tail and actual CPU-limit errors at the end. Cloudflare's analytics may lag or be sampled.

The run makes zero upstream routing requests. The merchant D1 routing budget had zero recorded reservations at the time of inspection. Geoapify Free publishes 3,000 credits per day and allows commercial use within its limits with attribution. Kirana reserves at most 2,100 credits and reuses routes or falls back to manual dispatch. Provider dashboard usage at the target remains to be verified. [Geoapify Free](https://www.geoapify.com/pricing/)
