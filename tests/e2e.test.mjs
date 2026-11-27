import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash,createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
  const riderHistory=await rider('/api/rider/orders')
  assert.ok(riderHistory.orders.some(row=>row.id===id))
  assert.ok(riderHistory.orders.every(row=>row.fulfillment==='delivery'&&row.assigned_to===completed.assigned_to))
  await owner('/api/rider/orders',{expected:403})
  await customer('/api/rider/orders',{expected:403})
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

test('customer tracking secures order snapshots and refreshes at each committed delivery state',async()=>{
  const sku={sku:'TRACK-001',name:'Tracking fixture',category:'fresh',unit:'pc',step:2,price:2500,stock:30}
  const {id:productId}=await action(owner,'/admin/products',sku,201)
  const imageBytes=await readFile(new URL('../public/catalog/01.webp',import.meta.url))
  const media=await owner('/api/admin/products/'+productId+'/image',{method:'POST',raw:imageBytes,headers:{'Content-Type':'image/webp'}})
  const orderData={fulfillment:'delivery',method:'cash',slot:await available('delivery'),addressId:'demo-address',items:[item(productId,2)]}
  const {id}=await place(customer,orderData)
  const path='/api/orders/'+id
  const placed=await customer(path)
  const summary=version=>path+'?tracking='+encodeURIComponent(version)
  assert.equal(placed.payment_status,'cash_due')
  assert.equal(placed.subtotal,5000)
  assert.equal(placed.items[0].image,media.image)
  assert.deepEqual(await customer(summary(placed.trackingVersion)),{unchanged:true})
  await anonymous(summary(placed.trackingVersion),{expected:404})
  await rider(summary(placed.trackingVersion),{expected:404})
  await action(owner,'/admin/products/'+productId,{...sku,name:'Updated catalog item',price:3000,step:1},200,'PUT')
  await owner('/api/admin/products/'+productId+'/image',{method:'DELETE'})
  assert.deepEqual((await customer(path)).items,placed.items)
  assert.deepEqual((await owner(path)).items,placed.items)
  assert.deepEqual([placed.items[0].name,placed.items[0].price,placed.items[0].step,placed.items[0].quantity],['Tracking fixture',2500,2,4])
  assert.ok((await owner('/api/orders?status=placed')).orders.some(order=>order.id===id))
  await action(owner,'/orders/'+id+'/shortage',{productId,reason:'Replacement pack pending.'})
  const noted=await customer(summary(placed.trackingVersion))
  assert.equal(noted.status,'placed')
  assert.equal(noted.events.at(-1).note,'Item shortage · Tracking fixture · Replacement pack pending.')
  await state(owner,id,'accepted')
  await action(owner,'/orders/'+id+'/assign')
  await state(owner,id,'packing')
  await state(owner,id,'ready')
  const current=await customer(summary(placed.trackingVersion))
  assert.equal(current.status,'ready')
  assert.equal(current.payment_status,'cash_due')
  assert.ok(current.events.every(event=>event.created_at>0))
  const dispatched=await rider('/api/rider/route')
  const riderVersion=version=>'/api/rider/route?v='+encodeURIComponent(version)
  assert.ok(dispatched.orders.some(order=>order.id===id))
  assert.deepEqual(await rider(riderVersion(dispatched.version)),{unchanged:true})
  await customer(riderVersion(dispatched.version),{expected:403})
  await state(rider,id,'out_for_delivery')
  const routed=await rider(riderVersion(dispatched.version))
  assert.equal(routed.orders.find(order=>order.id===id).status,'out_for_delivery')
  assert.notEqual(dispatched.version,routed.version)
  await state(owner,id,'completed',{},409)
  const updates=await Promise.allSettled([
    state(rider,id,'completed',{cash:placed.total}),
    state(owner,id,'cancelled'),
  ])
  assert.equal(updates[0].status,'fulfilled')
  assert.equal(updates[1].status,'rejected')
  const completed=await customer(summary(current.trackingVersion))
  assert.equal(completed.status,'completed')
  assert.equal(completed.payment_status,'cash_collected')
  assert.equal(completed.events.filter(event=>event.status==='completed').length,1)
  assert.equal(await stock(productId),26)
  assert.equal((await rider(path)).address,null)
  await action(owner,'/orders/'+id+'/reconcile')
  assert.equal((await customer(path)).reconciled,1)

  const {id:race}=await place(customer,{...orderData,slot:await available('delivery')})
  await state(owner,race,'accepted')
  await action(owner,'/orders/'+race+'/assign')
  await state(owner,race,'packing')
  await state(owner,race,'ready')
  const contenders=await Promise.allSettled([state(owner,race,'cancelled'),state(rider,race,'out_for_delivery')])
  assert.deepEqual(contenders.map(result=>result.status).sort(),['fulfilled','rejected'])
  const winner=await customer('/api/orders/'+race)
  assert.ok(['cancelled','out_for_delivery'].includes(winner.status))
  assert.equal(winner.payment_status,winner.status==='cancelled'?'void':'cash_due')
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

test('pack variants share discovery while stock, checkout and cancellations use the selected SKU',async()=>{
  const product={name:'Test pack family',category:'pantry',unit:'g',step:250,price:4300,stock:1000,variant_group:' Test Pack '}
  const {id:small}=await action(owner,'/admin/products',{...product,sku:'TEST-VARIANT-S'},201)
  const {id:large}=await action(owner,'/admin/products',{...product,sku:'TEST-VARIANT-L',variant_group:'test pack',step:500},201)
  const current=await anonymous('/api/catalog/'+small)
  assert.equal(current.variant_group,'test pack')
  await action(owner,'/admin/products/'+large,{...product,sku:'TEST-VARIANT-L',step:500,variant_group:undefined},200,'PUT')
  const variants=()=>anonymous('/api/catalog/'+small+'?variants=1')
  assert.deepEqual((await variants()).variants.map(p=>p.id),[small,large])
  const path='/api/admin/products/'+large+'/stock?summary=1'
  await customer(path,{expected:403})
  const {id}=await place(customer,{fulfillment:'pickup',method:'online',slot:await available('pickup'),items:[item(large)]})
  let summary=await owner(path)
  assert.deepEqual([summary.available,summary.reserved],[500,500])
  assert.equal(await stock(small),1000)
  await action(customer,'/orders/'+id+'/test-payment',{result:'paid'})
  summary=await owner(path)
  assert.deepEqual([summary.available,summary.reserved],[500,500])
  await state(owner,id,'cancelled')
  summary=await owner(path)
  assert.deepEqual([summary.available,summary.reserved],[1000,0])
  await owner('/api/admin/products/'+large,{method:'DELETE'})
  assert.deepEqual((await variants()).variants.map(p=>p.id),[small])
})

test('switching off both payment methods closes online checkout without blocking counter sales',async()=>{
  const settings=await owner('/api/admin/settings')
  const checkout={fulfillment:'pickup',method:'cash',slot:await available('pickup'),items:[item('milk')]}
  const {version}=await action(customer,'/quote',checkout)
  try{
    await action(owner,'/admin/settings',{...settings,enable_cod:0,enable_online:0},200,'PUT')
    assert.equal((await anonymous('/api/store')).settings.accepting,0)
    assert.deepEqual(await customer('/api/slots?mode=pickup'),[])
    await action(customer,'/quote',checkout,409)
    await action(customer,'/orders',{...checkout,version,key:crypto.randomUUID()},409)
    await place(owner,pos([item('milk')]))
    await action(owner,'/admin/settings',{...settings,enable_cod:0,enable_online:1},200,'PUT')
    assert.equal((await anonymous('/api/store')).settings.accepting,1)
    await action(customer,'/quote',checkout,409)
    await action(customer,'/quote',{...checkout,method:'online'})
  }finally{await action(owner,'/admin/settings',settings,200,'PUT')}
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

test('checkout racing a price update preserves stock, invoice prices and the refreshed total',async()=>{
  const product={sku:'PRICE-RACE',name:'Price race fixture',category:'fresh',unit:'pc',step:1,price:9000,stock:5}
  const {id}=await action(owner,'/admin/products',product,201)
  const pickup={fulfillment:'pickup',method:'cash',slot:await available('pickup'),items:[item(id)]}
  const quote=await action(customer,'/quote',pickup)
  const submit=action(customer,'/orders',{...pickup,version:quote.version,key:crypto.randomUUID()},201).catch(error=>{
    assert.match(error.message,/"code":"quote_changed"/)
    return null
  })
  await action(owner,'/admin/products/'+id,{...product,price:11000,mrp:11000},200,'PUT')
  const result=await submit
  if(result){
    const [historical]=await instance.readBusiness('SELECT price,line_total FROM order_items WHERE order_id=?',result.id)
    assert.equal(historical.price,9000)
    assert.equal(historical.line_total,quote.total)
  }
  assert.equal(await stock(id),result?4:5)
  await action(customer,'/orders',{...pickup,version:quote.version,key:crypto.randomUUID()},409)
  const {id:next}=await place(customer,pickup)
  const [current]=await instance.readBusiness('SELECT price FROM order_items WHERE order_id=?',next)
  assert.equal(current.price,11000)
  assert.equal(await stock(id),result?3:4)
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

test('public catalog validators recheck stock, price and availability immediately',async()=>{
  const product={sku:'FRESH-VALIDATOR',name:'Validator fixture',category:'fresh',unit:'pc',step:1,price:4000,stock:4}
  const {id}=await action(owner,'/admin/products',product,201)
  const detail='/api/catalog/'+id,search='/api/catalog?q=fresh+validator'
  const read=(path,tag)=>fetch(instance.base+path,{headers:tag?{'If-None-Match':tag}:{}})
  const [initial,list]=await Promise.all([read(detail),read(search)])
  assert.equal(initial.headers.get('cache-control'),'public, no-cache')
  assert.equal((await initial.json()).stock,4)
  assert.equal((await list.json()).products[0].price,4000)
  const tag=initial.headers.get('etag'),listTag=list.headers.get('etag')
  assert.ok(tag&&listTag)
  assert.equal((await read(detail,'W/'+tag)).status,304)
  assert.equal((await read(search,listTag)).status,304)
  await action(owner,'/admin/products/'+id+'/stock',{quantity:-2,reason:'adjustment'})
  const stock=await read(detail,tag)
  assert.equal(stock.status,200)
  assert.equal((await stock.json()).stock,2)
  await action(owner,'/admin/products/'+id,{...product,price:4200},200,'PUT')
  const changed=await read(search,listTag)
  assert.equal(changed.status,200)
  assert.equal((await changed.json()).products[0].price,4200)
  await action(owner,'/admin/products/'+id,{...product,active:0},200,'PUT')
  const hidden=await read(detail,tag)
  assert.equal(hidden.status,404)
  assert.equal(hidden.headers.get('cache-control'),'no-store')
  const privateResponse=await fetch(instance.base+'/api/orders')
  assert.equal(privateResponse.headers.get('etag'),null)
  assert.equal(privateResponse.headers.get('cache-control'),'no-store')
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

test('staging authorizes only the designated customer session for COD pickup and delivery',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'kirana-preview-fixture-')),file=join(tmp,'sessions.sql')
  const email='checkout-fixture@gmail.com'
  const sha=value=>createHash('sha256').update(value).digest('hex')
  const selected='a'.repeat(64),other='b'.repeat(64),revoked='c'.repeat(64),ownerToken='d'.repeat(64)
  const rows=[[selected,'demo-customer',sha(email)],[other,'demo-customer',null],[revoked,'demo-customer',sha('previous@gmail.com')],[ownerToken,'demo-owner',sha(email)]]
  await writeFile(file,`INSERT INTO sessions(hash,account_id,expires_at,staging_checkout) VALUES
    ${rows.map(([token,account,grant])=>`('${sha(token)}','${account}',unixepoch()+3600,${grant?"'"+grant+"'":'NULL'})`).join(',')};`)
  let staging
  try{
    staging=await harness(file,{entry:'production',mode:'staging',vars:{STAGING_CHECKOUT_EMAILS:email}})
    const guest=session(staging.base)
    const as=token=>(path,options={})=>guest(path,{...options,headers:{...options.headers,Cookie:'kirana_session='+token}})
    const approved=as(selected)
    const [persisted]=await staging.readBusiness('SELECT accepting FROM settings WHERE id=1')
    assert.equal(persisted.accepting,1)
    for(const user of [guest,as(other),as(revoked),as(ownerToken)]){
      assert.equal((await user('/api/store')).settings.accepting,0)
      assert.deepEqual(await user('/api/slots?mode=pickup'),[])
    }
    const store=await approved('/api/store')
    assert.equal(store.settings.accepting,1)
    assert.equal(store.settings.enable_online,0)
    assert.equal(store.local,false)
    for(const fulfillment of ['pickup','delivery']){
      const slots=await approved('/api/slots?mode='+fulfillment)
      const payload={fulfillment,method:'cash',slot:slots[0].start,items:[item('milk')],
        ...(fulfillment==='delivery'?{addressId:'demo-address'}:{})}
      await action(as(other),'/quote',payload,503)
      await action(as(revoked),'/orders',{...payload,key:crypto.randomUUID(),version:'untrusted'},503)
      const quote=await action(approved,'/quote',payload)
      const result=await action(approved,'/orders',{...payload,key:crypto.randomUUID(),version:quote.version},201)
      assert.equal((await approved('/api/orders/'+result.id)).payment_status,'cash_due')
    }
    const [orders]=await staging.readBusiness('SELECT COUNT(*) AS count FROM orders')
    assert.equal(orders.count,2)
  }finally{
    await staging?.stop()
    await rm(tmp,{recursive:true,force:true})
  }
})

test('Razorpay webhook replays are scoped to stored test links and exact amounts',async()=>{
  const secret='fixture-webhook-local-only'
  const seed=fileURLToPath(new URL('./razorpay-fixture.sql',import.meta.url))
  const staging=await harness(seed,{entry:'production',mode:'staging',vars:{
    RAZORPAY_KEY_ID:'rzp_test_qa',RAZORPAY_KEY_SECRET:'fixture-provider-key',RAZORPAY_WEBHOOK_SECRET:secret,
  }})
  try{
    const note={event:'payment_link.paid',payload:{
      payment_link:{entity:{id:'plink_QATEST123',reference_id:'fixture-payment-reference',amount:100,currency:'INR',amount_paid:100}},
      payment:{entity:{id:'pay_QATEST123',status:'captured',amount:100,currency:'INR'}},
    }}
    const post=async(body,signature)=>fetch(staging.base+'/api/webhooks/razorpay',{
      method:'POST',headers:{'Content-Type':'application/json','X-Razorpay-Signature':signature},body,
    })
    const body=JSON.stringify(note),signature=createHmac('sha256',secret).update(body).digest('hex')
    assert.equal((await post(body,'0'.repeat(64))).status,403)
    assert.equal((await post(body+' ',signature)).status,403)
    const altered=JSON.stringify({...note,payload:{...note.payload,payment:{entity:{...note.payload.payment.entity,amount:50}}}})
    assert.equal((await post(altered,createHmac('sha256',secret).update(altered).digest('hex'))).status,200)
    const read=()=>staging.readBusiness('SELECT status,payment_id FROM test_payments')
    assert.deepEqual((await read()).map(row=>[row.status,row.payment_id]),[['open',null]])
    assert.equal((await post(body,signature)).status,200)
    assert.equal((await post(body,signature)).status,200)
    assert.deepEqual((await read()).map(row=>[row.status,row.payment_id]),[['paid','pay_QATEST123']])
  }finally{await staging.stop()}
})

test('fulfillment switches govern slots, quotes and new orders for all four combinations',async()=>{
  const baseline=await owner('/api/admin/settings')
  assert.deepEqual([baseline.enable_delivery,baseline.enable_pickup],[1,1])
  const modes=['delivery','pickup']
  const initial=await Promise.all(modes.map(mode=>available(mode)))
  const requests=Object.fromEntries(modes.map((fulfillment,index)=>[fulfillment,{
    fulfillment,slot:initial[index],method:'cash',items:[item('chips')],
    ...(fulfillment==='delivery'?{addressId:'demo-address'}:{}),
  }]))
  const prepare=async mode=>({...requests[mode],version:(await action(customer,'/quote',requests[mode])).version,key:crypto.randomUUID()})
  const stale=Object.fromEntries(await Promise.all(modes.map(async mode=>[mode,await prepare(mode)])))
  try{
    for(const [delivery,pickup] of [[1,1],[1,0],[0,1],[0,0]]){
      const updates={...baseline,enable_delivery:delivery,enable_pickup:pickup}
      await action(customer,'/admin/settings',updates,403,'PUT')
      await action(owner,'/admin/settings',updates,200,'PUT')
      const {settings}=await anonymous('/api/store')
      assert.deepEqual([settings.enable_delivery,settings.enable_pickup,settings.accepting],[delivery,pickup,Number(delivery||pickup)])
      for(const [index,mode] of modes.entries()){
        const enabled=[delivery,pickup][index]
        const slots=await anonymous('/api/slots?mode='+mode)
        assert.equal(Boolean(slots.length),Boolean(enabled))
        if(enabled){
          const {id}=await action(customer,'/orders',await prepare(mode),201)
          assert.equal((await customer('/api/orders/'+id)).fulfillment,mode)
        }else{
          const before=await stock('chips')
          const expectedCode=delivery||pickup?'fulfillment_unavailable':'store_paused'
          assert.equal((await action(customer,'/quote',requests[mode],409)).code,expectedCode)
          assert.equal((await action(customer,'/orders',stale[mode],409)).code,expectedCode)
          assert.equal(await stock('chips'),before)
        }
      }
    }
    const {enable_delivery,enable_pickup,...legacy}=await owner('/api/admin/settings')
    await action(owner,'/admin/settings',legacy,200,'PUT')
    const saved=await owner('/api/admin/settings')
    assert.deepEqual([saved.enable_delivery,saved.enable_pickup],[0,0])
    await action(owner,'/admin/settings',{...saved,enable_delivery:2},400,'PUT')
    assert.equal((await anonymous('/api/catalog/chips')).id,'chips')
  }finally{await action(owner,'/admin/settings',baseline,200,'PUT')}
})

test('a fulfillment switch races safely with checkout and preserves pending payments and counter sales',async()=>{
  const baseline=await owner('/api/admin/settings')
  const pendingRequest={fulfillment:'pickup',method:'online',slot:await available('pickup'),items:[item('tea')]}
  const pendingQuote=await action(customer,'/quote',pendingRequest)
  const pendingPayload={...pendingRequest,version:pendingQuote.version,key:crypto.randomUUID()}
  const {id:pending}=await action(customer,'/orders',pendingPayload,201)
  await action(customer,'/cart',{items:[item('tea')]},200,'PUT')
  const request={...pendingRequest,method:'cash',items:[item('chips')]}
  const {version}=await action(customer,'/quote',request)
  const counterBefore=await stock('chips')
  const disable={...baseline,enable_delivery:0,enable_pickup:0}
  const attempts=Array.from({length:4},()=>({...request,version,key:crypto.randomUUID()}))
  try{
    const inFlight=attempts.map(async payload=>{
      try{return (await action(customer,'/orders',payload,201)).id}
      catch(error){assert.match(String(error),/409/);return null}
    })
    await action(owner,'/admin/settings',disable,200,'PUT')
    const settled=(await Promise.all(inFlight)).filter(Boolean)
    const latest=await owner('/api/admin/settings')
    for(const id of settled){
      const [row]=await instance.readBusiness('SELECT config_revision FROM orders WHERE id=?',id)
      assert.ok(row.config_revision<latest.revision)
    }
    const blocked=await Promise.all(Array.from({length:4},()=>action(customer,'/orders',
      {...request,version,key:crypto.randomUUID()},409)))
    assert.ok(blocked.every(response=>response.code==='store_paused'))
    assert.equal(await stock('chips'),counterBefore-settled.length*90)
    assert.deepEqual((await customer('/api/cart')).items,[item('tea')])
    assert.deepEqual(await action(customer,'/orders',pendingPayload),{id:pending,replayed:true})
    await action(customer,'/orders/'+pending+'/test-payment',{result:'paid'})
    for(const next of ['accepted','packing','ready','completed'])await state(owner,pending,next)
    assert.equal((await customer('/api/orders/'+pending)).payment_status,'paid')
    await action(customer,'/orders/'+pending+'/cases',{kind:'refund',reason:'Test refund while paused'},201)
    const opened=(await owner('/api/admin/cases')).find(entry=>entry.order_id===pending)
    await action(owner,'/admin/cases/'+opened.id,{status:'approved',amount:100})
    assert.equal((await customer('/api/orders/'+pending)).refunds[0].amount,100)
    const walkIn=await place(owner,pos([item('chips')]))
    assert.equal((await owner('/api/orders/'+walkIn.id)).status,'completed')
    assert.equal(await stock('chips'),counterBefore-(settled.length+1)*90)
    await action(owner,'/admin/products/chips/stock',{quantity:90,reason:'receipt'})
    assert.equal(await stock('chips'),counterBefore-settled.length*90)
  }finally{await action(owner,'/admin/settings',baseline,200,'PUT')}
})

test('versioned polling endpoints return unchanged until order or summary state mutates',async()=>{
  const list=await owner('/api/orders')
  assert.ok(list.version)
  assert.deepEqual(await owner('/api/orders?v='+encodeURIComponent(list.version)),{unchanged:true})
  const summary=await owner('/api/admin/summary?days=1')
  assert.ok(summary.version)
  assert.deepEqual(await owner('/api/admin/summary?days=1&v='+encodeURIComponent(summary.version)),{unchanged:true})
  const sale=await place(owner,pos([item('chips')]))
  const updatedList=await owner('/api/orders?v='+encodeURIComponent(list.version))
  assert.ok(updatedList.orders.some(row=>row.id===sale.id))
  const updatedSummary=await owner('/api/admin/summary?days=1&v='+encodeURIComponent(summary.version))
  assert.equal(updatedSummary.metrics.walk_in,summary.metrics.walk_in+1)
})

test('complete five-customer connected lifecycle synchronizes status, inventory, cash and invoices',async()=>{
  const baseline=await owner('/api/admin/settings')
  await action(owner,'/admin/settings',{...baseline,open_hour:0,close_hour:24,preparation:0,delivery_capacity:25},200,'PUT')
  try{
    const {id:productId}=await action(owner,'/admin/products',{sku:'FIVE-STOP-1',name:'Connected 5-stop pack',category:'fresh',unit:'pc',step:1,price:4500,stock:20},201)
    const slot=await available('delivery')
    const pins=[
      [17.41694,78.41768],[17.41951,78.42982],[17.40906,78.43454],[17.40512,78.42115],[17.41485,78.40985],
    ]
    const buyers=[],orderIds=[]
    const initialRoute=await rider('/api/rider/route')
    for(const [i,[latitude,longitude]] of pins.entries()){
      const buyer=session(instance.base)
      await action(buyer,'/auth/register-local',{name:'Five Stop Customer '+(i+1),phone:'987654321'+i})
      const address=await action(buyer,'/addresses',{label:'Home',recipient:'Five Stop Customer '+(i+1),phone:'987654321'+i,line1:'House '+(i+1),locality:'Banjara Hills',pin:'500034',latitude,longitude},201)
      assert.equal(address.serviceable,true)
      const placed=await place(buyer,{fulfillment:'delivery',method:'cash',slot,addressId:address.id,items:[item(productId,1)]})
      buyers.push(buyer)
      orderIds.push(placed.id)
    }
    const ownerOrders=await owner('/api/orders?status=placed')
    for(const orderId of orderIds)assert.ok(ownerOrders.orders.some(row=>row.id===orderId))
    for(const orderId of orderIds){
      await state(owner,orderId,'accepted')
      await state(owner,orderId,'packing')
      await state(owner,orderId,'ready')
      await action(owner,'/orders/'+orderId+'/assign')
    }
    const assigned=await rider('/api/rider/route?v='+encodeURIComponent(initialRoute.version))
    assert.equal(assigned.orders.length,5)
    for(const orderId of orderIds)assert.ok(assigned.orders.some(stop=>stop.id===orderId))
    for(const [i,orderId] of orderIds.entries()){
      const buyer=buyers[i]
      const before=await buyer('/api/orders/'+orderId)
      await state(rider,orderId,'out_for_delivery')
      const outCustomer=await buyer('/api/orders/'+orderId+'?tracking='+encodeURIComponent(before.trackingVersion))
      assert.equal(outCustomer.status,'out_for_delivery')
      assert.equal((await owner('/api/orders/'+orderId)).status,'out_for_delivery')
      await state(rider,orderId,'completed',{cash:before.total})
      const doneCustomer=await buyer('/api/orders/'+orderId+'?tracking='+encodeURIComponent(outCustomer.trackingVersion))
      assert.equal(doneCustomer.status,'completed')
      assert.equal(doneCustomer.payment_status,'cash_collected')
      assert.ok(doneCustomer.invoice&&doneCustomer.items.length===1)
      assert.equal((await owner('/api/orders/'+orderId)).status,'completed')
      await action(owner,'/orders/'+orderId+'/reconcile')
      assert.equal((await owner('/api/orders/'+orderId)).reconciled,1)
    }
    assert.equal(await stock(productId),15)
    assert.equal((await rider('/api/rider/route')).orders.length,0)
    assert.equal((await rider('/api/rider/route')).summary.cash,0)
  }finally{await action(owner,'/admin/settings',baseline,200,'PUT')}
})
