import { Hono } from 'hono'
import { all,one,Problem,role,shop } from './shared'
import type { Address,Env } from './shared'
import { reserve } from './budget'

export const routing=new Hono<Env>()
const maxStops=12
export const routingCreditCap=2250
type Location=[number,number]

export function optimizeMatrix(matrix:number[][]){
  const remaining=matrix.slice(1).map((_,i)=>i+1), route=[0]
  while(remaining.length){
    const current=route[route.length-1]
    const best=remaining.reduce((a,b)=>matrix[current][a]<=matrix[current][b]?a:b)
    route.push(best)
    remaining.splice(remaining.indexOf(best),1)
  }
  const duration=(path:number[])=>path.slice(1).reduce((sum,stop,i)=>sum+matrix[path[i]][stop],0)
  for(let pass=0;pass<3;pass++){
    let improved=false
    for(let a=1;a<route.length-1;a++)for(let b=a+1;b<route.length;b++){
      const alternative=[...route.slice(0,a),...route.slice(a,b+1).reverse(),...route.slice(b+1)]
      if(duration(alternative)<duration(route)){
        improved=true
        route.splice(0,route.length,...alternative)
      }
    }
    if(!improved)break
  }
  return {indices:route.slice(1),seconds:Math.round(duration(route))}
}

export async function roadTimes(key:string,locations:Location[],request:typeof fetch=fetch){
  const points=locations.map(location=>({location}))
  const response=await request('https://api.geoapify.com/v1/routematrix?apiKey='+encodeURIComponent(key),{
    method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(6500),
    body:JSON.stringify({mode:'drive',sources:points,targets:points}),
  })
  if(!response.ok)throw new Problem(503,'Road routing is temporarily unavailable. Keep your current stop order.')
  const data=await response.json<{sources_to_targets?:{time?:number|null;distance?:number;from_index?:number;to_index?:number}[][]}>()
  const rows=data.sources_to_targets
  if(!Array.isArray(rows)||rows.length!==points.length)throw new Problem(503,'The routing provider returned an incomplete matrix.')
  return rows.map((row,i)=>{
    if(!Array.isArray(row)||row.length!==points.length)throw new Problem(503,'The routing provider returned an incomplete matrix.')
    return row.map((cell,j)=>{
      if(i===j)return 0
      if(cell.from_index!==undefined&&cell.from_index!==i||cell.to_index!==undefined&&cell.to_index!==j||
        typeof cell.time!=='number'||!Number.isFinite(cell.time)||cell.time<0||typeof cell.distance!=='number'||cell.distance>150000){
        throw new Problem(422,'A stop has no suitable road connection. Check its pinned location.')
      }
      return cell.time
    })
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
    all<{id:string;address_json:string}>(db,`SELECT id,address_json FROM orders
      WHERE assigned_to=? AND status IN('ready','out_for_delivery') ORDER BY route_rank,created_at,id LIMIT ?`,riderId,maxStops+1),
  ])
  if(stops.length<2||stops.length>maxStops)throw new Problem(422,'Road optimization supports between 2 and 12 active stops.')
  const locations:Location[]=[[config.longitude,config.latitude]]
  for(const stop of stops){
    const addr=JSON.parse(stop.address_json) as Address
    if(addr.latitude===null||addr.longitude===null)throw new Problem(422,'Every stop needs a map pin for road routing.')
    locations.push([addr.longitude,addr.latitude])
  }
  // Local delivery radii avoid Geoapify long-distance surcharges. Keep shared headroom.
  const charge=locations.length*Math.min(locations.length,10)
  if(!await reserve(db,'routing',charge,routingCreditCap,15))throw new Problem(429,'Road routing is at its safe limit. Arrange stops manually.')
  let matrix:number[][]
  try{matrix=await roadTimes(key,locations)}catch(error){
    if(error instanceof Problem)throw error
    throw new Problem(503,'Road routing is temporarily unavailable. Keep your current stop order.')
  }
  const suggestion=optimizeMatrix(matrix)
  return c.json({ids:suggestion.indices.map(i=>stops[i-1].id),seconds:suggestion.seconds,provider:'Geoapify'})
})
