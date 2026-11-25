import { useEffect,useState } from 'react'
import { ArrowRight, BarChart3, Boxes, ClipboardList, FileDown, LayoutDashboard, Search, Settings2, ShoppingBag, Truck, Users, Wallet } from 'lucide-react'
import { AdminCatalog } from './admin-catalog'
import { OrderView } from './checkout'
import { api,checkoutDraftKey,date,displayOrder,downloadCsv,message,pack,pretty,readCheckoutDraft,rupee,saveCheckoutDraft,send } from './lib'
import type { Account,CartLine,OrderCase,OrderDetail,OrderRow,Product,Quote,Shop } from './lib'
import { Empty,ErrorText,Heading,Status,Success } from './ui'

const links=[
  {id:'overview',label:'Overview',icon:LayoutDashboard},{id:'orders',label:'Orders',icon:ClipboardList},{id:'catalog',label:'Catalog & stock',icon:Boxes},
  {id:'counter',label:'Counter sales',icon:ShoppingBag},{id:'reports',label:'Reports',icon:BarChart3},{id:'support',label:'Support & refunds',icon:Wallet},
  {id:'setup',label:'Store setup',icon:Settings2},{id:'team',label:'Team access',icon:Users},
] as const
type Tab=typeof links[number]['id']
type Summary={metrics:Record<string,number>;low:{id:string;name:string;stock:number;threshold:number;unit:string;expiry:string|null}[];refunds:number;cases:number}

export function OwnerDashboard({account,shop,refreshShop}:{account:Account;shop:Shop;refreshShop:()=>Promise<void>}){
  const [tab,setTab]=useState<Tab>('overview'),[error,setError]=useState(''),[orderId,setOrder]=useState<string|null>(null),[revision,setRevision]=useState(0)
  const change=(target:Tab)=>{setTab(target);setError('');window.scrollTo(0,0)}
  return <div className="dashboard shell">
    <aside className="dashboard-nav"><span className="sidebar-label">STORE WORKSPACE</span>{links.filter(item=>account.role==='owner'||!['team','setup'].includes(item.id)).map(({id,label,icon:Icon})=><button key={id} onClick={()=>change(id)} className={tab===id?'nav-current':''}><Icon size={17}/>{label}</button>)}</aside>
    <main className="dashboard-main">
      <ErrorText text={error}/>
      {tab==='overview'&&<Overview name={account.name} navigate={change} revision={revision}/>}
      {tab==='orders'&&<AdminOrders open={setOrder} revision={revision}/>}
      {tab==='catalog'&&<AdminCatalog owner={account.role==='owner'}/>}
      {tab==='counter'&&<Counter accountId={account.id} open={setOrder}/>}
      {tab==='reports'&&<Reports/>}
      {tab==='support'&&<Cases open={setOrder}/>}
      {tab==='setup'&&<Setup shop={shop} refresh={refreshShop}/>}
      {tab==='team'&&<Team/>}
    </main>
    {orderId&&<OrderView orderId={orderId} account={account} shop={shop} onClose={()=>{setOrder(null);setRevision(n=>n+1)}} extra={(order,refresh)=><OwnerOrderActions order={order} refresh={async()=>{await refresh();setRevision(n=>n+1)}}/>}/>}
  </div>
}

function Overview({name,navigate,revision}:{name:string;navigate:(tab:Tab)=>void;revision:number}){
  const [summary,setSummary]=useState<Summary|null>(null),[error,setError]=useState('')
  useEffect(()=>{api<Summary>('/admin/summary').then(setSummary,e=>setError(message(e)))},[revision])
  const m=summary?.metrics
  return <div className="stack roomy">
    <div className="console-hero"><div><h1>Today at your store</h1><p>Welcome, {name}.</p></div><div className="actions"><button className="button light" onClick={()=>navigate('orders')}>Manage orders <ArrowRight size={17}/></button><button className="button light" onClick={()=>navigate('counter')}>New counter sale <ArrowRight size={17}/></button></div></div>
    <ErrorText text={error}/>
    <div className="metric-grid">
      <Metric label="Today's sales" value={m?rupee(m.gross):'—'} accent="green"/><Metric label="Online orders" value={m?.online_orders??'—'} accent="yellow"/>
      <Metric label="Walk-in sales" value={m?.walk_in??'—'} accent="blue"/><Metric label="Orders to fulfill" value={m?.pending??'—'} accent="peach"/>
    </div>
    <div className="dashboard-pair">
      <section className="panel padded stack"><Heading title="Inventory watch" action={<button className="text-arrow" onClick={()=>navigate('catalog')}>Open catalog <ArrowRight size={15}/></button>}/>
        {summary?.low.length?summary.low.slice(0,8).map(row=><div className="summary-line" key={row.id}><b>{row.name}</b><span className="low-stock">{row.expiry?'Expiry '+row.expiry:row.stock+' '+row.unit+' left'}</span></div>):<p className="muted">No low-stock or upcoming expiry alerts.</p>}
      </section>
      <section className="panel padded stack"><Heading title="Store activity" />
        <div className="summary-line"><span>Completed</span><strong>{m?.completed??'—'}</strong></div>
        <div className="summary-line"><span>Unreconciled rider cash</span><strong>{m?rupee(m.rider_cash):'—'}</strong></div>
        <div className="summary-line"><span>Open support requests</span><strong>{summary?.cases??'—'}</strong></div>
        <div className="summary-line"><span>Refunded today</span><strong>{summary?rupee(summary.refunds):'—'}</strong></div>
      </section>
    </div>
  </div>
}
function Metric({label,value,accent}:{label:string;value:string|number;accent:string}){
  return <div className={'metric metric-'+accent}><span>{label}</span><strong>{value}</strong></div>
}

function AdminOrders({open,revision}:{open:(id:string)=>void;revision:number}){
  const [status,setStatus]=useState('all'),[rows,setRows]=useState<OrderRow[]>([]),[next,setNext]=useState<string|null>(null),[error,setError]=useState('')
  const load=async(cursor?:string)=>{
    try{const p=new URLSearchParams({status,...(cursor?{before:cursor}:{})});const data=await api<{orders:OrderRow[];next:string|null}>('/orders?'+p)
      setRows(old=>cursor?[...old,...data.orders]:data.orders);setNext(data.next)
    }catch(e){setError(message(e))}
  }
  useEffect(()=>{void load()},[status,revision])
  return <section className="stack"><Heading title="Orders" detail="Fulfill online orders and reconcile collections." action={<button className="button secondary" onClick={()=>void load()}>Refresh</button>}/>
    <label className="inline-field">Status<select value={status} onChange={e=>setStatus(e.target.value)}>{['all','awaiting_payment','placed','accepted','packing','ready','out_for_delivery','completed','cancelled','rejected','failed'].map(s=><option key={s} value={s}>{pretty(s)}</option>)}</select></label>
    <ErrorText text={error}/>
    <div className="panel table-scroll">{rows.length?<table><thead><tr><th>Order</th><th>Fulfillment</th><th>Status</th><th>Payment</th><th>Total</th><th/></tr></thead><tbody>{rows.map(o=><tr key={o.id}>
      <td><strong>{displayOrder(o.id)}</strong><small className="table-secondary">{date(o.created_at)}</small></td><td>{pretty(o.fulfillment)}</td><td><Status value={o.status}/></td><td><Status value={o.payment_status}/></td><td>{rupee(o.total)}</td><td><button className="button secondary small" onClick={()=>open(o.id)}>Open <ArrowRight size={14}/></button></td>
    </tr>)}</tbody></table>:<Empty title="No matching orders" detail="New customer and counter orders appear here."/>}</div>
    {next&&<button className="button secondary align-start" onClick={()=>void load(next)}>Load more</button>}
  </section>
}
function OwnerOrderActions({order,refresh}:{order:OrderDetail;refresh:()=>Promise<void>}){
  const [error,setError]=useState(''),[ok,setOk]=useState(''),[busy,setBusy]=useState(false),[cash,setCash]=useState('')
  const [shortage,setShortage]=useState(false),[productId,setProductId]=useState(''),[reason,setReason]=useState('')
  const pairs: Record<string,[string,string][]>={placed:[['accepted','Accept order'],['rejected','Reject order']],accepted:[['packing','Start packing'],['cancelled','Cancel order']],packing:[['ready','Mark ready'],['cancelled','Cancel order']],ready:order.fulfillment==='pickup'?[['completed','Confirm collection'],['cancelled','Cancel order']]:[['cancelled','Cancel order']]}
  const act=async(path:string,body:unknown,hint:string)=>{
    setBusy(true);setError('');setOk('')
    try{await send('/orders/'+order.id+path,body);setOk(hint);await refresh()}catch(e){setError(message(e))}finally{setBusy(false)}
  }
  const actions=pairs[order.status]??[]
  const collect=order.status==='ready'&&order.fulfillment==='pickup'&&order.payment_status==='cash_due'
  const assign=order.fulfillment==='delivery'&&!order.assigned_to&&['accepted','packing','ready'].includes(order.status)
  const reconcile=order.status==='completed'&&!order.reconciled&&['paid','cash_collected'].includes(order.payment_status)
  const reportShortage=['placed','accepted','packing'].includes(order.status)
  if(!actions.length&&!assign&&!reconcile&&!ok&&!error)return null
  return <section className="panel padded stack compact"><h3>Fulfillment actions</h3><ErrorText text={error}/><Success text={ok}/>
    {collect&&<label>Cash collected (₹)<input type="number" step=".01" min="0" value={cash} onChange={e=>setCash(e.target.value)} placeholder={String(order.total/100)}/></label>}
    <div className="actions">{actions.map(([state,label])=><button type="button" key={state} className={'button '+(['rejected','cancelled'].includes(state)?'secondary':'primary')} disabled={busy||(state==='completed'&&collect&&!cash)} onClick={()=>void act('/state',{status:state,...(collect?{cash:Math.round(Number(cash)*100)}:{})},label+' recorded.')}>{label}</button>)}
    {assign&&<button className="button secondary" disabled={busy} onClick={()=>void act('/assign',{},'Assigned to the active partner.')}><Truck size={16}/> Assign rider</button>}
    {reportShortage&&<button className="button secondary" onClick={()=>setShortage(!shortage)}>Report item shortage</button>}
    {reconcile&&<button className="button secondary" disabled={busy} onClick={()=>void act('/reconcile',{},'Collection reconciled.')}>Reconcile payment</button>}</div>
    {reportShortage&&shortage&&<form className="stack compact" onSubmit={e=>{e.preventDefault();void act('/shortage',{productId,reason},'Item shortage sent to the customer.')}}>
      <label>Unavailable item<select required value={productId} onChange={e=>setProductId(e.target.value)}><option value="">Select item</option>{order.items.map(item=><option key={item.product_id} value={item.product_id}>{item.name}</option>)}</select></label>
      <label>Message for customer<input value={reason} onChange={e=>setReason(e.target.value)} required maxLength={180}/></label>
      <small>Recording a shortage does not change payment or substitute products. Contact the customer or cancel if the order cannot be fulfilled.</small>
      <button className="button secondary align-start" disabled={busy}>Record shortage</button>
    </form>}
  </section>
}

function Counter({open,accountId}:{open:(id:string)=>void;accountId:string}){
  const [search,setSearch]=useState(''),[results,setResults]=useState<Product[]>([]),[items,setItems]=useState<CartLine[]>([])
  const [method,setMethod]=useState('cash'),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  useEffect(()=>{
    const controller=new AbortController()
    const timer=setTimeout(()=>api<{products:Product[]}>('/catalog?limit=18&q='+encodeURIComponent(search),{signal:controller.signal}).then(r=>setResults(r.products),e=>{if(!controller.signal.aborted)setError(message(e))}),200)
    return()=>{clearTimeout(timer);controller.abort()}
  },[search])
  function add(product:Product){
    const current=items.find(x=>x.product.id===product.id)
    if(current){setItems(items.map(x=>x===current?{product,steps:Math.min(x.steps+1,product.max_steps,Math.floor(product.stock/product.step))}:x))}
    else setItems([...items,{product,steps:product.min_steps}])
  }
  const subtotal=items.reduce((s,l)=>s+l.product.price*l.steps,0)
  async function record(){
    setError('');setBusy(true)
    const payload={fulfillment:'counter',method,items:items.map(l=>({id:l.product.id,steps:l.steps}))}
    let draft=''
    try{
      draft=await checkoutDraftKey('counter:'+accountId,JSON.stringify(payload))
      const prior=readCheckoutDraft(draft)
      const key=prior?.key??crypto.randomUUID()
      const quoted=prior?.quote??await send<Quote>('/quote',payload)
      saveCheckoutDraft(draft,{key,quote:quoted})
      const result=await send<{id:string}>('/pos',{...payload,key,version:quoted.version})
      sessionStorage.removeItem(draft);setItems([]);open(result.id)
    }catch(e){
      if(draft&&(e as {status?:number}).status===409)sessionStorage.removeItem(draft)
      setError(message(e))
    }finally{setBusy(false)}
  }
  return <section className="stack"><Heading title="Counter sales" detail="Record a walk-in sale against the same live stock."/>
    <ErrorText text={error}/><div className="dashboard-pair">
      <div className="panel padded stack"><label className="search-box"><Search size={18}/><input aria-label="Find product for counter" placeholder="Find a product" value={search} onChange={e=>setSearch(e.target.value)}/></label>
        <div className="counter-products">{results.map(p=><button className="counter-product" key={p.id} onClick={()=>add(p)} disabled={p.stock<p.step*p.min_steps||busy}><b>{p.name}</b><span>{pack(p.unit,p.step)} · {rupee(p.price)}</span></button>)}</div>
      </div>
      <div className="panel padded stack"><Heading title="Current sale"/>
        {!items.length&&<Empty title="Add items to start"/>}
        {items.map(l=><div className="counter-line" key={l.product.id}><div><b>{l.product.name}</b><small>{rupee(l.product.price*l.steps)}</small></div><input type="number" aria-label={'Packs of '+l.product.name} value={l.steps} min={0} max={Math.min(l.product.max_steps,Math.floor(l.product.stock/l.product.step))} disabled={busy} onChange={e=>{const n=Number(e.target.value);setItems(n===0?items.filter(x=>x!==l):items.map(x=>x===l?{...x,steps:n}:x))}}/></div>)}
        <div className="summary-line total"><b>Total</b><b>{rupee(subtotal)}</b></div>
        <label>Tender<select value={method} disabled={busy} onChange={e=>setMethod(e.target.value)}><option value="cash">Cash already collected</option><option value="counter_upi">Counter UPI already confirmed</option></select></label>
        <button className="button primary" disabled={!items.length||busy} onClick={()=>void record()}>{busy?'Recording…':'Complete counter sale'}</button>
      </div>
    </div></section>
}
function Cases({open}:{open:(id:string)=>void}){
  const [rows,setRows]=useState<OrderCase[]>([]),[error,setError]=useState(''),[ok,setOk]=useState('')
  const load=async()=>{try{setRows(await api<OrderCase[]>('/admin/cases'))}catch(e){setError(message(e))}}
  useEffect(()=>{void load()},[])
  return <section className="stack"><Heading title="Support & refunds" detail="Review and resolve customer requests."/><ErrorText text={error}/><Success text={ok}/>
    {!rows.length&&<div className="panel"><Empty title="No open requests"/></div>}
    {rows.map(k=><article className="panel padded stack" key={k.id}><div className="summary-line"><b>{pretty(k.kind)} · {displayOrder(k.order_id)}</b><button className="text-arrow" onClick={()=>open(k.order_id)}>View order <ArrowRight size={15}/></button></div><p>{k.reason}</p>
      <form className="form-grid" onSubmit={async e=>{e.preventDefault();setError('');setOk('')
        const data=new FormData(e.currentTarget)
        try{await send('/admin/cases/'+k.id,{status:data.get('status'),response:data.get('response'),amount:Math.round(Number(data.get('refund')||0)*100)});setOk('Request updated.');await load()}
        catch(error){setError(message(error))}
      }}><label>Resolution<select name="status"><option value="resolved">Resolve</option><option value="approved">Approve</option><option value="declined">Decline</option></select></label>
        <label>Refund amount (₹)<input name="refund" type="number" min="0" max={k.total/100} step=".01" defaultValue={0}/></label>
        <label className="span-full">Customer response<input name="response" maxLength={400}/></label><button className="button primary align-start">Save resolution</button>
      </form>
    </article>)}
  </section>
}
function Reports(){
  const [rows,setRows]=useState<Record<string,unknown>[]>([]),[days,setDays]=useState(7),[error,setError]=useState('')
  useEffect(()=>{api<typeof rows>('/admin/report?days='+days).then(setRows,e=>setError(message(e)))},[days])
  return <section className="stack"><Heading title="Sales reports" detail="Completed orders by day, channel and payment." action={<button className="button secondary" onClick={()=>downloadCsv(rows,'kirana-sales.csv')} disabled={!rows.length}><FileDown size={16}/> Export sales</button>}/>
    <label className="inline-field">Date range<select value={days} onChange={e=>setDays(Number(e.target.value))}><option value={1}>Today</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select></label>
    <ErrorText text={error}/><div className="panel table-scroll">{!rows.length?<Empty title="No completed sales"/>:<table><thead><tr><th>Date</th><th>Channel</th><th>Fulfillment</th><th>Payment</th><th>Orders</th><th>Gross</th></tr></thead><tbody>
      {rows.map((r,i)=><tr key={i}><td>{String(r.day)}</td><td>{pretty(String(r.channel))}</td><td>{pretty(String(r.fulfillment))}</td><td>{pretty(String(r.payment_method))}</td><td>{String(r.order_count)}</td><td>{rupee(Number(r.gross))}</td></tr>)}
    </tbody></table>}</div>
  </section>
}

function Setup({shop,refresh}:{shop:Shop;refresh:()=>Promise<void>}){
  const [value,setValue]=useState(shop),[step,setStep]=useState(0),[error,setError]=useState(''),[ok,setOk]=useState(''),[busy,setBusy]=useState(false)
  useEffect(()=>{api<Shop>('/admin/settings').then(setValue,e=>setError(message(e)))},[])
  const change=(key:keyof Shop,v:unknown)=>setValue(old=>({...old,[key]:v}))
  const field=(key:keyof Shop,label:string,pattern?:string)=><label>{label}<input value={String(value[key]??'')} onChange={e=>change(key,e.target.value)} pattern={pattern}/></label>
  const numeric=(key:keyof Shop,label:string,min:number,max:number,precision='1',currency=false)=><label>{label}<input type="number" value={Number(value[key])/(currency?100:1)} min={min} max={max} step={precision} onChange={e=>change(key,currency?Math.round(Number(e.target.value)*100):Number(e.target.value))} required/></label>
  const check=(key:keyof Shop,label:string)=><label className="check-label"><input type="checkbox" checked={Boolean(value[key])} onChange={e=>change(key,Number(e.target.checked))}/>{label}</label>
  return <section className="stack"><Heading title="Store setup" detail="Set the store identity, service limits and checkout rules."/>
    <div className="chips">{['1. Store identity','2. Delivery & pickup','3. Payments & policies'].map((label,i)=><button className={'chip '+(step===i?'active':'')} key={label} onClick={()=>setStep(i)}>{label}</button>)}</div>
    <ErrorText text={error}/><Success text={ok}/>
    <form className="panel padded stack" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');setOk('')
      try{await send('/admin/settings',value,'PUT');await refresh();setOk('Store settings saved.')}catch(e){setError(message(e))}finally{setBusy(false)}
    }}>
      {step===0&&<div className="form-grid">{field('name','Store name')}{field('tagline','Tagline')}{field('locality','Locality')}{field('phone','Store phone')}{field('address','Store address')}<label>Brand colour<input type="color" value={value.brand_color} onChange={e=>change('brand_color',e.target.value)}/></label></div>}
      {step===1&&<div className="form-grid">{numeric('latitude','Latitude',-90,90,'any')}{numeric('longitude','Longitude',-180,180,'any')}{field('pin_codes','Serviceable PIN codes (comma-separated)')}{numeric('radius_km','Delivery radius (km)',0.1,60,'any')}
        {numeric('open_hour','Open hour (0–23)',0,23)}{numeric('close_hour','Close hour (1–24)',1,24)}{numeric('preparation','Prep time (minutes)',0,180)}{numeric('window_minutes','Window length (minutes)',15,180)}
        {numeric('delivery_capacity','Home deliveries per window',1,100)}{numeric('pickup_capacity','Store pickups per window',1,250)}{check('accepting','Accept online orders')}</div>}
      {step===2&&<div className="form-grid">{numeric('minimum_order','Minimum order (₹)',0,100000,'.01',true)}{numeric('delivery_fee','Delivery fee (₹)',0,1000,'.01',true)}{numeric('free_delivery','Free delivery threshold (₹)',0,100000,'.01',true)}
        {field('gstin','GSTIN')}{check('registered','GST registered')}{check('enable_cod','Enable cash payments')}{check('enable_online','Enable local test online payments')}
        <label className="span-full">Store policy<textarea rows={5} value={value.policy} onChange={e=>change('policy',e.target.value)} maxLength={1000}/></label></div>}
      <div className="actions"><button className="button primary" disabled={busy}>Save settings</button>{step<2&&<button type="button" className="button secondary" onClick={()=>setStep(step+1)}>Next step <ArrowRight size={16}/></button>}</div>
    </form>
  </section>
}
function Team(){
  const [rows,setRows]=useState<(Account&{active:number})[]>([]),[error,setError]=useState(''),[code,setCode]=useState(''),[kind,setKind]=useState('staff')
  const load=async()=>{try{setRows(await api<typeof rows>('/admin/team'))}catch(e){setError(message(e))}}
  useEffect(()=>{void load()},[])
  return <section className="stack"><Heading title="Team access" detail="Grant role-specific access. Only one delivery partner can be active."/><ErrorText text={error}/>
    <div className="panel padded stack">{rows.map(person=><div key={person.id} className="summary-line"><div><strong>{person.name}</strong><small className="table-secondary">{pretty(person.role)} · {person.active?'Active':'Revoked'}</small></div>
      {person.role!=='owner'&&Boolean(person.active)&&<button className="button secondary" onClick={async()=>{setError('');try{await send('/admin/team/'+person.id+'/revoke');await load()}catch(e){setError(message(e))}}}>Revoke</button>}</div>)}</div>
    <form className="panel padded stack" onSubmit={async e=>{e.preventDefault();setError('');setCode('')
      try{setCode((await send<{code:string}>('/admin/team/invite',{role:kind})).code)}catch(e){setError(message(e))}
    }}><label>Invite a team member<select value={kind} onChange={e=>setKind(e.target.value)}><option value="staff">Store staff</option><option value="rider">Delivery partner</option></select></label>
      <button className="button primary align-start">Create local invitation</button>{code&&<label>One-time invitation code<input value={code} readOnly onFocus={e=>e.target.select()}/></label>}
    </form>
  </section>
}
