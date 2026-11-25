import { useEffect,useState } from 'react'
import { ArrowDown,ArrowRight,ArrowUp,MapPin,Navigation,PackageCheck,Route,Truck,Wallet } from 'lucide-react'
import { distance } from '../worker/shared'
import { OrderView } from './checkout'
import { api,displayOrder,message,pretty,rupee,send,windowLabel } from './lib'
import type { Account,Address,OrderDetail,OrderRow,Shop } from './lib'
import { Empty,ErrorText,Heading,Status,Success } from './ui'

type Stop={id:string;rank:number;status:string;address:Address}
type Point={latitude:number;longitude:number}
function km(origin:Point,stop:Stop){
  return stop.address.latitude===null||stop.address.longitude===null?Infinity:distance(origin.latitude,origin.longitude,stop.address.latitude,stop.address.longitude)
}
function point(stop:Stop,origin:Point):Point{
  return {latitude:stop.address.latitude??origin.latitude,longitude:stop.address.longitude??origin.longitude}
}
function optimize(origin:Point,stops:Stop[]){
  const remaining=[...stops], output:Stop[]=[]
  let position=origin
  while(remaining.length){remaining.sort((a,b)=>km(position,a)-km(position,b));const next=remaining.shift()!;output.push(next);position=point(next,position)}
  const total=(route:Stop[])=>{
    let last=origin
    return route.reduce((sum,stop)=>{const dist=km(last,stop);last=point(stop,last);return sum+(Number.isFinite(dist)?dist:0)},0)
  }
  for(let i=0;i<output.length-1;i++)for(let j=i+1;j<output.length;j++){
    const candidate=[...output.slice(0,i),...output.slice(i,j+1).reverse(),...output.slice(j+1)]
    if(total(candidate)+0.001<total(output))output.splice(0,output.length,...candidate)
  }
  return output
}
export function RiderDashboard({account,shop}:{account:Account;shop:Shop}){
  const [route,setRoute]=useState<{origin:Point;orders:Stop[];summary:{completed:number;cash:number;active:number}}|null>(null)
  const [rows,setRows]=useState<OrderRow[]>([]),[error,setError]=useState(''),[ok,setOk]=useState('')
  const [opening,setOpening]=useState<string|null>(null),[busy,setBusy]=useState(false)
  const [cursor,setCursor]=useState<string|null>(null),[loadingHistory,setLoadingHistory]=useState(false)
  const load=async()=>{
    setError('')
    try{
      const [active,history]=await Promise.all([api<NonNullable<typeof route>>('/rider/route'),api<{orders:OrderRow[];next:string|null}>('/orders')])
      setRoute(active);setRows(history.orders);setCursor(history.next)
    }
    catch(e){setError(message(e))}
  }
  useEffect(()=>{void load()},[])
  async function save(stops:Stop[]){
    if(!route)return
    setBusy(true);setError('');setOk('')
    try{await send('/rider/route',{orders:stops.map(o=>o.id)},'PUT');setRoute({...route,orders:stops});setOk('Route order saved.')}
    catch(e){setError(message(e))}finally{setBusy(false)}
  }
  const shift=(index:number,delta:number)=>{
    if(!route)return
    const sorted=[...route.orders];[sorted[index],sorted[index+delta]]=[sorted[index+delta],sorted[index]]
    void save(sorted)
  }
  async function moreHistory(){
    if(!cursor)return
    setLoadingHistory(true);setError('')
    try{
      const nextPage=await api<{orders:OrderRow[];next:string|null}>('/orders?before='+encodeURIComponent(cursor))
      setRows(prev=>[...prev,...nextPage.orders.filter(row=>!prev.some(entry=>entry.id===row.id))])
      setCursor(nextPage.next)
    }catch(e){setError(message(e))}finally{setLoadingHistory(false)}
  }
  return <main className="shell rider-workspace stack roomy">
    <div className="console-hero"><div><small>DELIVERY WORKSPACE</small><h1>Your delivery run</h1><p>Hi, {account.name}. Review your assigned stops and collections.</p></div><button className="button light" onClick={()=>void load()}>Refresh assignments <ArrowRight size={17}/></button></div>
    <ErrorText text={error}/><Success text={ok}/>
    <div className="metric-grid rider-metrics"><div className="metric metric-green"><Truck size={20}/><span>Active stops</span><strong>{route?.summary.active??0}</strong></div>
      <div className="metric metric-yellow"><PackageCheck size={20}/><span>Completed today</span><strong>{route?.summary.completed??0}</strong></div>
      <div className="metric metric-blue"><Wallet size={20}/><span>Cash to hand over</span><strong>{rupee(route?.summary.cash??0)}</strong></div></div>
    <Heading title="Route stops" detail="Local route suggestions use straight-line distance. Confirm road navigation before departure."
      action={route&&route.orders.length>1?<button className="button secondary" disabled={busy} onClick={()=>route&&void save(optimize(route.origin,route.orders))}><Route size={17}/> Suggest stop order</button>:undefined}/>
    {!route?.orders.length?<div className="panel"><Empty title="No active stops" detail="Ready orders assigned by the owner will appear here."/></div>:<div className="stop-list">
      {route.orders.map((stop,index)=><article className="panel padded route-stop" key={stop.id}><div className="stop-number">{index+1}</div>
        <div className="stop-address"><b>{displayOrder(stop.id)}</b><small><MapPin size={14}/> {stop.address.line1}, {stop.address.locality}</small><small>{stop.address.landmark}</small></div>
        <Status value={stop.status}/><div className="actions"><button className="icon-button" disabled={busy||index===0} aria-label="Move stop earlier" onClick={()=>shift(index,-1)}><ArrowUp size={18}/></button><button className="icon-button" disabled={busy||index===route.orders.length-1} aria-label="Move stop later" onClick={()=>shift(index,1)}><ArrowDown size={18}/></button><button className="button primary small" onClick={()=>setOpening(stop.id)}>View stop <ArrowRight size={15}/></button></div>
      </article>)}
    </div>}
    <Heading title="Assigned order history"/>
    <div className="panel table-scroll">{!rows.length?<Empty title="No assigned orders yet"/>:<table><thead><tr><th>Order</th><th>Window</th><th>Status</th><th>Payment</th></tr></thead><tbody>
      {rows.map(o=><tr key={o.id}><td><button className="text-arrow" onClick={()=>setOpening(o.id)}>{displayOrder(o.id)}</button></td><td>{o.slot_start&&o.slot_end?windowLabel(o.slot_start,o.slot_end):'—'}</td><td><Status value={o.status}/></td><td>{pretty(o.payment_status)}</td></tr>)}
    </tbody></table>}</div>
    {cursor&&<button className="button secondary align-start" disabled={loadingHistory} onClick={()=>void moreHistory()}>{loadingHistory?'Loading…':'Load older orders'}</button>}
    {opening&&<OrderView orderId={opening} account={account} shop={shop} onClose={()=>{setOpening(null);void load()}} extra={(order,refresh)=><StopActions order={order} refreshed={async()=>{await refresh();await load()}}/>}/>}
  </main>
}
function StopActions({order,refreshed}:{order:OrderDetail;refreshed:()=>Promise<void>}){
  const [reason,setReason]=useState(''),[cash,setCash]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const methods=order.status==='ready'?[['out_for_delivery','Confirm pickup']]:order.status==='out_for_delivery'?[['completed','Mark delivered'],['failed','Report failure']]:[]
  if(!methods.length)return null
  const due=order.payment_status==='cash_due'
  const addr=order.address
  const nav=addr?.latitude!=null&&addr.longitude!=null?`https://www.openstreetmap.org/?mlat=${addr.latitude}&mlon=${addr.longitude}#map=17/${addr.latitude}/${addr.longitude}`:null
  return <div className="panel padded stack"><h3>Stop actions</h3><ErrorText text={error}/>
    {nav&&<a className="button secondary align-start" href={nav} target="_blank" rel="noopener noreferrer"><Navigation size={16}/> Open destination in OpenStreetMap</a>}
    {addr&&<a className="text-arrow align-start" href={'tel:'+addr.phone}>Call {addr.recipient}</a>}
    {order.status==='out_for_delivery'&&<>
      {due&&<label>Cash collected (₹)<input type="number" min="0" step=".01" placeholder={String(order.total/100)} value={cash} onChange={e=>setCash(e.target.value)}/></label>}
      <label>Failure reason<input placeholder="Required if delivery failed" maxLength={280} value={reason} onChange={e=>setReason(e.target.value)}/></label>
    </>}
    <div className="actions">{methods.map(([status,label])=><button key={status} className={'button '+(status==='failed'?'secondary':'primary')} disabled={busy||(status==='failed'&&!reason.trim())||(status==='completed'&&due&&!cash)} onClick={async()=>{
      setBusy(true);setError('')
      try{await send('/orders/'+order.id+'/state',{status,reason,...(due&&cash?{cash:Math.round(Number(cash)*100)}:{})});await refreshed()}
      catch(e){setError(message(e))}finally{setBusy(false)}
    }}>{label}</button>)}</div>
  </div>
}
