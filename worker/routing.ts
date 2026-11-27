import { Hono } from 'hono'
import { all,distance,one,Problem,role,savedDeliveryAddress,shop } from './shared'
import type { Env } from './shared'
import { isMapboxToken,mapboxMatrix,matrixElements } from './mapbox'

export const routing=new Hono<Env>()
const maxStops=12
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

routing.post('/rider/route/suggest',async c=>{
  const actor=role(c,'owner','rider')
  const token=c.env.MAPBOX_ROUTING_TOKEN
  if(!isMapboxToken(token))throw new Problem(503,'Road routing is unavailable. Arrange stops manually.')
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
    const address=savedDeliveryAddress(stop.address_json)
    if(!address)continue
    const {latitude,longitude}=address
    if(typeof latitude==='number'&&Number.isFinite(latitude)&&Math.abs(latitude)<=90&&
       typeof longitude==='number'&&Number.isFinite(longitude)&&Math.abs(longitude)<=180&&
       distance(config.latitude,config.longitude,latitude,longitude)<=config.radius_km){
      pinned.push({id:stop.id,location:[longitude,latitude]})
    }
  }
  if(pinned.length<2)throw new Problem(422,'Pin at least two active delivery stops within the service radius, or arrange stops manually.')
  const destinations=distinctDestinations(nearbyStops(pinned))
  const locations:Location[]=[[config.longitude,config.latitude],...destinations.map(d=>d.location)]
  const payload=(suggestion:RoadSuggestion,credits:number)=>c.json({
    ids:suggestion.indices.flatMap(i=>destinations[i-1].ids),
    seconds:suggestion.seconds,meters:suggestion.meters,credits,provider:'Mapbox',
  })
  if(destinations.length===1&&locations[0].join()===locations[1].join()){
    return payload({indices:[1],seconds:0,meters:0},0)
  }
  const suggestion=optimizeMatrix(await mapboxMatrix(db,token,locations))
  return payload(suggestion,matrixElements(destinations.length))
})
