import { now,one } from './shared'

// Atomic UTC-day reservation for optional operations that can yield to checkout.
export async function reserve(db:D1Database,service:string,units:number,cap:number,spacing=0){
  const time=now(),day=Math.floor(time/86400)
  return Boolean(await one(db,`INSERT INTO service_budget(service,day,used,last_at) VALUES(?,?,?,?)
    ON CONFLICT(service) DO UPDATE SET day=excluded.day,
      used=CASE WHEN service_budget.day=excluded.day THEN service_budget.used+excluded.used ELSE excluded.used END,
      last_at=excluded.last_at
    WHERE (service_budget.day<>excluded.day OR service_budget.used+excluded.used<=?)
      AND service_budget.last_at<=excluded.last_at-?
    RETURNING used`,service,day,units,time,cap,spacing))
}
