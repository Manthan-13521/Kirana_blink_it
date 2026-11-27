import { Hono } from 'hono'
import { fastestTrip,tripStopLimit } from './navigation-model'
import type { NavigationLeg,NavigationPlan,Point,RoadPoint } from './navigation-model'
import { isMapboxToken,mapboxDirections,mapboxMapSession,mapboxMatrix } from './mapbox'
import { all,coordinate,distance,json,obj,Problem,role,S,savedDeliveryAddress,shop } from './shared'
import type { Env } from './shared'

export const riderNavigation=new Hono<Env>()
const round=(value:number)=>Math.round(value*100000)/100000
const roadPoint=(point:Point):RoadPoint=>[round(point.longitude),round(point.latitude)]

function pointFrom(lat:unknown,lon:unknown):Point|null{
  const latitude=coordinate(lat,85),longitude=coordinate(lon,180)
  return latitude===null||longitude===null?null:{latitude,longitude}
}

riderNavigation.post('/rider/navigation',async c=>{
  const rider=role(c,'rider'),data=await json(c),db=c.env.DB
  if(!Array.isArray(data.ids)||data.ids.length<1||data.ids.length>tripStopLimit||
      data.manual!==undefined&&typeof data.manual!=='boolean')throw new Problem(400,'Invalid trip.')
  const ids=data.ids.map(value=>S(value,'order ID',80))
  if(new Set(ids).size!==ids.length)throw new Problem(400,'A stop occurs more than once.')
  const [store,orders]=await Promise.all([
    shop(db),
    all<{id:string;address_json:string|null}>(db,`WITH selected AS MATERIALIZED (
        SELECT id,address_json,assigned_to,fulfillment,status FROM orders WHERE id IN (${ids.map(()=>'?').join(',')})
      ) SELECT id,address_json FROM selected
      WHERE assigned_to=? AND fulfillment='delivery' AND status IN('ready','out_for_delivery')`,...ids,rider.id),
  ])
  if(orders.length!==ids.length)throw new Problem(403,'A trip stop is no longer assigned to you.')
  const storePoint={latitude:store.latitude,longitude:store.longitude}
  const custom=data.origin===undefined?null:obj(data.origin)
  const origin=custom?pointFrom(custom.latitude,custom.longitude):storePoint
  if(!origin||distance(store.latitude,store.longitude,origin.latitude,origin.longitude)>store.radius_km+5){
    throw new Problem(400,'Route starting point is outside the store area.')
  }
  const start=roadPoint(origin),byId=new Map(orders.map(order=>[order.id,order.address_json]))
  const atStart:string[]=[]
  const stops:{point:RoadPoint;ids:string[]}[]=[]
  for(const id of ids){
    const address=savedDeliveryAddress(byId.get(id)??null)
    const point=pointFrom(address?.latitude,address?.longitude)
    if(!point||distance(store.latitude,store.longitude,point.latitude,point.longitude)>store.radius_km+0.05){
      throw new Problem(422,'A stop needs a pin inside the delivery area.')
    }
    const target=roadPoint(point)
    if(target.join()===start.join()&&(!data.manual||!stops.length)){atStart.push(id);continue}
    const previous=stops.at(-1)
    const existing=data.manual?(previous?.point.join()===target.join()?previous:undefined):stops.find(stop=>stop.point.join()===target.join())
    if(existing)existing.ids.push(id)
    else stops.push({point:target,ids:[id]})
  }
  const token=c.env.MAPBOX_ROUTING_TOKEN
  let ordered=stops,road:Omit<NavigationLeg,'ids'>[]=[],comparison:NavigationPlan['matrix']
  if(stops.length){
    if(!isMapboxToken(token))throw new Problem(503,'Road directions are not configured.')
    const baseline=stops.map(stop=>stop.point)
    if(!data.manual&&stops.length>1){
      const matrix=await mapboxMatrix(db,token,[start,...baseline])
      const best=fastestTrip(matrix)
      const orderedSeconds=baseline.reduce((sum,_,index)=>sum+matrix[index][index+1].seconds,0)
      comparison={orderedSeconds:Math.round(orderedSeconds),optimizedSeconds:Math.round(best.seconds)}
      ordered=best.indices.map(index=>stops[index-1])
    }
    road=await mapboxDirections(db,token,[start,...ordered.map(stop=>stop.point)])
  }
  const legs:NavigationLeg[]=road.map((leg,i)=>({...leg,ids:ordered[i].ids}))
  if(atStart.length)legs.unshift({ids:atStart,line:[start],steps:[],seconds:0,meters:0})
  const plan:NavigationPlan={
    provider:'Mapbox',origin,legs,...(comparison?{matrix:comparison}:{}),
    seconds:legs.reduce((total,leg)=>total+leg.seconds,0),
    meters:legs.reduce((total,leg)=>total+leg.meters,0),
  }
  return c.json(plan)
})

riderNavigation.post('/rider/map-session',async c=>{
  role(c,'rider')
  return mapboxMapSession(c,'tiles')
})
