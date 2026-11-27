import { tripStopLimit } from '../worker/navigation-model.ts'
import type { Point } from '../worker/navigation-model'
import type { Address } from './lib'

type DeliveryPin=Pick<Address,'latitude'|'longitude'>
export type TripStop={id:string;slotEnd?:number|null;address:DeliveryPin|null}

export function coordinates(address:DeliveryPin|null):Point|null{
  const latitude=address?.latitude,longitude=address?.longitude
  return typeof latitude==='number'&&Number.isFinite(latitude)&&Math.abs(latitude)<=85&&
    typeof longitude==='number'&&Number.isFinite(longitude)&&Math.abs(longitude)<=180?{latitude,longitude}:null
}
const due=(stop:TripStop)=>stop.slotEnd??Number.MAX_SAFE_INTEGER

export function groupTrips(stops:TripStop[]){
  const left=stops.flatMap(stop=>{
    const point=coordinates(stop.address)
    return point?[{stop,point}]:[]
  }).sort((a,b)=>due(a.stop)-due(b.stop))
  const groups:string[][]=[]
  while(left.length){
    const [anchor]=left.splice(0,1)
    const proximity=(point:Point)=>((point.latitude-anchor.point.latitude)**2)+
      ((point.longitude-anchor.point.longitude)*Math.cos(anchor.point.latitude*Math.PI/180))**2
    left.sort((a,b)=>due(a.stop)-due(b.stop)||proximity(a.point)-proximity(b.point))
    const last=left.findIndex(entry=>due(entry.stop)!==due(anchor.stop))
    const count=last===-1?tripStopLimit-1:Math.min(last,tripStopLimit-1)
    groups.push([anchor.stop.id,...left.splice(0,count).map(entry=>entry.stop.id)])
  }
  return groups
}
