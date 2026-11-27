import { lazy,Suspense,useEffect,useMemo,useRef,useState } from 'react'
import { ArrowDown,ArrowRight,ArrowUp,LocateFixed,MapPin,Navigation,PackageCheck } from 'lucide-react'
import type { NavigationPlan,Point } from '../worker/navigation-model'
import { OrderView } from './checkout'
import { api,displayOrder,message,pretty,rupee,send,windowLabel } from './lib'
import type { Account,Address,OrderDetail,OrderRow,Shop } from './lib'
import { useRiderLocation,useTurn } from './rider-progress'
import { gap,goodAccuracy } from './rider-motion'
import { coordinates,groupTrips } from './rider-trips'
import type { TripStop } from './rider-trips'
import { Empty,ErrorText,Heading,Status,Success } from './ui'

const RiderMap=lazy(()=>import('./RiderMap'))
type Stop=TripStop&{rank:number;status:string;address:Address|null}
type Assignments={version:string;origin:Point;orders:Stop[];summary:{completed:number;cash:number;active:number}}
type Trip={ids:string[];manual?:boolean;origin?:Point}
const km=(meters:number)=>(meters/1000).toLocaleString('en-IN',{maximumFractionDigits:1})+' km'
const minutes=(seconds:number)=>Math.ceil(seconds/60)+' min'
const googleDirections=(point:Point)=>'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination='+
  encodeURIComponent(point.latitude+','+point.longitude)

export function RiderDashboard({account,shop,local}:{account:Account;shop:Shop;local:boolean}){
  const [route,setRoute]=useState<Assignments|null>(null)
  const [rows,setRows]=useState<OrderRow[]>([]),[error,setError]=useState(''),[ok,setOk]=useState('')
  const [opening,setOpening]=useState<string|null>(null),[busy,setBusy]=useState(false)
  const [showAll,setShowAll]=useState(false)
  const [groups,setGroups]=useState<string[][]>([])
  const [trip,setTrip]=useState<string[]>([]),[plan,setPlan]=useState<NavigationPlan|null>(null)
  const [planBusy,setPlanBusy]=useState(false),[planError,setPlanError]=useState('')
  const [tracking,setTracking]=useState(false)
  const [follow,setFollow]=useState(false),[centerRequest,setCenterRequest]=useState(0),[changedOrder,setChangedOrder]=useState(false)
  const lastDeviation=useRef({planned:false,at:0})
  const assignmentRequest=useRef<AbortController|null>(null)
  const assignmentVersion=useRef('')
  const currentRequest=useRef<AbortController|null>(null)
  const resolvedStops=useRef(new Set<string>())
  const plans=useRef(new Map<string,{plan:NavigationPlan;until:number}>())
  const [cursor,setCursor]=useState<string|null>(null),[loadingHistory,setLoadingHistory]=useState(false)
  const activeStops=route?.orders
  const byId=useMemo(()=>new Map(activeStops?.map(stop=>[stop.id,stop])),[activeStops])
  const activeTrip=useMemo(()=>trip.filter(id=>byId.has(id)),[trip,byId])
  const upcoming=groups.filter(group=>!group.some(id=>activeTrip.includes(id)))
  const grouped=activeTrip.length?[activeTrip,...upcoming]:upcoming
  const shownOrder=useMemo(()=>{
    const selected=plan&&!changedOrder?plan.legs.flatMap(leg=>leg.ids).filter(id=>activeTrip.includes(id)):activeTrip
    return selected.length===activeTrip.length?selected:activeTrip
  },[plan,changedOrder,activeTrip])
  const roadLegs=useMemo(()=>plan?.legs.filter(leg=>leg.ids.some(id=>byId.has(id)))??[],[plan,byId])
  const visibleLegs=useMemo(()=>changedOrder?[]:roadLegs,[changedOrder,roadLegs])
  const next=byId.get(shownOrder[0]),destination=next?coordinates(next.address):null
  const activeLeg=visibleLegs[0]
  const {gps,gpsError,road}=useRiderLocation(tracking,activeLeg)
  const direction=useTurn(activeLeg,road,gps,destination,tracking)
  const roadEnd=visibleLegs[0]?.line.at(-1)
  const pinGap=roadEnd&&destination?Math.round(gap({latitude:roadEnd[1],longitude:roadEnd[0]},destination)):0
  const markers=useMemo(()=>(activeStops??[]).flatMap(stop=>{
    const point=coordinates(stop.address)
    if(!point)return []
    const index=shownOrder.indexOf(stop.id)
    const recipient=stop.address?.recipient||displayOrder(stop.id)
    return [{id:stop.id,point,number:index===-1?undefined:index+1,title:index===-1?recipient:'Stop '+(index+1)+': '+recipient}]
  }),[activeStops,shownOrder])
  const load=async(history=true)=>{
    if(!history&&assignmentRequest.current)return
    assignmentRequest.current?.abort()
    const request=new AbortController()
    assignmentRequest.current=request
    if(history)setError('')
    try{
      const version=history?'':assignmentVersion.current
      const [active,page]=await Promise.all([
        api<Assignments|{unchanged:true}>('/rider/route'+(version?'?v='+version:''),{signal:request.signal}),
        history?api<{orders:OrderRow[];next:string|null}>('/rider/orders',{signal:request.signal}):null,
      ])
      if(request.signal.aborted)return
      if(!('unchanged' in active)){assignmentVersion.current=active.version;setRoute(active)}
      if(page){setRows(page.orders);setCursor(page.next)}
    }catch(e){if(history&&!request.signal.aborted)setError(message(e))}
    finally{if(assignmentRequest.current===request)assignmentRequest.current=null}
  }
  useEffect(()=>{
    void load()
    return ()=>{currentRequest.current?.abort();assignmentRequest.current?.abort()}
  },[])
  useEffect(()=>{
    if(opening||busy)return
    const refresh=()=>{if(document.visibilityState==='visible'&&navigator.onLine)void load(false)}
    const timer=setInterval(refresh,route?.summary.active?45000:120000)
    document.addEventListener('visibilitychange',refresh)
    window.addEventListener('online',refresh)
    return ()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('online',refresh)}
  },[busy,opening,Boolean(route?.summary.active)])

  useEffect(()=>{
    if(!activeStops)return
    setGroups(previous=>{
      const existing=previous.map(group=>group.filter(id=>byId.has(id))).filter(group=>group.length)
      const known=new Set(existing.flat())
      const added=groupTrips(activeStops.filter(stop=>!known.has(stop.id)))
      if(!added.length&&existing.length===previous.length&&existing.every((group,i)=>group.length===previous[i].length))return previous
      return [...existing,...added]
    })
  },[activeStops,byId])

  async function calculate(input:Trip){
    currentRequest.current?.abort()
    const request=new AbortController()
    currentRequest.current=request
    const key=JSON.stringify(input)
    const cached=plans.current.get(key)
    setPlanError('')
    if(cached&&cached.until>Date.now()){
      setPlan(cached.plan);setChangedOrder(false);setPlanBusy(false)
      return
    }
    setPlanBusy(true)
    try{
      const result=await api<NavigationPlan>('/rider/navigation',{
        method:'POST',body:key,headers:{'Content-Type':'application/json'},signal:request.signal,
      })
      if(request.signal.aborted)return
      if(!input.origin){
        plans.current.set(key,{plan:result,until:Date.now()+25*60*1000})
        if(plans.current.size>12)plans.current.delete(plans.current.keys().next().value!)
      }
      setPlan(result);setChangedOrder(false)
    }catch(e){if(!request.signal.aborted)setPlanError(message(e))}
    finally{if(!request.signal.aborted)setPlanBusy(false)}
  }

  function selectTrip(ids:string[]){
    setTracking(false);setFollow(false);setShowAll(false);setTrip(ids);setPlan(null);setChangedOrder(false)
    void calculate({ids})
  }
  useEffect(()=>{
    if(activeTrip.length)return
    const nextGroup=upcoming.find(group=>group.some(id=>byId.has(id)))
    if(nextGroup)selectTrip(nextGroup.filter(id=>byId.has(id)))
    else if(trip.length){
      currentRequest.current?.abort()
      setTracking(false);setFollow(false);setTrip([]);setPlan(null);setPlanBusy(false);setPlanError('');setChangedOrder(false)
      if(!byId.size)setOk('Trip complete')
    }
  },[activeTrip.length,groups,byId,trip.length])
  const planStops=plan?.legs.flatMap(leg=>leg.ids)??[]
  const unexpectedRemoval=planStops.some(id=>!byId.has(id)&&!resolvedStops.current.has(id)&&!rows.some(row=>row.id===id&&['completed','failed'].includes(row.status)))
  useEffect(()=>{
    if(!unexpectedRemoval||!plan||!activeTrip.length)return
    setPlan(null)
    plans.current.clear()
    void calculate({ids:activeTrip})
  },[unexpectedRemoval,plan,activeTrip.length])

  async function shift(index:number,delta:number){
    if(!route)return
    const reordered=[...shownOrder]
    const [moved]=reordered.splice(index,1)
    reordered.splice(index+delta,0,moved)
    const ordered=[...reordered,...route.orders.map(stop=>stop.id).filter(id=>!reordered.includes(id))]
    assignmentRequest.current?.abort()
    setBusy(true);setError('');setOk('')
    try{
      await send('/rider/route',{orders:ordered},'PUT')
      setRoute({...route,orders:ordered.map(id=>byId.get(id)!)})
      setTrip(reordered);setChangedOrder(true);setPlan(null);setPlanError('')
      setOk('Stop order saved. Recalculate to update road directions.')
    }catch(e){setError(message(e))}finally{setBusy(false)}
  }
  async function start(){
    if(!next)return
    assignmentRequest.current?.abort()
    setBusy(true);setError('')
    try{
      if(next.status==='ready'){
        await send('/orders/'+next.id+'/state',{status:'out_for_delivery'})
        setRoute(previous=>previous&&({...previous,orders:previous.orders.map(stop=>
          stop.id===next.id?{...stop,status:'out_for_delivery'}:stop)}))
      }
      setTracking(true);setFollow(true);setCenterRequest(value=>value+1)
    }catch(e){setError(message(e))}finally{setBusy(false)}
  }
  function recalculate(fromGps=false){
    if(!activeTrip.length)return
    if(fromGps&&tracking&&gps&&gps.accuracy<=goodAccuracy){
      const origin={latitude:Math.round(gps.latitude*10000)/10000,longitude:Math.round(gps.longitude*10000)/10000}
      void calculate({ids:shownOrder,manual:true,origin})
    }else{
      void calculate({ids:changedOrder?shownOrder:activeTrip,...(changedOrder?{manual:true}:{})})
    }
  }
  const {offRoute,onRoute}=direction
  const canReroute=tracking&&!busy&&!opening&&!planBusy&&next?.status==='out_for_delivery'
  useEffect(()=>{
    if(onRoute||!tracking)lastDeviation.current.planned=false
    if(!offRoute||!canReroute||!gps||!navigator.onLine||document.visibilityState!=='visible'||
        lastDeviation.current.planned||Date.now()-lastDeviation.current.at<90000)return
    lastDeviation.current={planned:true,at:Date.now()}
    recalculate(true)
  },[offRoute,onRoute,tracking,canReroute,gps])
  async function moreHistory(){
    if(!cursor)return
    setLoadingHistory(true);setError('')
    try{
      const page=await api<{orders:OrderRow[];next:string|null}>('/rider/orders?before='+encodeURIComponent(cursor))
      setRows(previous=>[...previous,...page.orders.filter(row=>!previous.some(entry=>entry.id===row.id))])
      setCursor(page.next)
    }catch(e){setError(message(e))}finally{setLoadingHistory(false)}
  }
  const noPin=route?.orders.filter(stop=>!coordinates(stop.address))??[]
  return <main className="shell rider-workspace stack roomy">
    <div className="rider-heading"><h1>Delivery navigation</h1>
      <button className="button secondary" onClick={()=>void load()}>Refresh assignments <ArrowRight size={16}/></button></div>
    <ErrorText text={error}/><Success text={ok}/>
    {route&&route.summary.active>route.orders.length&&<p>Showing the first {route.orders.length} assignments. More appear as you complete stops.</p>}
    {route?<div className="panel rider-nav">
      {route.orders.length>0&&<div className="rider-trip-bar">
        <label>Delivery trip <select value={activeTrip.length?0:-1} disabled={tracking||planBusy||busy}
          onChange={event=>selectTrip(grouped[Number(event.target.value)])}>
          {!activeTrip.length&&<option value={-1}>No pinned stops</option>}
          {grouped.map((group,i)=><option value={i} key={group.join(',')}>{i===0?'Current trip':'Queued trip '+i} · {i===0?activeTrip.length:group.length} stops</option>)}
        </select></label>
        <span>{grouped.length} {grouped.length===1?'trip':'trips'} · {route.orders.length} assigned</span>
      </div>}
      {next&&<div className="rider-turn" aria-live="polite">
        <Navigation size={22}/><div>
          <strong>{direction.instruction||(planBusy?'Finding your route…':'Open the delivery pin')}</strong>
          {direction.meters!==null&&<small>{direction.meters<1000?direction.meters+' m':km(direction.meters)} to next turn</small>}
          {tracking&&(gpsError||!gps)&&<small>{gpsError||'Waiting for GPS…'}</small>}
          {offRoute&&<small>{planBusy?'Updating your route…':'Off route. Directions may need updating.'}</small>}
        </div>
      </div>}
      <div className="rider-map-wrap">
        <Suspense fallback={<div className="rider-map-placeholder">Loading delivery map…</div>}>
          <RiderMap origin={route.origin} radius={shop.radius_km} markers={markers} legs={visibleLegs} gps={gps} next={next?.id}
            onStop={setOpening} centerRequest={centerRequest} follow={follow} showAll={showAll}
            onManual={()=>setFollow(false)} road={road} travelled={direction.travelled} turnAt={direction.turnAt}/>
        </Suspense>
        {gps&&<button className="button rider-recenter" aria-label="Recenter on my location" onClick={()=>{
          setFollow(true);setShowAll(false);setCenterRequest(value=>value+1)
        }}><LocateFixed size={22}/></button>}

      </div>
      {route.orders.length>0?<div className="rider-sheet">
        {next&&<div className="rider-sheet-main">
          <div className="rider-customer"><small>Next delivery · {activeTrip.length} left in this trip</small>
            <strong>{next.address?.recipient||displayOrder(next.id)}</strong>
            <span>{[next.address?.line1,next.address?.locality].filter(Boolean).join(', ')}</span>
          </div>
          {activeLeg&&<div className="rider-remaining"><strong>{minutes(Math.max(0,activeLeg.seconds-direction.timeTravelled))}</strong>
            <span>{km(Math.max(0,activeLeg.meters-direction.distanceTravelled))} away</span></div>}
        </div>}
        {pinGap>=80&&<p className="rider-road-warning">The driving route ends about {pinGap} m from the customer pin.</p>}
        <ErrorText text={planError}/>
        {next&&<button className="button primary full" disabled={busy||(!tracking&&planBusy)} onClick={()=>{
          if(tracking)setOpening(next.id)
          else void start()
        }}>{tracking?<><PackageCheck size={19}/>{next.status==='ready'?'Confirm pickup':'Complete delivery'}</>:<><Navigation size={19}/>Start delivery</>}</button>}
        <details className="rider-options">
          <summary>Delivery options</summary>
          <p>Follow road signs and traffic laws. Use directions at your own risk.</p>
          <div className="actions">
            {next&&<button className="button secondary" onClick={()=>setOpening(next.id)}>View order</button>}
            {destination&&<a className="text-arrow" href={googleDirections(destination)} target="_blank" rel="noopener noreferrer">Open in Google Maps</a>}
            {(planError||changedOrder||offRoute)&&activeTrip.length>0&&
              <button className="button secondary" disabled={planBusy||busy} onClick={()=>recalculate(offRoute)}>Recalculate route</button>}
            {upcoming.length>0&&<button className="button secondary" aria-pressed={showAll} onClick={()=>{
              setFollow(false);setShowAll(!showAll)
            }}>{showAll?'Fit current trip':'Show all stops'}</button>}
            {tracking&&<button className="button secondary" onClick={()=>{setTracking(false);setFollow(false)}}>Stop GPS</button>}

          </div>
        </details>
      </div>:<Empty title="No active stops" detail="Ready orders assigned by the owner will appear here."/>}
    </div>:!error&&<p role="status">Loading assignments…</p>}
    <details className="panel rider-assignments"><summary>Assignments and history</summary>
    {shownOrder.length>0&&<Heading title="Stops in this trip"/>}
    {(shownOrder.length>0||noPin.length>0)&&<div className="stop-list">
      {[...shownOrder.map(id=>byId.get(id)!),...noPin].map((stop,index)=>{
        const pinned=coordinates(stop.address)!==null
        return <article className="panel padded route-stop" key={stop.id}><div className="stop-number">{pinned?index+1:'—'}</div>
          <div className="stop-address"><b>{stop.address?.recipient||displayOrder(stop.id)}</b><small><MapPin size={14}/> {[stop.address?.line1,stop.address?.locality].filter(Boolean).join(', ')||'Address unavailable'}</small><small>{pinned?stop.address?.landmark:'No map pin · open this stop for its address'}</small></div>
          <Status value={stop.status}/><div className="actions">{pinned&&<>
            <button className="icon-button" disabled={busy||planBusy||index===0} aria-label="Move stop earlier" onClick={()=>void shift(index,-1)}><ArrowUp size={18}/></button>
            <button className="icon-button" disabled={busy||planBusy||index===shownOrder.length-1} aria-label="Move stop later" onClick={()=>void shift(index,1)}><ArrowDown size={18}/></button>
          </>}<button className="button primary small" onClick={()=>setOpening(stop.id)}>View stop <ArrowRight size={15}/></button></div>
        </article>
      })}
    </div>}
    {route&&<p>Completed today {route.summary.completed} · Cash to hand over {rupee(route.summary.cash)}</p>}
    <Heading title="Assigned order history"/>
    <div className="panel table-scroll">{!rows.length?<Empty title="No assigned orders yet"/>:<table><thead><tr><th>Order</th><th>Window</th><th>Status</th><th>Payment</th></tr></thead><tbody>
      {rows.map(o=><tr key={o.id}><td><button className="text-arrow" onClick={()=>setOpening(o.id)}>{displayOrder(o.id)}</button></td><td>{o.slot_start&&o.slot_end?windowLabel(o.slot_start,o.slot_end):'—'}</td><td><Status value={o.status}/></td><td>{pretty(o.payment_status)}</td></tr>)}
    </tbody></table>}</div>
    {cursor&&<button className="button secondary align-start" disabled={loadingHistory} onClick={()=>void moreHistory()}>{loadingHistory?'Loading…':'Load older orders'}</button>}
    </details>
    {opening&&<OrderView local={local} orderId={opening} account={account} shop={shop} onClose={()=>setOpening(null)}
      extra={order=><StopActions order={order} refreshed={async status=>{
        assignmentRequest.current?.abort()
        if(status==='completed'||status==='failed'){
          resolvedStops.current.add(order.id)
          setRoute(previous=>previous&&({...previous,orders:previous.orders.filter(stop=>stop.id!==order.id)}))
        }else{
          setRoute(previous=>previous&&({...previous,orders:previous.orders.map(stop=>stop.id===order.id?{...stop,status}:stop)}))
        }
        setOpening(null)
        await load()
      }}/>}/>}
  </main>
}
function StopActions({order,refreshed}:{order:OrderDetail;refreshed:(status:string)=>Promise<void>}){
  const [reason,setReason]=useState(''),[cash,setCash]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const methods=order.status==='ready'?[['out_for_delivery','Confirm pickup']]:order.status==='out_for_delivery'?[['completed','Mark delivered'],['failed','Report failure']]:[]
  if(!methods.length)return null
  const due=order.payment_status==='cash_due'
  const addr=order.address
  const nav=addr?.latitude!=null&&addr.longitude!=null?googleDirections({latitude:addr.latitude,longitude:addr.longitude}):null
  return <div className="panel padded stack"><h3>Stop actions</h3><ErrorText text={error}/>
    {nav&&<a className="button secondary align-start" href={nav} target="_blank" rel="noopener noreferrer"><Navigation size={16}/> Open in Google Maps</a>}
    {addr&&<a className="text-arrow align-start" href={'tel:'+addr.phone}>Call {addr.recipient}</a>}
    {order.status==='out_for_delivery'&&<>
      {due&&<label>Cash collected (₹)<input type="number" min="0" step=".01" placeholder={String(order.total/100)} value={cash} onChange={e=>setCash(e.target.value)}/></label>}
      <label>Failure reason<input placeholder="Required if delivery failed" maxLength={280} value={reason} onChange={e=>setReason(e.target.value)}/></label>
    </>}
    <div className="actions">{methods.map(([status,label])=><button key={status} className={'button '+(status==='failed'?'secondary':'primary')} disabled={busy||(status==='failed'&&!reason.trim())||(status==='completed'&&due&&!cash)} onClick={async()=>{
      setBusy(true);setError('')
      try{await send('/orders/'+order.id+'/state',{status,reason,...(due&&cash?{cash:Math.round(Number(cash)*100)}:{})});await refreshed(status)}
      catch(e){setError(message(e))}finally{setBusy(false)}
    }}>{label}</button>)}</div>
  </div>
}
