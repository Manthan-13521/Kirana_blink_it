import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { action,harness,login,place,session } from './harness.mjs'

let instance, customer, owner, rider, anonymous
before(async()=>{
  instance=await harness()
  anonymous=session(instance.base)
  ;[customer,owner,rider]=await Promise.all(['customer','owner','rider'].map(role=>login(instance.base,role)))
})
after(()=>instance?.stop())
const item=(id,steps=1)=>({id,steps})
const pos=(items)=>({fulfillment:'counter',method:'cash',items})
const stock=async(id)=>(await anonymous('/api/catalog/'+id)).stock
const available=async(mode)=>(await anonymous('/api/slots?mode='+mode))[0].start
const state=(who,id,status,more={},expected=200)=>action(who,'/orders/'+id+'/state',{status,...more},expected)

test('isolated accounts, mutation origin, catalog and customer registration',async()=>{
  assert.equal((await anonymous('/api/health')).mode,'local')
  await anonymous('/api/admin/settings',{expected:401})
  await customer('/api/admin/settings',{expected:403})
  await anonymous('/api/auth/demo',{method:'POST',body:{role:'owner'},headers:{Origin:'http://different.invalid'},expected:403})
  assert.equal((await anonymous('/api/catalog?q=doodh')).products[0].name,'Farm Toned Milk')
  assert.equal((await anonymous('/api/catalog?category=pantry&limit=2')).products.length,2)
  const newCustomer=await action(anonymous,'/auth/register-local',{name:'Test Buyer',role:'owner'},200)
  assert.equal(newCustomer.role,'customer')
  assert.deepEqual(await anonymous('/api/addresses'),[])
  await anonymous('/api/addresses/demo-address',{method:'DELETE',expected:404})
})

test('pickup, state permissions, cash collection, support and refunds',async()=>{
  const before=await stock('tomato'), slot=await available('pickup')
  const request={fulfillment:'pickup',method:'cash',slot,items:[item('tomato')]}
  const q=await action(customer,'/quote',request)
  const payload={...request,version:q.version,key:crypto.randomUUID()}
  const {id}=await action(customer,'/orders',payload,201)
  assert.deepEqual(await action(customer,'/orders',payload),{id,replayed:true})
  assert.equal(await stock('tomato'),before-500)
  await anonymous('/api/orders/'+id,{expected:404})
  await rider('/api/orders/'+id,{expected:404})
  await state(customer,id,'accepted',{},403)
  for(const next of ['accepted','packing','ready']) await state(owner,id,next)
  await state(owner,id,'completed',{cash:1},409)
  await state(owner,id,'completed',{cash:q.total})
  assert.equal((await customer('/api/orders/'+id)).payment_status,'cash_collected')
  await action(customer,'/orders/'+id+'/cases',{kind:'return',reason:'Damaged item'},201)
  const requestCase=(await owner('/api/admin/cases')).find(c=>c.order_id===id)
  await action(owner,'/admin/cases/'+requestCase.id,{status:'approved',response:'Partial refund',amount:1000})
  assert.equal((await customer('/api/orders/'+id)).refunds[0].amount,1000)
  await action(owner,'/admin/cases/'+requestCase.id,{status:'approved',amount:100},409)
})

test('delivery dispatch with mock payment, scoped rider and COD handling',async()=>{
  const delivery={fulfillment:'delivery',method:'online',slot:await available('delivery'),addressId:'demo-address',items:[item('milk')]}
  const {id}=await place(customer,delivery)
  assert.equal((await customer('/api/orders/'+id)).status,'awaiting_payment')
  await action(owner,'/orders/'+id+'/test-payment',{result:'paid'},403)
  await action(customer,'/orders/'+id+'/test-payment',{result:'paid'})
  await action(customer,'/orders/'+id+'/test-payment',{result:'paid'})
  await state(owner,id,'accepted')
  await action(owner,'/orders/'+id+'/assign')
  for(const next of ['packing','ready'])await state(owner,id,next)
  const route=await rider('/api/rider/route')
  assert.equal(route.orders[0].id,id)
  await action(rider,'/rider/route',{orders:[id]},200,'PUT')
  await state(rider,id,'out_for_delivery')
  await state(rider,id,'completed')
  const completed=await rider('/api/orders/'+id)
  assert.equal(completed.status,'completed')
  assert.equal(completed.address,null)
  assert.equal(completed.invoice,null)
  assert.equal((await rider('/api/orders')).orders.find(row=>row.id===id).address_json,null)
  assert.equal((await rider('/api/rider/route')).summary.cash,0)
  await action(owner,'/orders/'+id+'/reconcile')
  await action(owner,'/orders/'+id+'/reconcile')
  const settledRoute=await rider('/api/rider/route')
  assert.equal(settledRoute.summary.cash,0)
  assert.ok(settledRoute.summary.completed>=1)
  assert.equal((await owner('/api/orders/'+id)).reconciled,1)
  const noCharge=await place(customer,{...delivery,slot:await available('delivery')})
  const reserved=await stock('milk')
  await action(customer,'/orders/'+noCharge.id+'/test-payment',{result:'failed'})
  assert.equal(await stock('milk'),reserved+500)
  const cod=await place(customer,{...delivery,slot:await available('delivery'),method:'cash'})
  const codTotal=(await customer('/api/orders/'+cod.id)).total
  await state(owner,cod.id,'accepted')
  await action(owner,'/orders/'+cod.id+'/assign')
  for(const phase of ['packing','ready'])await state(owner,cod.id,phase)
  await state(rider,cod.id,'out_for_delivery')
  await state(rider,cod.id,'completed',{cash:codTotal})
  assert.equal((await rider('/api/rider/route')).summary.cash,codTotal)
  await action(customer,'/orders/'+cod.id+'/cases',{kind:'refund',reason:'Refund on delivery'},201)
  const refundRequest=(await owner('/api/admin/cases')).find(row=>row.order_id===cod.id)
  await action(owner,'/admin/cases/'+refundRequest.id,{status:'approved',amount:codTotal},409)
  await action(owner,'/orders/'+cod.id+'/reconcile')
  await action(owner,'/admin/cases/'+refundRequest.id,{status:'approved',amount:codTotal})
  assert.equal((await rider('/api/rider/route')).summary.cash,0)
  assert.equal((await customer('/api/orders/'+cod.id)).payment_status,'refunded')
})

test('approved cancellation releases paid stock and records exactly one full refund',async()=>{
  const before=await stock('banana')
  const {id}=await place(customer,{fulfillment:'pickup',method:'online',slot:await available('pickup'),items:[item('banana')]})
  await action(customer,'/orders/'+id+'/test-payment',{result:'paid'})
  await action(customer,'/orders/'+id+'/cases',{kind:'cancel',reason:'No longer needed'},201)
  const entry=(await owner('/api/admin/cases')).find(c=>c.order_id===id)
  await action(owner,'/admin/cases/'+entry.id,{status:'approved'})
  await action(owner,'/admin/cases/'+entry.id,{status:'approved'},409)
  const order=await customer('/api/orders/'+id)
  assert.equal(order.status,'cancelled')
  assert.equal(order.payment_status,'refunded')
  assert.equal(order.refunds.length,1)
  assert.equal(order.refunds[0].amount,order.total)
  assert.equal(await stock('banana'),before)
})

test('expired stock and stale store quotes are rejected; shortages create a notice',async()=>{
  const {id:expired}=await action(owner,'/admin/products',{sku:'OLD-001',name:'Expired package',category:'fresh',unit:'pc',step:1,price:4000,stock:6,expiry:'2000-01-01'},201)
  await anonymous('/api/catalog/'+expired,{expected:404})
  await action(owner,'/quote',pos([item(expired)]),409)
  const payload={fulfillment:'pickup',method:'cash',slot:await available('pickup'),items:[item('bread')]}
  const q=await action(customer,'/quote',payload)
  const settings=await owner('/api/admin/settings')
  await action(owner,'/admin/settings',{...settings,tagline:'Updated test tagline'},200,'PUT')
  await action(customer,'/orders',{...payload,version:q.version,key:crypto.randomUUID()},409)
  const {id}=await place(customer,payload)
  await action(owner,'/orders/'+id+'/shortage',{productId:'bread',reason:'Last pack was damaged.'})
  assert.match((await customer('/api/orders/'+id)).events.at(-1).note,/Last pack was damaged/)
  assert.ok((await customer('/api/notices')).notices.some(r=>r.order_id===id && r.message.includes('shortage')))
})

test('concurrent final stock and delivery slot cannot oversell or overbook',async()=>{
  const { id }=await action(owner,'/admin/products',{sku:'CONC-001',name:'Last unit',category:'fresh',unit:'pc',step:1,price:9000,stock:1},201)
  const counter=pos([item(id)])
  const online={fulfillment:'pickup',method:'cash',slot:await available('pickup'),items:[item(id)]}
  const attempts=await Promise.all([[owner,'/pos',counter],[customer,'/orders',online]].map(async([call,path,request])=>{
    const {version}=await action(call,'/quote',request)
    return [call,path,{...request,version,key:crypto.randomUUID()}]
  }))
  const outcomes=await Promise.all(attempts.map(async([call,path,payload])=>{
    try{await action(call,path,payload,201);return 'sold'}
    catch(e){assert.match(String(e),/insufficient stock|unavailable|409/);return 'rejected'}
  }))
  assert.deepEqual(outcomes.sort(),['rejected','sold'])
  assert.equal(await stock(id),0)

  const settings=await owner('/api/admin/settings')
  await action(owner,'/admin/settings',{...settings,delivery_capacity:1},200,'PUT')
  const slot=(await anonymous('/api/slots?mode=delivery')).at(-1).start
  const deliver={fulfillment:'delivery',method:'cash',slot,addressId:'demo-address',items:[item('dal')]}
  const version=(await action(customer,'/quote',deliver)).version
  const races=await Promise.all([0,1].map(async()=>{
    try{await action(customer,'/orders',{...deliver,version,key:crypto.randomUUID()},201);return 'booked'}
    catch(e){assert.match(String(e),/filled|another window|409/);return 'rejected'}
  }))
  assert.deepEqual(races.sort(),['booked','rejected'])
  assert.ok(!(await anonymous('/api/slots?mode=delivery')).some(x=>x.start===slot))
  assert.ok((await anonymous('/api/slots?mode=pickup')).length)
  await action(owner,'/admin/settings',settings,200,'PUT')
})

test('catalog media create and deletion, stock ledger, reports',async()=>{
  const {id}=await action(owner,'/admin/products',{sku:'MEDIA-001',name:'Image test product',category:'fresh',unit:'pc',step:1,price:2000,stock:3},201)
  const media=await readFile(new URL('../public/catalog/01.webp',import.meta.url))
  await customer('/api/admin/products/'+id+'/image',{method:'POST',raw:media,headers:{'Content-Type':'image/webp'},expected:403})
  await owner('/api/admin/products/'+id+'/image',{method:'POST',raw:Buffer.from('test'),headers:{'Content-Type':'image/webp'},expected:400})
  const upload=await owner('/api/admin/products/'+id+'/image',{method:'POST',raw:media,headers:{'Content-Type':'image/webp'}})
  const bytes=await anonymous(upload.image)
  assert.deepEqual(Buffer.from(bytes),media)
  assert.equal((await anonymous('/api/catalog/'+id)).image,upload.image)
  await owner('/api/admin/products/'+id+'/image',{method:'DELETE'})
  assert.equal((await anonymous('/api/catalog/'+id)).image,null)
  await action(owner,'/admin/products/'+id+'/stock',{reason:'receipt',quantity:8})
  assert.equal(await stock(id),11)
  assert.equal((await owner('/api/admin/products/'+id+'/stock')).length,2)
  assert.ok((await owner('/api/admin/report?days=1')).length)
})

test('lost-response checkout replay and concurrent terminal test payment are idempotent',async()=>{
  const request={fulfillment:'pickup',method:'online',slot:await available('pickup'),items:[item('milk')]}
  const {version}=await action(customer,'/quote',request)
  const payload={...request,version,key:crypto.randomUUID()}
  const initial=await stock('milk')
  // Disconnect after the server committed, before the browser can read its reply.
  await assert.rejects(customer('/api/orders',{method:'POST',body:payload,expected:201,disconnectAfterHeaders:true}),{name:'AbortError'})
  const {id,replayed}=await action(customer,'/orders',payload)
  assert.equal(replayed,true)
  await action(customer,'/orders',{...payload,items:[item('milk',2)]},409)
  assert.equal(await stock('milk'),initial-500)
  const responses=await Promise.all(Array.from({length:3},()=>action(customer,'/orders/'+id+'/test-payment',{result:'paid'})))
  assert.ok(responses.every(result=>result.ok))
  await action(customer,'/orders/'+id+'/test-payment',{result:'failed'},409)
  const result=await customer('/api/orders/'+id)
  assert.equal(result.payment_status,'paid')
  assert.equal(result.events.filter(event=>event.status==='placed').length,1)
  assert.equal(await stock('milk'),initial-500)
})

test('production entry rejects demo auth and mock payments even with local settings',async()=>{
  const production=await harness(undefined,{entry:'production'})
  try{
    const guest=session(production.base)
    assert.equal((await guest('/api/store')).local,false)
    await action(guest,'/auth/demo',{role:'owner'},404)
    assert.deepEqual(await guest('/api/auth/google/status'),{enabled:false})
    await guest('/api/auth/google',{expected:503})
    await action(guest,'/auth/register-local',{name:'Fake buyer'},404)
    await action(guest,'/orders/test-id/test-payment',{result:'paid'},404)
    assert.equal((await guest('/api/me')).account,null)
  }finally{await production.stop()}
})

test('indexed search paginates broad terms and removes old prefixes on product edits',async()=>{
  const data={sku:'ABC-123',name:'Tamari TestSauceOne',category:'pantry',subcategory:'sauces',unit:'pc',step:1,price:4500,stock:8}
  const {id}=await action(owner,'/admin/products',data,201)
  assert.ok((await anonymous('/api/catalog?q=tam+123')).products.some(p=>p.id===id))
  assert.ok((await anonymous('/api/catalog?q=testsauceone')).products.some(p=>p.id===id))
  await action(owner,'/admin/products/'+id,{...data,name:'Miso TestSauceTwo'},200,'PUT')
  assert.ok(!(await anonymous('/api/catalog?q=tam')).products.some(p=>p.id===id))
  assert.ok((await anonymous('/api/catalog?q=miso&category=pantry&subcategory=sauces')).products.some(p=>p.id===id))
  let cursor=''
  const products=new Set()
  do{
    const result=await anonymous('/api/catalog?q=a&limit=1&after='+encodeURIComponent(cursor))
    result.products.forEach(p=>{assert.ok(!products.has(p.id));products.add(p.id)})
    cursor=result.next
  }while(cursor)
  assert.ok(products.size>1)
})

test('overlapping refund requests cannot exceed captured cash',async()=>{
  const request={fulfillment:'pickup',method:'cash',slot:await available('pickup'),items:[item('milk')]}
  const {id}=await place(customer,request)
  const {total}=await customer('/api/orders/'+id)
  for(const phase of ['accepted','packing','ready'])await state(owner,id,phase)
  await state(owner,id,'completed',{cash:total})
  await action(customer,'/orders/'+id+'/cases',{kind:'refund',reason:'Refund request'},201)
  await action(customer,'/orders/'+id+'/cases',{kind:'return',reason:'Return request'},201)
  const cases=(await owner('/api/admin/cases')).filter(entry=>entry.order_id===id)
  const amount=Math.floor(total*.7)
  const updates=await Promise.all(cases.map(async entry=>{
    try{await action(owner,'/admin/cases/'+entry.id,{status:'approved',amount});return 'approved'}
    catch(error){assert.match(String(error),/refund amount|refund|409/i);return 'refused'}
  }))
  assert.deepEqual(updates.sort(),['approved','refused'])
  const record=await customer('/api/orders/'+id)
  assert.equal(record.refunds.length,1)
  assert.equal(record.refunds[0].amount,amount)
  assert.equal(record.payment_status,'cash_collected')
})

test('hosted staging pauses the checkout API even when store settings accept orders',async()=>{
  const staging=await harness(undefined,{entry:'production',mode:'staging'})
  try{
    const guest=session(staging.base)
    assert.equal((await guest('/api/store')).settings.accepting,0)
    assert.deepEqual(await guest('/api/slots?mode=pickup'),[])
    const [persisted]=await staging.readBusiness('SELECT accepting FROM settings WHERE id=1')
    assert.equal(persisted.accepting,1)
  }finally{await staging.stop()}
})
