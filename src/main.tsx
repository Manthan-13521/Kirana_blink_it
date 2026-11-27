import { useCallback,lazy,Suspense,useEffect,useRef,useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowRight,Bell,ChevronDown,CircleUser,MapPin,PackageCheck,Search,ShoppingBasket,Store,Truck,X } from 'lucide-react'
import { AddressForm,OrderList,OrderView } from './checkout'
import { api,message,pretty,rupee,send } from './lib'
import type { Account,Address,CartLine,OrderDetail,Product,Shop } from './lib'
import { Storefront } from './shop'
import { InstallStore } from './install'
import { Empty,ErrorText,Mark,Sheet,Success } from './ui'
import './style.css'
const Owner=lazy(()=>import('./admin').then(m=>({default:m.OwnerDashboard})))
const Rider=lazy(()=>import('./rider').then(m=>({default:m.RiderDashboard})))
type View='shop'|'owner'|'rider'|'orders'
const pathView=():View=>location.pathname==='/orders'?'orders':location.pathname.startsWith('/owner')?'owner':location.pathname.startsWith('/rider')?'rider':'shop'
function orderFromUrl(url=new URL(location.href)){
  const id=url.searchParams.get('order')
  return id&&/^[0-9a-f-]{36}$/.test(id)?id:null
}
const cartKey=(id?:string)=>'kirana-basket-'+(id||'guest')
function readCart(key:string):CartLine[]|null{
  try{
    const raw=JSON.parse(localStorage.getItem(key)||'null')
    return raw&&Date.now()-raw.saved<172800000&&Array.isArray(raw.lines)?raw.lines:null
  }catch{return null}
}
function saveBasket(key:string,lines:CartLine[]){
  try{localStorage.setItem(key,JSON.stringify({lines,saved:Date.now()}));return true}
  catch{return false}
}
async function loadBasket(actor:Account|null,afterSignIn=false){
  if(actor?.role!=='customer')return {lines:readCart(cartKey())??[],changed:false,remainder:[]}
  const cached=readCart(cartKey(actor.id))
  const saved=cached?null:await api<{lines:CartLine[]}>('/cart').catch(()=>null)
  const existing=cached??saved?.lines??[]
  if(!afterSignIn)return {lines:existing,changed:false,remainder:[]}
  const guest=readCart(cartKey())??[]
  if(!guest.length)return {lines:existing,changed:false,remainder:[]}
  const combined=new Map(existing.map(line=>[line.product.id,line]))
  const remainder:CartLine[]=[]
  let changed=false
  for(const line of guest){
    const prior=combined.get(line.product.id),product=prior?.product??line.product
    const before=prior?.steps??0
    const max=Math.min(product.max_steps,Math.floor(product.stock/product.step))
    const added=!prior&&combined.size>=40?0:Math.max(0,Math.min(line.steps,max-before))
    if(!added||before+added<product.min_steps){remainder.push(line);continue}
    combined.set(product.id,{product,steps:before+added})
    if(added<line.steps)remainder.push({...line,steps:line.steps-added})
    changed=true
  }
  return {lines:[...combined.values()],changed,remainder}
}
function saveGuestRemainder(lines:CartLine[]){
  if(lines.length){saveBasket(cartKey(),lines);return}
  try{localStorage.removeItem(cartKey())}catch{/* Storage access can be disabled by the browser. */}
}
type Modal='signin'|'profile'|'location'|'notices'|null

function App(){
  const [shop,setShop]=useState<Shop|null>(null),[account,setAccount]=useState<Account|null>(null)
  const [local,setLocal]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState('')
  const [view,setView]=useState(pathView),[query,setQuery]=useState(''),[modal,setModal]=useState<Modal>(null)
  const [loginRole,setLoginRole]=useState<'customer'|'owner'|'rider'>('customer')
  const [cart,setCart]=useState<CartLine[]>([]),[cartOpen,openCart]=useState(false),[order,setOrder]=useState<string|null>(null)
  const [resumeCheckout,setResumeCheckout]=useState(false)
  const checkoutIntent=useRef(false)
  const cartChanged=useRef(false)
  const cartCount=cart.reduce((count,line)=>count+line.steps,0)
  const cartValue=cart.reduce((total,line)=>total+line.steps*line.product.price,0)
  const refreshShop=useCallback(async()=>{const result=await api<{settings:Shop;local:boolean}>('/store',{cache:'reload'});setShop(result.settings);setLocal(result.local)},[])
  useEffect(()=>{
    Promise.all([refreshShop(),api<{account:Account|null}>('/me')]).then(async([,me])=>{
      const url=new URL(window.location.href)
      const checkout=url.searchParams.get('checkout')==='resume'&&me.account?.role==='customer'
      const signedIn=checkout||url.searchParams.get('signin')==='complete'
      const basket=await loadBasket(me.account,signedIn)
      let returningToOrders=false
      if(signedIn){
        try{
          returningToOrders=me.account?.role==='customer'&&sessionStorage.getItem('kirana-return-to-orders')==='1'
          sessionStorage.removeItem('kirana-return-to-orders')
        }catch{/* Orders are always available from the account menu. */}
      }
      const orderId=me.account?.role==='customer'?orderFromUrl(url):null
      if(orderId||returningToOrders){url.pathname='/orders';setView('orders');setOrder(orderId)}
      if(signedIn||orderId){
        for(const key of ['checkout','signin'])url.searchParams.delete(key)
        history.replaceState({},'',url)
      }
      cartChanged.current=basket.changed
      if(basket.changed&&me.account&&saveBasket(cartKey(me.account.id),basket.lines))saveGuestRemainder(basket.remainder)
      setAccount(me.account);setCart(basket.lines);setReady(true)
      if(checkout&&basket.lines.length){setResumeCheckout(true);openCart(true)}
    },e=>{setError(message(e));setReady(true)})
    const handle=()=>{setView(pathView());setModal(null);setOrder(orderFromUrl());openCart(false)}
    window.addEventListener('popstate',handle)
    return()=>window.removeEventListener('popstate',handle)
  },[])
  useEffect(()=>{
    if(!ready)return
    const key=cartKey(account?.role==='customer'?account.id:undefined)
    saveBasket(key,cart)
    if(account?.role!=='customer'||!cartChanged.current)return
    const t=setTimeout(()=>{
      cartChanged.current=false
      send('/cart',{items:cart.map(l=>({id:l.product.id,steps:l.steps}))},'PUT')
        .catch(e=>console.warn('Could not sync basket',e))
    },650)
    return()=>clearTimeout(t)
  },[cart,account?.id,ready])
  const changeCart=(lines:CartLine[])=>{cartChanged.current=true;setCart(lines)}
  const go=(target:View)=>{
    if(target!==view){history.pushState({},'',target==='shop'?'/':'/'+target);setView(target);window.scrollTo(0,0);openCart(false);setOrder(null)}
    setModal(null)
  }
  const openCustomerOrder=(id:string)=>{
    history.pushState({},'','/orders?order='+encodeURIComponent(id))
    setView('orders');setOrder(id);setModal(null);openCart(false)
  }
  const closeOrder=()=>{
    if(pathView()==='orders')history.replaceState({},'','/orders')
    setOrder(null)
  }
  const signIn=(role:'customer'|'owner'|'rider')=>{setLoginRole(role);setModal('signin')}
  async function signed(actor:Account){
    const basket=await loadBasket(actor,true)
    cartChanged.current=basket.changed
    setCart(basket.lines)
    if(basket.changed&&saveBasket(cartKey(actor.id),basket.lines))saveGuestRemainder(basket.remainder)
    setAccount(actor);setModal(null)
    if(actor.role==='owner'||actor.role==='staff')go('owner')
    if(actor.role==='rider')go('rider')
    if(actor.role==='customer'&&view==='orders')setOrder(orderFromUrl())
    else if(actor.role==='customer'&&view!=='shop')go('shop')
    if(actor.role==='customer'&&checkoutIntent.current){
      setResumeCheckout(true);openCart(true)
    }
    checkoutIntent.current=false
  }
  async function logOut(){
    try{
      // Remove this device's account binding before disposing of the session.
      if(account?.role==='customer'&&!local&&'serviceWorker' in navigator){
        try{
          const registration=await navigator.serviceWorker.getRegistration()
          const subscription=await registration?.pushManager?.getSubscription()
          if(subscription){
            await send('/notices/push',{endpoint:subscription.endpoint},'DELETE')
            await subscription.unsubscribe()
          }
        }catch{/* Signing out must remain available when push services are unavailable. */}
      }
      await send('/auth/logout');cartChanged.current=false;setAccount(null);setCart(readCart(cartKey())??[]);setOrder(null);setModal(null);go('shop')}
    catch(e){setError(message(e))}
  }
  const reorder=async(items:OrderDetail['items'])=>{
    const products=await Promise.all(items.map(item=>api<Product>('/catalog/'+item.product_id).catch(()=>null)))
    const map=new Map(cart.map(l=>[l.product.id,l]))
    products.forEach((p,i)=>{
      if(!p)return
      const prior=map.get(p.id)?.steps??0, max=Math.min(p.max_steps,Math.floor(p.stock/p.step))
      const qty=Math.min(prior+Math.floor(items[i].quantity/p.step),max)
      if(qty>=p.min_steps&&map.size<40)map.set(p.id,{product:p,steps:qty})
    })
    if(products.every(p=>!p))throw new Error('These items are currently unavailable.')
    changeCart([...map.values()])
  }
  const currentRole=view==='owner'?'owner':view==='rider'?'rider':'customer'
  const allowed=view==='shop'||(view==='owner'&&['owner','staff'].includes(account?.role??''))||(view==='rider'&&account?.role==='rider')
  return <div style={shop?{'--brand':shop.brand_color} as React.CSSProperties:undefined}>
    {shop?<><div className="topbar"><div className="shell top-inner"><span><Store size={13}/> {!shop.accepting?'Online ordering is temporarily unavailable':local?'Local demo store':'Your neighbourhood grocery'}</span>
    </div></div>
    <header className="main-header"><div className="shell header-inner">
      <button className="brand-button" onClick={()=>go('shop')} aria-label={shop.name+' storefront'}><Mark name={shop.name} logo={shop.logo}/></button>
      {view==='shop'&&<>
        <button className="location-button" onClick={()=>setModal('location')}><span className="location-icon"><MapPin size={18}/></span><span><small>SHOPPING NEAR</small><b>{shop.locality}</b></span><ChevronDown size={13}/></button>
        <label className="search-box site-search"><Search size={20}/><input aria-label="Search groceries" placeholder={'Search “milk”, “bread”, “atta”…'} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')document.getElementById('products')?.scrollIntoView({behavior:'smooth'})}}/>{query&&<button className="search-clear" aria-label="Clear search" onClick={()=>setQuery('')}><X size={16}/></button>}</label>
      </>}
      <div className="header-actions">
        {account?.role==='customer'&&view==='shop'&&<button className="icon-button" aria-label="My orders" title="My orders" onClick={()=>go('orders')}><PackageCheck size={21}/></button>}
        {account&&<button className="icon-button bell-button" aria-label="Notifications" onClick={()=>setModal('notices')}><Bell size={20}/></button>}
        <button className="account-button" aria-label={account?'Account for '+account.name:'Sign in'} onClick={()=>account?setModal('profile'):signIn(currentRole)}><CircleUser size={21}/><span>{account?account.name:'Sign in'}</span></button>
        {view==='shop'&&<button className="basket-button" aria-label={'My basket'+(cartCount?', '+cartCount+' items':'')} onClick={()=>openCart(true)}><ShoppingBasket size={20}/><span>{cartCount?rupee(cartValue):'My basket'}</span>{cartCount>0&&<b>{cartCount}</b>}</button>}
      </div>
    </div></header>
    <ErrorText text={error}/></>:<div className="shell startup"><Mark/><ErrorText text={error}/>{!error&&<p>Opening the store…</p>}</div>}
    {view==='shop'?<Storefront shop={shop} refreshShop={refreshShop} account={account} query={query} setQuery={setQuery} cart={cart} cartReady={ready} setCart={changeCart} cartOpen={cartOpen} startCheckout={resumeCheckout} openCart={open=>{setResumeCheckout(false);openCart(open)}}
      requireLogin={()=>{checkoutIntent.current=true;openCart(false);signIn('customer')}} openOrder={openCustomerOrder} setLocation={()=>setModal('location')}/>
      :!shop?null:view==='orders'?<main className="shell my-orders stack">
        <div className="heading"><div><h1>My orders</h1><p>Review purchases and track deliveries and pickups.</p></div>
          <button className="button secondary" onClick={()=>go('shop')}>Go to storefront</button></div>
        {!ready?<p>Loading your account…</p>:account?.role==='customer'?<OrderList active={!order} open={openCustomerOrder}/>:<Empty
          title="Customer sign-in required" detail="Sign in with the account used to place your orders."
          action={<button className="button primary" onClick={()=>signIn('customer')}>Sign in to view orders</button>}/>}
      </main>:!allowed||!account?<main className="shell role-entry">
        <div className="console-hero"><div><small>{view==='owner'?'STORE WORKSPACE':'DELIVERY WORKSPACE'}</small><h1>{view==='owner'?'Manage your Kirana':'Deliver for your Kirana'}</h1><p>{view==='owner'?'Catalog, orders, counter sales and store settings.':'Assigned orders, route stops and cash collections.'}</p></div><button className="button light" onClick={()=>signIn(currentRole)}>Sign in as {view==='owner'?'owner':'rider'} <ArrowRight size={17}/></button></div>
      </main>:<Suspense fallback={<main className="shell startup"><p>Loading workspace…</p></main>}>{view==='owner'?<Owner account={account} shop={shop} refreshShop={refreshShop}/>:<Rider account={account} shop={shop} local={local}/>}</Suspense>}
    {modal==='signin'&&<SignIn role={loginRole} local={local} checkout={checkoutIntent.current} close={()=>{checkoutIntent.current=false;setModal(null)}} signed={signed}/>}
    {modal==='profile'&&account&&<Profile account={account} setAccount={setAccount} local={local} close={()=>setModal(null)} logOut={()=>void logOut()} orders={()=>go('orders')} addresses={()=>setModal('location')} switchRole={()=>signIn(currentRole)}/>}
    {shop&&modal==='location'&&<Location shop={shop} account={account} onClose={()=>setModal(null)} signIn={()=>signIn('customer')}/>}
    {modal==='notices'&&account&&<Notices customer={account?.role==='customer'} local={local} close={()=>setModal(null)} open={id=>{if(account.role==='customer')openCustomerOrder(id);else{setModal(null);setOrder(id)}}}/>}
    {shop&&order&&account&&(view!=='orders'||account.role==='customer')&&<OrderView key={order} local={local} orderId={order} onClose={closeOrder} account={account} shop={shop} reorder={account.role==='customer'?async items=>{await reorder(items);go('shop');openCart(true)}:undefined}/>}
  </div>
}

function SignIn({role,local,checkout,close,signed}:{checkout:boolean;role:'customer'|'owner'|'rider';local:boolean;close:()=>void;signed:(a:Account)=>Promise<void>}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[register,setRegister]=useState(false)
  const [google,setGoogle]=useState<'checking'|'enabled'|'disabled'|'unavailable'>('checking')
  const [attempt,setAttempt]=useState(0),[invite,setInvite]=useState('')
  useEffect(()=>{
    if(local)return
    const controller=new AbortController()
    api<{enabled:boolean}>('/auth/google/status',{signal:controller.signal}).then(status=>{
      if(!controller.signal.aborted)setGoogle(status?.enabled===true?'enabled':status?.enabled===false?'disabled':'unavailable')
    },()=>{
      if(!controller.signal.aborted)setGoogle('unavailable')
    })
    return()=>controller.abort()
  },[local,attempt])
  async function demo(choice:string){
    setBusy(true);setError('')
    try{await signed(await send<Account>('/auth/demo',{role:choice}))}catch(e){setError(message(e))}finally{setBusy(false)}
  }
  return <Sheet title={register?'Create local account':'Welcome to Kirana'} onClose={close}>
    <div className="stack"><ErrorText text={error}/>
      {!local?google==='enabled'?<form className="stack" onSubmit={async e=>{
        e.preventDefault();setError('');setBusy(true)
        try{
          const {url}=await send<{url:string}>('/auth/google',{workspace:role==='customer'?'shop':role,checkout,invite})
          if(new URL(url).origin!=='https://accounts.google.com')throw new Error('Google sign-in returned an invalid link.')
          try{
            if(pathView()==='orders')sessionStorage.setItem('kirana-return-to-orders','1')
            else sessionStorage.removeItem('kirana-return-to-orders')
          }catch{/* Google sign-in can continue without local session storage. */}
          window.location.assign(url)
        }catch(e){setError(message(e));setBusy(false)}
      }}>
        {role!=='customer'&&<label>Team invitation code (if provided)<input autoComplete="off" maxLength={64} value={invite} onChange={e=>setInvite(e.target.value)}/></label>}
        <button className="button primary full" disabled={busy}>Continue with Google <ArrowRight size={16}/></button>
      </form>:google==='unavailable'?<><p role="status">Could not check Google sign-in availability.</p>
        <button type="button" className="button secondary align-start" onClick={()=>{setGoogle('checking');setAttempt(n=>n+1)}}>Try again</button></>
      :<p role="status">{google==='checking'?'Checking sign-in availability…':'Google sign-in is not configured for this preview.'}</p>
      :register?<form className="stack" onSubmit={async e=>{
        e.preventDefault();setBusy(true);setError('')
        try{await signed(await send<Account>('/auth/register-local',Object.fromEntries(new FormData(e.currentTarget))))}catch(e){setError(message(e))}finally{setBusy(false)}
      }}><label>Name<input name="name" required maxLength={80}/></label><label>Phone<input name="phone" type="tel" maxLength={22}/></label><label>Team invite code, if provided<input name="invite" maxLength={80}/></label><button className="button primary" disabled={busy}>Create local account</button><button type="button" className="text-arrow" onClick={()=>setRegister(false)}>Back to demo sign-in</button></form>
      :<><p className="muted">Local demo accounts let you try every interface.</p>
        <button className="button primary full" disabled={busy} onClick={()=>void demo(role)}>Continue as demo {role} <ArrowRight size={16}/></button>
        <div className="actions">{(['customer','owner','rider','staff'] as const).filter(r=>r!==role).map(r=><button key={r} className="button secondary" disabled={busy} onClick={()=>void demo(r)}>{pretty(r)}</button>)}</div>
        <button className="text-arrow align-start" onClick={()=>setRegister(true)}>Create a local account or accept invite <ArrowRight size={15}/></button></>}
    </div>
  </Sheet>
}
function Profile({account,setAccount,close,logOut,local,orders,addresses,switchRole}:{account:Account;setAccount:(a:Account)=>void;close:()=>void;logOut:()=>void;local:boolean;orders:()=>void;addresses:()=>void;switchRole:()=>void}){
  const [error,setError]=useState(''),[ok,setOk]=useState('')
  return <Sheet title="Your account" onClose={close}><div className="stack">
    <div className="profile-card"><span className="profile-icon"><CircleUser size={26}/></span><div><b>{account.name}</b><small>{pretty(account.role)}</small></div></div>
    <ErrorText text={error}/><Success text={ok}/>
    <form className="stack" onSubmit={async e=>{e.preventDefault();setError('');setOk('')
      try{setAccount(await send<Account>('/me',Object.fromEntries(new FormData(e.currentTarget)),'PUT'));setOk('Profile saved.')}catch(err){setError(message(err))}
    }}><label>Name<input name="name" defaultValue={account.name} required maxLength={80}/></label><label>Phone<input name="phone" type="tel" defaultValue={account.phone} maxLength={24}/></label><button className="button primary align-start">Save profile</button></form>
    <InstallStore/>
    <div className="actions">{account.role==='customer'&&<><button className="button secondary" onClick={orders}>Order history</button><button className="button secondary" onClick={addresses}>Saved addresses</button></>}{local&&<button className="button secondary" onClick={switchRole}>Switch demo account</button>}<button className="button secondary" onClick={logOut}>Sign out</button></div>
  </div></Sheet>
}
function Location({shop,account,onClose,signIn}:{shop:Shop;account:Account|null;onClose:()=>void;signIn:()=>void}){
  const [addresses,setAddresses]=useState<Address[]>([]),[adding,setAdding]=useState(false),[error,setError]=useState('')
  useEffect(()=>{if(account?.role==='customer')api<Address[]>('/addresses').then(setAddresses,e=>setError(message(e)))},[account?.id,account?.role])
  return <Sheet title="Delivery & store pickup" onClose={onClose}><div className="stack">
    <div className="info-box"><Store size={20}/><span><b>{shop.name}</b><small>{shop.address} · {shop.locality}</small></span></div>
    {!shop.accepting&&<p role="status">Online ordering is temporarily unavailable.</p>}
    {!!(shop.accepting&&shop.enable_delivery)&&<div className="info-box"><Truck size={20}/><span><b>Home delivery within {shop.radius_km} km</b><small>Choose a delivery window at checkout.</small></span></div>}
    {!!(shop.accepting&&shop.enable_pickup)&&<div className="info-box"><Store size={20}/><span><b>Store pickup</b><small>Choose a pickup window at checkout.</small></span></div>}
    <ErrorText text={error}/>
    {account?.role==='customer'?<>
      <div className="summary-line"><b>Saved addresses</b><button className="text-arrow" onClick={()=>setAdding(!adding)}>{adding?'Close form':'Add address'}</button></div>
      {addresses.map(a=><div className="panel padded summary-line" key={a.id}><div><b>{a.label}</b><small className="table-secondary">{a.line1}, {a.locality} {a.pin}</small></div><button className="button secondary small" onClick={async()=>{try{await api('/addresses/'+a.id,{method:'DELETE'});setAddresses(addresses.filter(x=>x.id!==a.id))}catch(e){setError(message(e))}}}>Remove</button></div>)}
      {adding&&<AddressForm shop={shop} account={account} saved={a=>{setAddresses([a,...addresses]);setAdding(false)}}/>}
    </>:<button className="button primary" onClick={signIn}>Sign in to save an address</button>}
  </div></Sheet>
}
function Notices({customer,local,close,open}:{customer:boolean;local:boolean;close:()=>void;open:(id:string)=>void}){
  const [rows,setRows]=useState<{id:number;order_id:string;message:string;read_at:number|null}[]>([]),[enabled,setEnabled]=useState(false),[error,setError]=useState('')
  const [key,setKey]=useState<string|null>(null),[busy,setBusy]=useState(false)
  useEffect(()=>{
    api<{notices:typeof rows;enabled:boolean}>('/notices').then(x=>{
      setRows(x.notices)
      if(local)setEnabled(x.enabled)
    },e=>setError(message(e)))
    if(!local&&customer&&'serviceWorker' in navigator){
      Promise.all([api<{publicKey:string|null}>('/notices/push'),navigator.serviceWorker.getRegistration()])
        .then(async([config,registration])=>{
          setKey(config.publicKey)
          if(registration?.pushManager)setEnabled(Boolean(await registration.pushManager.getSubscription()))
        }).catch(e=>setError(message(e)))
    }
  },[local,customer])
  async function setPush(value:boolean){
    setBusy(true);setError('')
    try{
      const registration=await navigator.serviceWorker.getRegistration()
      if(!registration||!('Notification' in window))throw new Error('Install the store app to use browser notifications on this device.')
      if(value&&await Notification.requestPermission()!=='granted')throw new Error('Browser notifications were not enabled.')
      if(local){
        if(value)await registration.showNotification('Kirana test notification',{body:'Local notifications are enabled.'})
        await send('/notices/preferences',{enabled:value},'PUT')
      }else{
        const existing=await registration.pushManager.getSubscription()
        if(value&&key){
          const base64=key.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-key.length%4)%4)
          const applicationServerKey=Uint8Array.from(atob(base64),c=>c.charCodeAt(0))
          const subscription=existing??await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey})
          try{await send('/notices/push',{endpoint:subscription.endpoint},'PUT')}
          catch(error){if(!existing)await subscription.unsubscribe();throw error}
        }else if(!value&&existing){
          await send('/notices/push',{endpoint:existing.endpoint},'DELETE')
          await existing.unsubscribe()
        }
      }
      setEnabled(value)
    }catch(e){setError(message(e))}finally{setBusy(false)}
  }
  return <Sheet title="Notifications" onClose={close}><div className="stack"><ErrorText text={error}/>
    {(local||customer&&key)&&<label className="check-label"><input type="checkbox" disabled={busy} checked={enabled} onChange={e=>void setPush(e.target.checked)}/> {local?'Enable local notification preview':'Send order updates to this device'}</label>}
    {!rows.length?<Empty title="No notifications yet"/>:rows.map(r=><button type="button" className="order-row" key={r.id} onClick={()=>open(r.order_id)}>{r.message}<ArrowRight size={15}/></button>)}
    {!!rows.length&&<button className="button secondary" onClick={async()=>{try{await send('/notices/read');setRows(rows.map(r=>({...r,read_at:Date.now()})))}catch(e){setError(message(e))}}}>Mark all as read</button>}
  </div></Sheet>
}
createRoot(document.getElementById('root')!).render(<App/>)
if('serviceWorker' in navigator&&import.meta.env.PROD)navigator.serviceWorker.register('/sw.js').catch(error=>console.warn('PWA registration failed',error))
