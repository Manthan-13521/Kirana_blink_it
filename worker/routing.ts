import { Hono } from 'hono'
import { all,digest,distance,now,one,Problem,role,shop,statement } from './shared'
import type { Address,Env } from './shared'
import { reserve } from './budget'

export const routing=new Hono<Env>()
const maxStops=12
export const routingCreditCap=2100
const cacheSeconds=5*60
type Location=[number,number]
type RoadLeg={seconds:number;meters:number}
type PinnedStop={id:string;location:Location}
type RoadSuggestion=RoadLeg&{indices:number[]}

export function nearbyStops(stops:PinnedStop[]){
  if(stops.length<=maxStops)return stops
  // Keep the first ready stop in the current dispatch order as the anchor.
  const [anchor,...rest]=stops
  const proximity=({location:[lon,lat]}:PinnedStop)=>distance(anchor.location[1],anchor.location[0],lat,lon)
  return [anchor,...rest.map(stop=>({stop,km:proximity(stop)}))
    .sort((a,b)=>a.km-b.km).slice(0,maxStops-1).map(item=>item.stop)]
}
export function distinctDestinations(stops:PinnedStop[]){
  const destinations=new Map<string,{location:Location;ids:string[]}>()
  for(const stop of stops){
    const key=stop.location.join(',')
    const existing=destinations.get(key)
    if(existing)existing.ids.push(stop.id)
    else destinations.set(key,{location:stop.location,ids:[stop.id]})
  }
  return [...destinations.values()].sort((a,b)=>a.location[0]-b.location[0]||a.location[1]-b.location[1])
}

export function routeCredits(destinations:number){
  return (destinations+1)*Math.min(destinations,10)
}

const better=(a:RoadLeg,b:RoadLeg)=>a.seconds<b.seconds||a.seconds===b.seconds&&a.meters<b.meters
export function optimizeMatrix(matrix:RoadLeg[][]):RoadSuggestion{
  const remaining=matrix.slice(1).map((_,i)=>i+1),route=[0]
  while(remaining.length){
    const current=route[route.length-1]
    const best=remaining.reduce((a,b)=>better(matrix[current][b],matrix[current][a])?b:a)
    route.push(best)
    remaining.splice(remaining.indexOf(best),1)
  }
  function total(path:number[]){
    let seconds=0,meters=0
    for(let i=1;i<path.length;i++){
      const leg=matrix[path[i-1]][path[i]]
      seconds+=leg.seconds;meters+=leg.meters
    }
    return {seconds,meters}
  }
  let sum=total(route)
  for(let pass=0;pass<3;pass++){
    let improved=false
    for(let a=1;a<route.length-1;a++)for(let b=a+1;b<route.length;b++){
      const alternative=[...route.slice(0,a),...route.slice(a,b+1).reverse(),...route.slice(b+1)]
      const candidate=total(alternative)
      if(better(candidate,sum)){
        improved=true;sum=candidate
        route.splice(0,route.length,...alternative)
      }
    }
    if(!improved)break
  }
  return {indices:route.slice(1),seconds:Math.round(sum.seconds),meters:Math.round(sum.meters)}
}

export async function roadTimes(key:string,locations:Location[],request:typeof fetch=(input,init)=>globalThis.fetch(input,init)){
  const sources=locations.map(location=>({location})),targets=sources.slice(1)
  const response=await request('https://api.geoapify.com/v1/routematrix',{
    method:'POST',headers:{'Content-Type':'application/json','x-api-key':key},redirect:'manual',signal:AbortSignal.timeout(6500),
    body:JSON.stringify({mode:'drive',sources,targets}),
  })
  if(!response.ok){
    await response.body?.cancel()
    throw new Problem(503,'Road routing is temporarily unavailable. Keep your current stop order.','geoapify_http_'+response.status)
  }
  const data=await response.json<{sources_to_targets?:{time?:number|null;distance?:number;from_index?:number;to_index?:number}[][]}>()
  const rows=data.sources_to_targets
  if(!Array.isArray(rows)||rows.length!==sources.length)throw new Problem(503,'The routing provider returned an incomplete matrix.')
  const zero={seconds:0,meters:0}
  return rows.map((row,i)=>{
    if(!Array.isArray(row)||row.length!==targets.length)throw new Problem(503,'The routing provider returned an incomplete matrix.')
    return [zero,...row.map((cell,j)=>{
      if(i===j+1)return zero
      if(!cell||cell.from_index!==undefined&&cell.from_index!==i||cell.to_index!==undefined&&cell.to_index!==j||
        typeof cell.time!=='number'||!Number.isFinite(cell.time)||cell.time<0||
        typeof cell.distance!=='number'||!Number.isFinite(cell.distance)||cell.distance<0||cell.distance>150000){
        throw new Problem(422,'A stop has no suitable road connection. Check its pinned location.')
      }
      return {seconds:cell.time,meters:cell.distance}
    })]
  })
}

routing.post('/rider/route/suggest',async c=>{
  const actor=role(c,'owner','rider')
  const key=c.env.GEOAPIFY_KEY
  if(!key)throw new Problem(503,'Road routing is unavailable. Arrange stops manually.')
  const db=c.env.DB
  const riderId=actor.role==='rider'?actor.id:(await one<{id:string}>(db,"SELECT id FROM accounts WHERE role='rider' AND active=1"))?.id
  if(!riderId)throw new Problem(409,'Assign a rider first.')
  const [config,stops]=await Promise.all([
    shop(db),
    all<{id:string;address_json:string|null}>(db,`SELECT id,address_json FROM orders
      WHERE assigned_to=? AND status IN('ready','out_for_delivery') ORDER BY route_rank,created_at,id LIMIT 30`,riderId),
  ])
  const pinned:PinnedStop[]=[]
  for(const stop of stops){
    if(!stop.address_json)continue
    const {latitude,longitude}=JSON.parse(stop.address_json) as Address
    if(typeof latitude==='number'&&Number.isFinite(latitude)&&Math.abs(latitude)<=90&&
       typeof longitude==='number'&&Number.isFinite(longitude)&&Math.abs(longitude)<=180&&
       distance(config.latitude,config.longitude,latitude,longitude)<=config.radius_km){
      pinned.push({id:stop.id,location:[longitude,latitude]})
    }
  }
  if(pinned.length<2)throw new Problem(422,'Pin at least two active delivery stops within the service radius, or arrange stops manually.')
  const destinations=distinctDestinations(nearbyStops(pinned))
  const locations:Location[]=[[config.longitude,config.latitude],...destinations.map(d=>d.location)]
  const fingerprint=await digest(JSON.stringify(locations)),time=now()
  const match=await one<{suggestion:string}>(db,'SELECT suggestion FROM routing_cache WHERE id=1 AND fingerprint=? AND expires_at>?',fingerprint,time)
  const payload=(suggestion:RoadSuggestion,credits:number)=>c.json({
    ids:suggestion.indices.flatMap(i=>destinations[i-1].ids),
    seconds:suggestion.seconds,meters:suggestion.meters,credits,provider:'Geoapify',
  })
  if(match)return payload(JSON.parse(match.suggestion) as RoadSuggestion,0)
  // All stops at the store pin form one delivery location and need no provider request.
  if(destinations.length===1&&locations[0][0]===locations[1][0]&&locations[0][1]===locations[1][1]){
    return payload({indices:[1],seconds:0,meters:0},0)
  }
  const charge=routeCredits(destinations.length)
  if(!await reserve(db,'routing',charge,routingCreditCap,15))throw new Problem(429,'Road routing is busy or at its daily limit. Arrange stops manually.')
  let suggestion:RoadSuggestion
  try{suggestion=optimizeMatrix(await roadTimes(key,locations))}catch(error){
    if(error instanceof Problem)throw error
    const cause=error instanceof Error?error.name:''
    throw new Problem(503,'Road routing is temporarily unavailable. Keep your current stop order.',
      cause==='TimeoutError'||cause==='AbortError'?'geoapify_timeout':'geoapify_transport')
  }
  await statement(db,`INSERT INTO routing_cache(id,fingerprint,suggestion,expires_at) VALUES(1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,suggestion=excluded.suggestion,expires_at=excluded.expires_at`,
    fingerprint,JSON.stringify(suggestion),now()+cacheSeconds).run()
  return payload(suggestion,charge)
})
