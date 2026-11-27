import type { Point,RoadPoint } from '../worker/navigation-model'

export type GpsSample=Point&{accuracy:number;heading:number|null;speed:number|null;at:number}
export type RiderFix=GpsSample&{bearing:number|null}
export type RoadVertex=Point&{x:number;y:number;at:number}
export type Progress={along:number;offSince:number|null;offSamples:number;arrived:boolean}

const rad=Math.PI/180
const north=111320
export const emptyProgress:Progress={along:0,offSince:null,offSamples:0,arrived:false}
export const goodAccuracy=45

export function confirmedDeviation(progress:Progress,at:number){
  return progress.offSamples>=3&&progress.offSince!==null&&at-progress.offSince>=6500
}

export function gap(a:Point,b:Point){
  return north*Math.hypot(b.latitude-a.latitude,(b.longitude-a.longitude)*Math.cos((a.latitude+b.latitude)*rad/2))
}

export function course(a:Point,b:Point){
  return (Math.atan2((b.longitude-a.longitude)*Math.cos(a.latitude*rad),b.latitude-a.latitude)/rad+360)%360
}

export function riderFix(sample:GpsSample,previous:RiderFix|null):RiderFix|null{
  if(!Number.isFinite(sample.accuracy)||sample.accuracy>goodAccuracy||sample.accuracy<0||
      !Number.isFinite(sample.latitude)||!Number.isFinite(sample.longitude))return null
  const differ=previous?gap(previous,sample):0
  const deviceCourse=sample.speed!==null&&sample.speed>=1.3&&sample.heading!==null&&Number.isFinite(sample.heading)?
    (sample.heading%360+360)%360:null
  if(previous){
    const elapsed=(sample.at-previous.at)/1000
    if(elapsed<=0||elapsed<12&&differ>Math.max(45,elapsed*45+previous.accuracy+sample.accuracy))return null
    // Keep the previous position and direction when a stationary fix jitters inside its error radius.
    const threshold=sample.speed!==null&&sample.speed>=1.3?3:Math.max(5,Math.min(18,Math.max(previous.accuracy,sample.accuracy)*.65))
    if(differ<threshold){
      return {...sample,latitude:previous.latitude,longitude:previous.longitude,bearing:previous.bearing??deviceCourse}
    }
  }
  const bearing=deviceCourse??(previous&&differ>=6?course(previous,sample):previous?.bearing??null)
  return {...sample,bearing}
}

export function measureRoad(line:RoadPoint[]):RoadVertex[]{
  if(!line.length)return []
  const [lon0,lat0]=line[0],east=north*Math.cos(lat0*rad)
  let length=0
  return line.map(([longitude,latitude],index)=>{
    if(index)length+=Math.hypot((longitude-line[index-1][0])*east,(latitude-line[index-1][1])*north)
    return {longitude,latitude,x:(longitude-lon0)*east,y:(latitude-lat0)*north,at:length}
  })
}

export function roadPosition(road:RoadVertex[],meters:number){
  let low=0,high=road.length-1
  while(high-low>1){
    const mid=(low+high)>>1
    if(road[mid].at<meters)low=mid
    else high=mid
  }
  const a=road[low],b=road[high]
  const part=b.at>a.at?Math.max(0,Math.min(1,(meters-a.at)/(b.at-a.at))):0
  return {latitude:a.latitude+(b.latitude-a.latitude)*part,longitude:a.longitude+(b.longitude-a.longitude)*part,index:low}
}

export function progressAlong(road:RoadVertex[],previous:Progress,fix:RiderFix,elapsed:number):Progress{
  if(!road.length)return previous
  const first=road[0],end=road.at(-1)!
  const x=(fix.longitude-first.longitude)*north*Math.cos(first.latitude*rad),y=(fix.latitude-first.latitude)*north
  let nearest=Infinity,along=previous.along
  // A bounded forward search avoids jumping to parallel roads or a later visit on a loop.
  const farthest=previous.along+Math.max(250,Math.min(2200,elapsed*38))
  for(let i=1;i<road.length;i++){
    const a=road[i-1],b=road[i]
    if(b.at<previous.along-80)continue
    if(a.at>farthest)break
    const dx=b.x-a.x,dy=b.y-a.y,square=dx*dx+dy*dy
    const part=square?Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/square)):0
    const at=a.at+part*(b.at-a.at)
    if(at>farthest)continue
    const distance=Math.hypot(x-a.x-part*dx,y-a.y-part*dy)
    if(distance<nearest-2){nearest=distance;along=at}
  }
  if(road.length===1)nearest=gap(fix,end)
  const off=nearest>Math.max(75,fix.accuracy*2.6)
  if(off){
    return {...previous,offSince:previous.offSince??fix.at,offSamples:previous.offSamples+1,arrived:false}
  }
  along=Math.max(along,previous.along)
  const arrived=end.at-along<=35&&fix.accuracy<=22&&gap(fix,end)<=Math.max(17,fix.accuracy*1.35)
  return {along,offSince:null,offSamples:0,arrived}
}
