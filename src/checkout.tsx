import { flushSync } from 'react-dom'
import { checkoutDisplay,loadCheckout } from './razorpay-checkout'
import type { PaymentChallenge,PaymentProof } from './razorpay-checkout'
import { lazy,Suspense,useCallback,useEffect,useMemo,useRef,useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ArrowLeft,ArrowRight,Check,Clock3,CreditCard,FileDown,MapPin,Minus,Package,Plus,ShoppingBasket,Store,Truck,Wallet } from 'lucide-react'
import { api,checkoutDraftKey,date,displayOrder,invoice,message,pack,pretty,readCheckoutDraft,rupee,saveCheckoutDraft,send,timestamp,windowLabel } from './lib'
import type { Account,Address,CartLine,OrderDetail,OrderRow,Product,Quote,Shop,Slot } from './lib'
import { Empty,ErrorText,Sheet,Status,Success } from './ui'
const MapPinView=lazy(()=>import('./MapPin'))

export function AddressForm({shop,account,saved}:{shop:Shop;account:Account; saved:(a:Address)=>void}){
  const [point,setPoint]=useState<{latitude:number;longitude:number}|null>(null)
  const [map,setMap]=useState(false)
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setError('');setBusy(true)
    try {const data=Object.fromEntries(new FormData(event.currentTarget));saved(await send<Address>('/addresses',{...data,...point}))}
    catch(e){setError(message(e))}finally{setBusy(false)}
  }
  return <form className="stack address-form" onSubmit={save}>
    <ErrorText text={error}/>
    <div className="form-grid">
      <label>Address label<input name="label" defaultValue="Home" required maxLength={30}/></label>
      <label>Recipient<input name="recipient" defaultValue={account.name} required maxLength={80}/></label>
      <label>Phone<input name="phone" type="tel" defaultValue={account.phone} required maxLength={22}/></label>
      <label>PIN code<input name="pin" inputMode="numeric" pattern="[0-9]{6}" required maxLength={6}/></label>
      <label className="span-full">Street and house number<input name="line1" required maxLength={200}/></label>
      <label>Locality<input name="locality" required maxLength={70}/></label><label>Landmark<input name="landmark" maxLength={100}/></label>
    </div>
    <div className="actions"><button type="button" className="button secondary" onClick={()=>{setMap(!map);if(!point)setPoint({latitude:shop.latitude,longitude:shop.longitude})}}><MapPin size={16}/> {map?'Hide pin':'Set pin'}</button>
      <button type="button" className="button secondary" onClick={()=>navigator.geolocation?.getCurrentPosition(pos=>{setPoint({latitude:pos.coords.latitude,longitude:pos.coords.longitude});setMap(true)},e=>setError(e.message),{timeout:8000})}>Use my location</button>
      {point&&<button type="button" className="text-arrow" onClick={()=>{setPoint(null);setMap(false)}}>Clear pin</button>}
    </div>
    {map&&point&&<><Suspense fallback={<p>Loading pin editor…</p>}><MapPinView {...point} set={(latitude,longitude)=>setPoint({latitude,longitude})}/></Suspense>
      <div className="form-grid"><label>Latitude<input type="number" min="-90" max="90" step="any" value={point.latitude} onChange={e=>setPoint({...point,latitude:Number(e.target.value)})}/></label><label>Longitude<input type="number" min="-180" max="180" step="any" value={point.longitude} onChange={e=>setPoint({...point,longitude:Number(e.target.value)})}/></label></div></>}
    <button className="button primary" type="submit" disabled={busy}>Save address</button>
  </form>
}

type CartProps={shop:Shop;refreshShop:()=>Promise<void>;account:Account|null;startAtCheckout?:boolean;cart:CartLine[];change:(p:Product,n:number)=>void;onClose:()=>void;requireLogin:()=>void;complete:(id:string)=>void}
export function Cart({shop,refreshShop,account,cart,change,onClose,requireLogin,complete,startAtCheckout=false}:CartProps){
  const [stage,setStage]=useState<'basket'|'details'>(startAtCheckout?'details':'basket')
  const [selection,setMode]=useState<'pickup'|'delivery'>(shop.enable_delivery?'delivery':'pickup')
  const delivery=Boolean(shop.enable_delivery),pickup=Boolean(shop.enable_pickup)
  const mode=(selection==='delivery'&&delivery)||!pickup?'delivery':'pickup'
  useEffect(()=>{if((delivery||pickup)&&selection!==mode)setMode(mode)},[delivery,pickup,selection,mode])
  const [availability,setAvailability]=useState<'checking'|'ready'|'error'>('checking')
  const canOrder=availability==='ready'&&Boolean(shop.accepting&&(delivery||pickup))
  const [method,setMethod]=useState<'cash'|'online'>(shop.enable_cod?'cash':'online')
  useEffect(()=>{
    if(method==='cash'&&!shop.enable_cod&&shop.enable_online)setMethod('online')
    if(method==='online'&&!shop.enable_online&&shop.enable_cod)setMethod('cash')
  },[method,shop.enable_cod,shop.enable_online])
  const [addresses,setAddresses]=useState<Address[]>([])
  const [addressId,setAddress]=useState('')
  const [adding,setAdding]=useState(false)
  const [slots,setSlots]=useState<Slot[]>([])
  const [slotMode,setSlotMode]=useState<typeof mode|null>(null)
  const [slot,setSlot]=useState(0)
  const [note,setNote]=useState('')
  const [quote,setQuote]=useState<Quote|null>(null)
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [checking,setChecking]=useState(false)
  const [slotRevision,setSlotRevision]=useState(0)
  const [draftKey,setDraftKey]=useState('')
  const [reviewedPayload,setReviewedPayload]=useState('')
  const [reviewedRevision,setReviewedRevision]=useState<number|null>(null)
  const subtotal=cart.reduce((s,l)=>s+l.steps*l.product.price,0)
  const payload=useMemo(()=>({
    fulfillment:mode,method,...(mode==='delivery'?{addressId}:{}),slot,note,items:cart.map(l=>({id:l.product.id,steps:l.steps})).sort((a,b)=>a.id.localeCompare(b.id)),
  }),[mode,method,addressId,slot,note,cart])
  const serialized=JSON.stringify(payload)
  const title=stage==='basket'||!canOrder?'Your basket':'Checkout'
  useEffect(()=>{
    let active=true
    refreshShop().then(()=>{if(active)setAvailability('ready')},()=>{if(active)setAvailability('error')})
    return ()=>{active=false}
  },[refreshShop])
  async function retryAvailability(){
    setError('')
    setAvailability('checking')
    try{await refreshShop();setAvailability('ready')}catch{setAvailability('error')}
  }
  useEffect(()=>{
    if(stage!=='details'||!canOrder||mode!=='delivery'||account?.role!=='customer')return
    let active=true
    api<Address[]>('/addresses').then(a=>{if(active){setAddresses(a);setAddress(v=>v||a[0]?.id||'')}},e=>{if(active)setError(message(e))})
    return ()=>{active=false}
  },[stage,canOrder,mode,account?.id,account?.role])
  useEffect(()=>{
    if(stage!=='details'||!canOrder)return
    const abort=new AbortController()
    setSlots([]);setSlot(0);setSlotMode(null)
    api<Slot[]>('/slots?mode='+mode,{signal:abort.signal}).then(r=>{
      if(abort.signal.aborted)return
      setSlots(r);setSlot(r[0]?.start||0);setSlotMode(mode)
      if(!r.length)void refreshShop().catch(()=>{})
    },e=>{if(!abort.signal.aborted)setError(message(e))})
    return ()=>abort.abort()
  },[stage,canOrder,mode,slotRevision,refreshShop])
  useEffect(()=>{
    setQuote(null);setDraftKey('');setReviewedPayload('')
    if(stage!=='details'||!canOrder||!account||!cart.length||slotMode!==mode||!slot||(mode==='delivery'&&!addressId)){
      setChecking(false)
      return
    }
    const abort=new AbortController()
    setChecking(true)
    const timer=setTimeout(async()=>{
      try{
        const draft=await checkoutDraftKey('customer:'+account.id,serialized)
        if(abort.signal.aborted)return
        const remembered=readCheckoutDraft(draft)
        const next=remembered?.quote??await api<Quote>('/quote',{
          method:'POST',headers:{'Content-Type':'application/json'},body:serialized,signal:abort.signal,
        })
        if(!abort.signal.aborted){setQuote(next);setDraftKey(draft);setReviewedPayload(serialized);setReviewedRevision(shop.revision)}
      }catch(e){
        if(!abort.signal.aborted){
          setError(message(e))
          const code=(e as {code?:string}).code
          if(code==='fulfillment_unavailable'||code==='store_paused'||code==='payment_unavailable')void refreshShop().catch(()=>{})
        }
      }
      finally{if(!abort.signal.aborted)setChecking(false)}
    },260)
    return ()=>{clearTimeout(timer);abort.abort()}
  },[stage,canOrder,account?.id,serialized,slotRevision,slotMode,shop.revision,refreshShop])
  const changed=()=>{setQuote(null);setError('');setReviewedPayload('')}
  async function place(){
    if(!canOrder||!quote||!draftKey||reviewedPayload!==serialized||reviewedRevision!==shop.revision)return
    setError('');setBusy(true)
    const previous=readCheckoutDraft(draftKey)
    const key=previous?.key??crypto.randomUUID()
    try{
      saveCheckoutDraft(draftKey,{key,quote})
      const result=await send<{id:string}>('/orders',{...payload,version:quote.version,key})
      sessionStorage.removeItem(draftKey)
      complete(result.id)
    }catch(e){
      setError(message(e))
      const code=(e as {code?:string}).code
      if((e as {status?:number}).status===409||code==='payment_unavailable'){
        sessionStorage.removeItem(draftKey)
        setQuote(null);setReviewedPayload('')
        if(code==='fulfillment_unavailable'||code==='store_paused'||code==='payment_unavailable'||code==='quote_changed')void refreshShop().catch(()=>{})
        setSlotRevision(n=>n+1)
      }
    }finally{setBusy(false)}
  }
  return <Sheet title={title} onClose={onClose}>
    <ErrorText text={error}/>
    {!cart.length?<Empty title="Your basket is empty" detail="Add something fresh to get started." action={<button className="button primary" onClick={onClose}>Continue shopping</button>}/>
    :stage==='basket'||!canOrder?<div className="stack">
      <div className="cart-list">{cart.map(({product,steps})=><div className="cart-line" key={product.id}>
        <div className="cart-image">{product.image?<img src={product.image} alt=""/>:<ShoppingBasket size={22}/>}</div>
        <div className="cart-product"><b>{product.name}</b><small>{pack(product.unit,product.step)}</small><strong>{rupee(product.price*steps)}</strong></div>
        <div className="quantity"><button aria-label={'Remove '+product.name} onClick={()=>change(product,steps<=product.min_steps?0:steps-1)}><Minus size={14}/></button><b>{steps}</b><button aria-label={'Increase '+product.name} disabled={steps>=Math.min(product.max_steps,Math.floor(product.stock/product.step))} onClick={()=>change(product,steps+1)}><Plus size={14}/></button></div>
      </div>)}</div>
      <div className="summary-line"><b>Subtotal</b><b>{rupee(subtotal)}</b></div>
      {canOrder?<button className="button primary full" onClick={()=>{if(account?.role!=='customer'){requireLogin();return}setStage('details')}}>Continue to checkout <ArrowRight size={16}/></button>
        :<><p role="status">{availability==='checking'?'Checking online order availability…':availability==='error'?'Could not check online order availability.':'Online ordering is temporarily unavailable. Your basket is saved.'}</p>
          {availability!=='checking'&&<button type="button" className="button secondary align-start" onClick={()=>void retryAvailability()}>Check availability</button>}</>}
    </div>:<div className="stack">
      <button className="text-arrow align-start" onClick={()=>{changed();setStage('basket')}}><ArrowLeft size={16}/> Back to basket</button>
      <div className="choice-grid">
        {delivery&&<button className={'option '+(mode==='delivery'?'active':'')} aria-pressed={mode==='delivery'} onClick={()=>{if(mode!=='delivery'){changed();setMode('delivery')}}}><Truck size={20}/> Home delivery</button>}
        {pickup&&<button className={'option '+(mode==='pickup'?'active':'')} aria-pressed={mode==='pickup'} onClick={()=>{if(mode!=='pickup'){changed();setMode('pickup')}}}><Store size={20}/> Store pickup</button>}
      </div>
      {mode==='delivery'?<section className="stack compact">
        <div className="summary-line"><b>Delivery address</b><button className="text-arrow" onClick={()=>setAdding(!adding)}>{adding?'Cancel':'Add new'}</button></div>
        {adding&&account&&<AddressForm shop={shop} account={account} saved={a=>{setAddresses([a,...addresses]);setAddress(a.id);setAdding(false);changed()}}/>}
        {!!addresses.length&&<select aria-label="Delivery address" value={addressId} onChange={e=>{changed();setAddress(e.target.value)}}>{addresses.map(a=><option key={a.id} value={a.id}>{a.label} · {a.line1}, {a.pin}</option>)}</select>}
        {!addresses.length&&!adding&&<p className="muted">Add a delivery address to see whether the store can reach you.</p>}
      </section>:<div className="info-box"><Store size={18}/><span><b>{shop.name}</b><small>{shop.address}</small></span></div>}
      <label><span><Clock3 size={16}/> {mode==='delivery'?'Delivery window':'Pickup window'}</span>{slots.length?<select value={slot} onChange={e=>{changed();setSlot(Number(e.target.value))}}>{slots.map(s=><option value={s.start} key={s.start}>{windowLabel(s.start,s.end)}</option>)}</select>:<span className="muted">{slotMode===null?'Checking available windows…':delivery&&pickup?(mode==='delivery'?'No available windows. Try store pickup.':'No available windows. Try home delivery.'):'No windows are available right now.'}</span>}</label>
      <label>Order note <input placeholder="Optional instructions" value={note} maxLength={280} onChange={e=>{changed();setNote(e.target.value)}}/></label>
      <div><b>Payment</b><div className="choice-grid pad-top">{Boolean(shop.enable_cod)&&<button className={'option '+(method==='cash'?'active':'')} onClick={()=>{changed();setMethod('cash')}}><Wallet size={19}/>{mode==='pickup'?'Cash at pickup':'Cash on delivery'}</button>}
      {Boolean(shop.enable_online)&&<button className={'option '+(method==='online'?'active':'')} onClick={()=>{changed();setMethod('online')}}><CreditCard size={19}/> Online payment</button>}</div></div>
      <div className="bill">
        <div className="summary-line"><span>Items</span><span>{rupee(quote?.subtotal??subtotal)}</span></div>
        <div className="summary-line"><span>{mode==='pickup'?'Pickup':'Delivery'} fee</span><span>{rupee(quote?.fees??(mode==='delivery'&&subtotal<shop.free_delivery?shop.delivery_fee:0))}</span></div>
        {!!quote?.tax&&<div className="summary-line muted"><span>Tax included</span><span>{rupee(quote.tax)}</span></div>}
        {quote&&<div className="summary-line total"><b>Total</b><b>{rupee(quote.total)}</b></div>}
      </div>
      <button className="button primary full" disabled={busy||checking||!quote||reviewedPayload!==serialized||reviewedRevision!==shop.revision||slotMode!==mode} onClick={place}>{busy?'Placing order…':checking?'Checking total…':'Place order'} <ArrowRight size={16}/></button>
    </div>}
  </Sheet>
}

const closedOrders=new Set(['completed','cancelled','rejected','failed'])
const fulfillmentName=(value:string)=>value==='delivery'?'Home delivery':value==='pickup'?'Store pickup':pretty(value)
const paymentName=(value:string)=>value==='online'?'Online · Razorpay':value==='cash'?'Cash':pretty(value)
function statusName(order:Pick<OrderRow,'status'|'fulfillment'>,status=order.status){
  if(status==='ready')return order.fulfillment==='pickup'?'Ready for pickup':'Ready for delivery'
  if(status==='completed')return order.fulfillment==='pickup'?'Collected':order.fulfillment==='delivery'?'Delivered':'Completed'
  return ({awaiting_payment:'Awaiting payment',placed:'Order confirmed',accepted:'Accepted by store',packing:'Preparing your order',
    out_for_delivery:'Out for delivery',failed:'Delivery unsuccessful',cancelled:'Cancelled',rejected:'Declined by store'} as Record<string,string>)[status]??pretty(status)
}
function paymentStatusName(order:Pick<OrderRow,'payment_status'|'fulfillment'>){
  if(order.payment_status==='paid')return 'Payment successful'
  if(order.payment_status==='cash_due')return order.fulfillment==='pickup'?'Cash due at pickup':'Cash due on delivery'
  return ({unpaid:'Awaiting payment',cash_collected:'Cash collected',refunded:'Refunded',void:'Payment closed'} as Record<string,string>)[order.payment_status]??pretty(order.payment_status)
}

export function OrderList({open,active=true}:{open:(id:string)=>void;active?:boolean}){
  const [orders,setOrders]=useState<OrderRow[]>([])
  const [error,setError]=useState('')
  const [next,setNext]=useState<string|null>(null)
  const [loading,setLoading]=useState(true)
  const pending=useRef<AbortController|null>(null)
  const [paged,setPaged]=useState(false)
  const load=useCallback(async(cursor?:string)=>{
    pending.current?.abort()
    const request=new AbortController()
    pending.current=request;setLoading(true)
    try{
      const data=await api<{orders:OrderRow[];next:string|null}>('/orders'+(cursor?'?before='+encodeURIComponent(cursor):''),{signal:request.signal})
      if(!request.signal.aborted){
        setOrders(previous=>cursor?[...previous,...data.orders]:data.orders);setNext(data.next);setPaged(Boolean(cursor));setError('')
      }
    }catch(e){if(!request.signal.aborted)setError(message(e))}
    finally{if(!request.signal.aborted)setLoading(false)}
  },[])
  useEffect(()=>{
    if(!active)return
    void load()
    return ()=>pending.current?.abort()
  },[active,load])
  const hasOpenOrder=orders.some(order=>!closedOrders.has(order.status))
  useEffect(()=>{
    if(!active||!hasOpenOrder||paged)return
    const refresh=()=>{if(document.visibilityState==='visible')void load()}
    const timer=setInterval(refresh,60000)
    document.addEventListener('visibilitychange',refresh)
    return ()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh)}
  },[active,hasOpenOrder,paged,load])
  return <div className="stack"><ErrorText text={error}/>{loading&&!orders.length?<p>Loading orders…</p>:!orders.length?<Empty title="No orders yet" detail="Your deliveries and pickups will appear here."/>:orders.map(order=><button key={order.id} className="order-row" onClick={()=>open(order.id)}>
    <div><b>{displayOrder(order.id)}</b><small>{timestamp(order.created_at)} · {fulfillmentName(order.fulfillment)}</small></div>
    <div><Status value={order.status} label={statusName(order)}/><small>{paymentStatusName(order)}</small></div><strong>{rupee(order.total)}</strong>
  </button>)}<div className="actions">
    <button className="button secondary" disabled={loading} onClick={()=>void load()}>Refresh orders</button>
    {next&&<button className="button secondary" disabled={loading} onClick={()=>void load(next)}>Load older orders</button>}
  </div></div>
}

function OrderTracking({order}:{order:OrderDetail}){
  const steps=['placed','accepted','packing','ready',...(order.fulfillment==='delivery'?['out_for_delivery']:[]),'completed']
  const statusEvents=new Map<string,OrderDetail['events'][number]>()
  for(const event of order.events)if(!statusEvents.has(event.status))statusEvents.set(event.status,event)
  const pendingOnline=order.payment_method==='online'
  const cancelled=closedOrders.has(order.status)&&order.status!=='completed'
  const entries=[
    {key:'submitted',label:'Order placed',time:order.created_at},
    ...steps.filter(step=>pendingOnline||step!=='placed').filter(step=>!cancelled||statusEvents.has(step)).map(key=>({
      key,label:key==='placed'?'Payment confirmed':statusName(order,key),time:statusEvents.get(key)?.created_at,
    })),
    ...(cancelled?[{key:order.status,label:statusName(order),time:statusEvents.get(order.status)?.created_at??order.updated_at}]:[]),
  ]
  const current=order.status==='awaiting_payment'||!pendingOnline&&order.status==='placed'?'submitted':order.status
  const notes=order.events.filter(event=>event.note)
  return <section className="stack compact" aria-labelledby="tracking-heading">
    <h3 id="tracking-heading">Track your order</h3>
    <ol className="timeline tracking-timeline">{entries.map(entry=><li key={entry.key} aria-current={entry.key===current?'step':undefined}
      className={entry.time?'':'tracking-upcoming'}>
      {entry.time?<Check size={14} aria-hidden="true"/>:<Clock3 size={14} aria-hidden="true"/>}
      <div><strong>{entry.label}</strong><small>{entry.time?timestamp(entry.time):'Upcoming'}</small></div>
    </li>)}</ol>
    {notes.map((event,i)=><p key={i} className="muted">{timestamp(event.created_at)} · {event.note}</p>)}
  </section>
}

type DetailProps={orderId:string;onClose:()=>void;account:Account;shop:Shop;local?:boolean;extra?:(order:OrderDetail,refresh:()=>Promise<void>)=>ReactNode;reorder?:(items:OrderDetail['items'])=>Promise<void>}
export function OrderView({orderId,onClose,account,shop,local=false,extra,reorder}:DetailProps){
  const [order,setOrder]=useState<OrderDetail|null>(null), [error,setError]=useState(''), [ok,setOk]=useState('')
  const [paymentOverlay,setPaymentOverlay]=useState(false)
  const [verifying,setVerifying]=useState(false)
  const [windowElapsed,setWindowElapsed]=useState(false)
  const [kind,setKind]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false)
  const pendingRefresh=useRef<AbortController|null>(null)
  const refresh=useCallback(async(version?:string,silent=false)=>{
    if(silent&&pendingRefresh.current)return
    pendingRefresh.current?.abort()
    const request=new AbortController()
    pendingRefresh.current=request
    try{
      const data=await api<OrderDetail|{unchanged:true}>('/orders/'+orderId+(version?'?tracking='+encodeURIComponent(version):''),{signal:request.signal})
      if(!request.signal.aborted){
        if(!('unchanged' in data))setOrder(data)
        if(!silent)setError('')
      }
    }catch(e){
      if(!request.signal.aborted){
        const status=(e as {status?:number}).status
        if(status===401||status===403||status===404){setOrder(null);setError(message(e))}
        else if(!silent)setError(message(e))
      }
    }
    finally{if(pendingRefresh.current===request)pendingRefresh.current=null}
  },[orderId])
  useEffect(()=>{void refresh();return ()=>{pendingRefresh.current?.abort();pendingRefresh.current=null}},[refresh])
  const trackingStatus=order?.status
  const trackingVersion=order?.trackingVersion
  const awaitingPayment=trackingStatus==='awaiting_payment'
  useEffect(()=>{if(order?.paymentFailed)setVerifying(false)},[order?.paymentFailed])
  const previousPaymentAttempt=Boolean(order?.canReconcilePayment&&!order.paymentFailed)
  const windowEnd=order?.slot_end
  useEffect(()=>{
    if(!windowEnd){setWindowElapsed(false);return}
    const remaining=windowEnd*1000-Date.now()
    setWindowElapsed(remaining<=0)
    if(remaining>0&&remaining<=2_147_483_647){
      const timer=setTimeout(()=>setWindowElapsed(true),remaining)
      return ()=>clearTimeout(timer)
    }
  },[windowEnd])
  const checkFull=Boolean(awaitingPayment||order?.refundPending||order?.cases.some(request=>request.status==='open'))
  useEffect(()=>{
    if(account.role!=='customer'||busy||!trackingStatus||(!checkFull&&closedOrders.has(trackingStatus)))return
    const tick=()=>{if(document.visibilityState==='visible')void refresh(checkFull?undefined:trackingVersion,true)}
    const timer=setInterval(tick,awaitingPayment&&(verifying||previousPaymentAttempt)?15000:45000)
    document.addEventListener('visibilitychange',tick)
    return ()=>{clearInterval(timer);document.removeEventListener('visibilitychange',tick)}
  },[account.role,awaitingPayment,busy,checkFull,previousPaymentAttempt,refresh,trackingStatus,trackingVersion,verifying])
  const operate=async(action:()=>Promise<unknown>,success:string)=>{
    setBusy(true);setError('');setOk('')
    try {await action();setOk(success);await refresh()}catch(e){setError(message(e))}finally{setBusy(false)}
  }
  async function pay(){
    setBusy(true);setError('');setOk('')
    try{
      const challenge=await send<PaymentChallenge>('/orders/'+orderId+'/payment',{})
      const Razorpay=await loadCheckout()
      let proof:PaymentProof|null
      // A native dialog otherwise makes the gateway's independently mounted iframe inert.
      flushSync(()=>setPaymentOverlay(true))
      try{
        proof=await new Promise<PaymentProof|null>(resolve=>{
          new Razorpay({key:challenge.key,order_id:challenge.orderId,amount:challenge.amount,currency:challenge.currency,
            name:shop.name,description:challenge.mode==='test'?'Test order':'Kirana order',config:checkoutDisplay(challenge.mode),
            handler:resolve,modal:{ondismiss:()=>resolve(null)}}).open()
        })
      }finally{setPaymentOverlay(false)}
      if(proof){
        setVerifying(true)
        const result=await send<{state:string}>('/orders/'+orderId+'/payment/verify',proof)
        if(result.state!=='pending')setVerifying(false)
        if(result.state==='refund_review')setOk('Payment arrived after the order closed. The store will review the refund.')
      }
    }catch(e){setError(message(e))}
    finally{await refresh(undefined,true);setBusy(false)}
  }
  async function checkPayment(){
    setBusy(true);setError('');setOk('')
    if(account.role==='customer')setVerifying(true)
    try{
      const prefix=account.role==='owner'?'/admin/orders/':'/orders/'
      const result=await send<{verified:boolean}>(prefix+orderId+'/payment/reconcile',{})
      await refresh()
      setOk(result.verified?'Razorpay verified the payment.':'Razorpay has not confirmed a capture yet.')
    }catch(e){setError(message(e))}finally{setBusy(false)}
  }
  const customer=account.role==='customer'
  const verifyingPayment=customer&&!local&&awaitingPayment&&(verifying||previousPaymentAttempt)
  const canPay=Boolean(shop.accepting&&shop.enable_online&&(
    order?.fulfillment==='pickup'?shop.enable_pickup:shop.enable_delivery))
  return <Sheet title={'Order '+displayOrder(orderId)} onClose={busy?()=>{}:onClose} wide suspended={paymentOverlay}>
    <ErrorText text={error}/><Success text={ok}/>
    {!order&&!error&&<p>Loading order…</p>}
    {!order&&error&&<button type="button" className="button secondary" onClick={()=>void refresh()}>Try again</button>}
    {order&&<div className="stack">
      <div className="order-banner"><div><b>{fulfillmentName(order.fulfillment)}</b><small>Placed {timestamp(order.created_at)}</small></div>
        <div role={customer?'status':undefined}><Status value={order.status} label={customer?statusName(order):undefined}/></div></div>
      {customer&&<small className="muted order-reference">Order reference {order.id}</small>}
      {order.slot_start&&order.slot_end&&<div className="info-box"><Clock3 size={18}/><span>
        <b>{order.fulfillment==='pickup'?'Estimated pickup window':'Estimated delivery window'}</b>
        <small>{windowLabel(order.slot_start,order.slot_end)}</small>
        {customer&&windowElapsed&&!closedOrders.has(order.status)&&!(order.fulfillment==='pickup'&&order.status==='ready')&&order.status!=='awaiting_payment'&&
          <small>The estimated window has passed. Check the latest status or contact the store below.</small>}
      </span></div>}
      {order.fulfillment==='pickup'&&<div className="info-box"><Store size={18}/><span><b>Collect at {order.invoice?.name||shop.name}</b><small>{order.invoice?.address||shop.address}</small></span></div>}
      {order.address&&<div className="info-box"><MapPin size={18}/><span><b>{order.address.recipient} · {order.address.label}</b><small>{order.address.line1}, {order.address.locality} {order.address.pin} · {order.address.phone}</small></span></div>}
      <section className="stack compact"><div className="summary-line"><h3>Purchased items</h3><button className="text-arrow" disabled={busy} onClick={()=>void refresh()}>Refresh</button></div>
        {order.items.map(line=><div className="summary-line order-item" key={line.product_id}>
          <div className="order-item-main"><span className="order-item-image" aria-hidden="true">
            <Package size={19}/>
            {account.role!=='rider'&&line.image&&/^\/(catalog|media)\//.test(line.image)&&<img src={line.image} alt="" loading="lazy" onError={e=>{e.currentTarget.hidden=true}}/>}
          </span><span><strong>{line.name}</strong><small>{pack(line.unit,line.step)} × {line.quantity/line.step} · {rupee(line.price)} per pack</small></span></div>
          <b>{rupee(line.line_total)}</b>
        </div>)}
        <div className="summary-line"><span>Items subtotal</span><span>{rupee(order.subtotal)}</span></div>
        <div className="summary-line"><span>Delivery charge</span><span>{rupee(order.fees)}</span></div>
        {order.tax>0&&<div className="summary-line"><span>Tax included</span><span>{rupee(order.tax)}</span></div>}
        <div className="summary-line total"><b>{['paid','cash_collected','refunded'].includes(order.payment_status)?'Order total':'Total payable'}</b><b>{rupee(order.total)}</b></div>
        <div className="summary-line"><span>{paymentName(order.payment_method)}</span><Status value={order.payment_status}
          label={customer?(verifyingPayment?'Verifying payment':paymentStatusName(order)):undefined}/></div>
      </section>
      {account.role==='customer'&&local&&order.status==='awaiting_payment'&&<div className="info-box stack compact"><b>Local payment simulator</b><span>No money is collected.</span><div className="actions"><button className="button primary" disabled={busy} onClick={()=>void operate(()=>send('/orders/'+orderId+'/test-payment',{result:'paid'}),'Test payment completed.')}>Simulate success</button><button className="button secondary" disabled={busy} onClick={()=>void operate(()=>send('/orders/'+orderId+'/test-payment',{result:'failed'}),'Test payment cancelled.')}>Simulate failure</button></div></div>}
      {account.role==='customer'&&!local&&order.status==='awaiting_payment'&&<div className="info-box stack compact">
        <b>{verifyingPayment?'Verifying payment':'Pay securely with Razorpay'}</b>
        <span>{verifyingPayment?'Waiting for Razorpay to confirm capture. If your account was debited, check the payment before retrying.':
          !canPay?'The store is currently unable to start this payment. You can still check a previous payment or cancel the reservation.':
          order.paymentFailed?'A payment attempt failed. You can retry while this reservation is open.':'Your items are reserved for up to 15 minutes. Check this order before retrying if payment is interrupted.'}</span>
        <div className="actions">
          <button className="button primary" disabled={busy||!canPay} onClick={()=>void pay()}>Pay {rupee(order.total)}</button>
          {order.canReconcilePayment&&<button className="button secondary" disabled={busy} onClick={()=>void checkPayment()}>Check Razorpay payment</button>}
          <button className="button secondary" disabled={busy} onClick={()=>void operate(
            ()=>send('/orders/'+orderId+'/payment/cancel',{}),'Reservation cancelled.'
          )}>Cancel reservation</button>
        </div>
      </div>}
      {customer&&!local&&order.status!=='awaiting_payment'&&order.canReconcilePayment&&<div className="info-box stack compact">
        <span>If your account was debited before the reservation closed, check the original payment here.</span>
        <button className="button secondary" disabled={busy} onClick={()=>void checkPayment()}>Check Razorpay payment</button>
      </div>}
      {order.refundFailed&&<p className="muted">Razorpay reported a failed refund. The store needs to review it.</p>}
      {order.refundPending&&!order.refundFailed&&<p className="muted">Razorpay refund pending confirmation.</p>}
      {order.liveRefunds?.map(refund=><button key={refund.id} className="button secondary" disabled={busy} onClick={()=>{
        if(window.confirm('Submit this live Razorpay refund of '+rupee(refund.amount)+'?')){
          void operate(()=>send('/admin/payments/refunds/'+refund.id+'/submit',{}),'Refund status refreshed.')
        }
      }}>{refund.status==='queued'?'Submit live refund':'Check live refund'} · {rupee(refund.amount)}</button>)}
      {account.role==='owner'&&order.canReconcilePayment&&<button className="button secondary" disabled={busy} onClick={()=>void checkPayment()}>Check Razorpay payment</button>}
      {extra?.(order,refresh)}
      {account.role!=='rider'&&order.status!=='awaiting_payment'&&<div className="actions">
        {(order.payment_status==='paid'||order.payment_status==='refunded'||order.payment_status==='cash_collected'||
          ['completed','placed','accepted','packing','ready','out_for_delivery'].includes(order.status))&&
          <button className="button secondary" onClick={()=>void operate(()=>invoice(order,local),'Invoice downloaded.')}><FileDown size={16}/> Download invoice</button>}
        {reorder&&<button className="button secondary" onClick={()=>void operate(()=>reorder(order.items),'Available items added to your basket.')}>Order again</button>}
      </div>}
      {customer?<OrderTracking order={order}/>:order.events.length>0&&<section><b>Order activity</b><ol className="timeline">{order.events.map((e,i)=><li key={i}><Check size={14}/><div><strong>{pretty(e.status)}</strong><small>{timestamp(e.created_at)}{e.note?' · '+e.note:''}</small></div></li>)}</ol></section>}
      {!!order.cases.length&&<section className="stack compact"><b>Support requests</b>{order.cases.map(k=><div className="info-box" key={k.id}><span><b>{pretty(k.kind)} · {pretty(k.status)}</b><small>{k.reason}{k.response?' · '+k.response:''}</small></span></div>)}</section>}
      {!!order.refunds.length&&<p className="muted">Refunded {rupee(order.refunds.reduce((sum,x)=>sum+x.amount,0))}</p>}
      {account.role==='customer'&&<form className="stack compact" onSubmit={e=>{e.preventDefault();void operate(async()=>{await send('/orders/'+orderId+'/cases',{kind,reason});setKind('');setReason('')},'Request sent to the store.')}}>
        <label>Contact the store<select value={kind} onChange={e=>setKind(e.target.value)}><option value="">Choose a request</option><option value="support">Order help</option>
        {['placed','accepted','packing','ready'].includes(order.status)&&<option value="cancel">Request cancellation</option>}
        {order.status==='completed'&&<option value="return">Request return</option>}{['paid','cash_collected'].includes(order.payment_status)&&<option value="refund">Request refund</option>}</select></label>
        {kind&&<><label>Reason<textarea value={reason} onChange={e=>setReason(e.target.value)} required maxLength={400}/></label><button className="button secondary" disabled={busy}>Send request</button></>}
      </form>}
    </div>}
  </Sheet>
}
