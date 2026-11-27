import { reserve } from './budget'
import type { NavigationLeg,RoadCost,RoadPoint } from './navigation-model'
import { Problem } from './shared'
import type { Ctx } from './shared'

export const mapboxLimits={matrix:2500,directions:2500,tiles:4000,addressTiles:1200} as const
export const mapboxServices={matrix:'mapbox-matrix',directions:'mapbox-directions',tiles:'mapbox-static-tiles',addressTiles:'mapbox-address-tiles'} as const
export const tileAllowance=96
export const addressTileAllowance=20

export async function mapboxMapSession(c:Ctx,kind:'tiles'|'addressTiles'){
  const token=c.env.MAPBOX_TILE_TOKEN
  if(!isMapboxToken(token)||!token.startsWith('pk.')||
      c.env.APP_MODE!=='local'&&token===c.env.MAPBOX_ROUTING_TOKEN){
    throw new Problem(503,'The road map is not configured.')
  }
  const allowance=kind==='tiles'?tileAllowance:addressTileAllowance
  if(!await reserve(c.env.DB,mapboxServices[kind],allowance,mapboxLimits[kind],kind==='tiles'?5:1)){
    throw new Problem(429,'The road map is busy or at its daily limit.')
  }
  return c.json({token,tileAllowance:allowance})
}
const tokenPattern=/^(pk|sk)\.[\w-]+\.[\w-]+$/
const noRoad='Road directions are temporarily unavailable. You can still open a stop or use Google Maps.'
const validNumber=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0
export const isMapboxToken=(token:string|undefined):token is string=>Boolean(token&&tokenPattern.test(token))
export const matrixElements=(destinations:number)=>(destinations+1)*destinations

async function navigate<T>(path:string,token:string,points:RoadPoint[],params:Record<string,string>){
  const coordinates=points.map(point=>point.join(',')).join(';')
  const url=new URL('https://api.mapbox.com/'+path+'/mapbox/driving/'+coordinates)
  url.search=new URLSearchParams({...params,access_token:token}).toString()
  let reply:Response
  try{reply=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(7500)})}
  catch{throw new Problem(503,noRoad,'mapbox_transport')}
  if(!reply.ok){
    await reply.body?.cancel()
    throw new Problem(503,noRoad,'mapbox_http_'+reply.status)
  }
  try{return await reply.json<T>()}
  catch{throw new Problem(503,noRoad,'mapbox_payload')}
}

export async function mapboxMatrix(db:D1Database,token:string,points:RoadPoint[]):Promise<RoadCost[][]>{
  const destinations=points.slice(1).map((_,index)=>index+1).join(';')
  if(!await reserve(db,mapboxServices.matrix,matrixElements(points.length-1),mapboxLimits.matrix,3)){
    throw new Problem(429,'Road optimization is busy or at its daily limit. Try again shortly.','routing_budget')
  }
  const data=await navigate<{code?:string;durations?:unknown[][];distances?:unknown[][]}>(
    'directions-matrix/v1',token,points,{annotations:'duration,distance',destinations})
  const {durations,distances}=data??{}
  if(data?.code!=='Ok'||!Array.isArray(durations)||durations.length!==points.length||
      !Array.isArray(distances)||distances.length!==points.length){
    throw new Problem(503,noRoad,'mapbox_matrix')
  }
  const zero={seconds:0,meters:0}
  return durations.map((row,i)=>{
    const lengths=distances[i]
    if(!Array.isArray(row)||row.length!==points.length-1||!Array.isArray(lengths)||lengths.length!==row.length){
      throw new Problem(503,noRoad,'mapbox_matrix')
    }
    return [zero,...row.map((seconds,j)=>{
      const meters=lengths[j]
      if(!validNumber(seconds)||!validNumber(meters)||meters>150000){
        throw new Problem(422,'A stop has no suitable road connection. Check its pinned location.','mapbox_unreachable')
      }
      return {seconds,meters}
    })]
  })
}

type MapboxStep={geometry?:{type?:string;coordinates?:unknown[]};maneuver?:{instruction?:unknown}}
type MapboxLeg={steps?:MapboxStep[];duration?:unknown;distance?:unknown}

export async function mapboxDirections(db:D1Database,token:string,points:RoadPoint[]):Promise<Omit<NavigationLeg,'ids'>[]>{
  if(!await reserve(db,mapboxServices.directions,1,mapboxLimits.directions,3)){
    throw new Problem(429,'Road directions are busy or at their daily limit. Try again shortly.','routing_budget')
  }
  const data=await navigate<{code?:string;routes?:{legs?:MapboxLeg[]}[]}>('directions/v5',token,points,{
    steps:'true',geometries:'geojson',overview:'false',radiuses:points.map(()=>150).join(';'),
  })
  if(data?.code==='NoRoute'||data?.code==='NoSegment')throw new Problem(422,'A stop has no suitable road connection. Check its pinned location.')
  const legs=data?.routes?.[0]?.legs
  if(data?.code!=='Ok'||!Array.isArray(legs)||legs.length!==points.length-1){
    throw new Problem(503,noRoad,'mapbox_directions')
  }
  let vertices=0
  return legs.map(leg=>{
    if(!validNumber(leg?.duration)||!validNumber(leg.distance)||!Array.isArray(leg.steps)||!leg.steps.length){
      throw new Problem(503,noRoad,'mapbox_leg')
    }
    const line:RoadPoint[]=[],steps:NavigationLeg['steps']=[]
    for(const step of leg.steps){
      const coordinates=step?.geometry?.coordinates
      if(step?.geometry?.type!=='LineString'||!Array.isArray(coordinates)||!coordinates.length){
        throw new Problem(503,noRoad,'mapbox_step')
      }
      let at=line.length
      for(const [index,coordinate] of coordinates.entries()){
        if(++vertices>18000||!Array.isArray(coordinate)||!Number.isFinite(coordinate[0])||
            !Number.isFinite(coordinate[1])||Math.abs(coordinate[0])>180||Math.abs(coordinate[1])>85){
          throw new Problem(503,noRoad,'mapbox_geometry')
        }
        const previous=line.at(-1)
        if(previous&&previous[0]===coordinate[0]&&previous[1]===coordinate[1]){
          if(index===0)at=line.length-1
        }else line.push([coordinate[0],coordinate[1]])
      }
      const instruction=step.maneuver?.instruction
      if(typeof instruction==='string'&&instruction)steps.push({at,text:instruction.slice(0,240)})
    }
    if(line.length<2&&leg.distance>0)throw new Problem(503,noRoad,'mapbox_geometry')
    return {line,steps,meters:Math.round(leg.distance),seconds:Math.round(leg.duration)}
  })
}
