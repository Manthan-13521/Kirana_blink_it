import { Hono } from 'hono'
import { getCookie,setCookie } from 'hono/cookie'
import { digest,id,json,localhost,now,one,Problem,authorizeOrder,order,role,S,statement,token } from './shared'
import type { Account,Ctx,Env } from './shared'

const COOKIE='kirana_session'
const DAY=86400
export const localRoutes=new Hono<Env>()

async function login(c:Ctx,accountId:string){
  const db=c.env.DB, session=token(), time=now()
  const old=getCookie(c,COOKIE)
  const operations=[statement(db,'INSERT INTO sessions(hash,account_id,expires_at) VALUES(?,?,?)',await digest(session),accountId,time+DAY)]
  if(old&&/^[a-f0-9]{64}$/.test(old)) operations.push(statement(db,'DELETE FROM sessions WHERE hash=?',await digest(old)))
  await db.batch(operations)
  setCookie(c,COOKIE,session,{path:'/',sameSite:'Strict',httpOnly:true,maxAge:DAY,secure:new URL(c.req.url).protocol==='https:'})
  return c.json(await one<Account>(db,'SELECT id,role,name,phone FROM accounts WHERE id=?',accountId))
}
localRoutes.post('/auth/demo',async c=>{
  if(!localhost(c)) throw new Problem(404,'Sign-in provider unavailable.')
  const data=await json(c)
  const choice=S(data.role,'demo role',20)
  if(!['customer','owner','rider','staff'].includes(choice)) throw new Problem(400,'Invalid demo role.')
  const account=await one<Account>(c.env.DB,'SELECT id,role,name,phone FROM accounts WHERE id=? AND active=1','demo-'+choice)
  if(!account) throw new Problem(404,'The demo account is inactive.')
  return login(c,account.id)
})
localRoutes.post('/auth/register-local',async c=>{
  if(!localhost(c)) throw new Problem(404,'Sign-in provider unavailable.')
  const data=await json(c), db=c.env.DB
  const name=S(data.name,'name',80), phone=S(data.phone??'','phone',24,false)
  const accountId=id(), time=now()
  const invite=S(data.invite??'','invitation',80,false)
  if(invite){
    const hash=await digest(invite)
    const result=await db.batch([
      statement(db,'INSERT INTO accounts(id,role,name,phone) SELECT ?,role,?,? FROM invites WHERE hash=? AND used_at IS NULL AND expires_at>?',accountId,name,phone,hash,time),
      statement(db,'UPDATE invites SET used_at=? WHERE hash=? AND changes()=1',time,hash),
    ])
    if(!result[0].meta.changes) throw new Problem(400,'The invite is invalid or expired.')
  } else await statement(db,"INSERT INTO accounts(id,role,name,phone) VALUES(?,'customer',?,?)",accountId,name,phone).run()
  return login(c,accountId)
})
localRoutes.post('/orders/:id/test-payment',async c=>{
  if (!localhost(c)) throw new Problem(404,'Operation unavailable.')
  const account=role(c,'customer'), db=c.env.DB, data=await json(c)
  const row=await order(db,c.req.param('id'));authorizeOrder(account,row)
  if(row.payment_method!=='online') throw new Problem(409,'This order does not use online payment.')
  const result=data.result
  if(result!=='paid'&&result!=='failed') throw new Problem(400,'Select a test payment result.')
  const replay=(existing:typeof row)=>existing.payment_status===(result==='paid'?'paid':'void')
  if(row.status!=='awaiting_payment'){
    if(replay(row))return c.json({ok:true,status:row.status,replayed:true})
    throw new Problem(409,'This payment session is closed.')
  }
  const time=now()
  const success=result==='paid'&&row.created_at>=time-900
  const changed=await statement(db,`UPDATE orders SET status=?,payment_status=?,updated_at=?
    ${success?'':',stocked=0,slot_retained=0'} WHERE id=? AND status='awaiting_payment'`,
    success?'placed':'cancelled',success?'paid':'void',time,row.id).run()
  if(!changed.meta.changes){
    const current=await order(db,row.id)
    if(replay(current))return c.json({ok:true,status:current.status,replayed:true})
    throw new Problem(409,'This payment was already resolved. Refresh the order.')
  }
  return c.json({ok:true,status:success?'placed':'cancelled'})
})
