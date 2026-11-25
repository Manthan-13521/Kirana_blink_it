import { useEffect,useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export default function MapPin({latitude,longitude,set}:{latitude:number;longitude:number;set:(lat:number,lng:number)=>void}){
  const div=useRef<HTMLDivElement>(null), callback=useRef(set)
  useEffect(()=>{callback.current=set},[set])
  useEffect(()=>{
    if(!div.current)return
    const center:L.LatLngTuple=[latitude,longitude]
    const map=L.map(div.current,{attributionControl:false}).setView(center,14)
    L.circleMarker(center,{radius:10,color:'#173d32',fillOpacity:1}).addTo(map)
    map.on('click', event=>callback.current(event.latlng.lat,event.latlng.lng))
    return ()=>{map.remove()}
  },[latitude,longitude])
  useEffect(()=>{
    if(!div.current)return
    const node=div.current
    const onKey=(event:KeyboardEvent)=>{
      const deltas:Record<string,[number,number]>={ArrowUp:[0.0005,0],ArrowDown:[-0.0005,0],ArrowLeft:[0,-0.0005],ArrowRight:[0,0.0005]}
      if(!deltas[event.key])return
      event.preventDefault()
      callback.current(latitude+deltas[event.key][0],longitude+deltas[event.key][1])
    }
    node.addEventListener('keydown',onKey)
    return ()=>node.removeEventListener('keydown',onKey)
  },[latitude,longitude])
  return <div className="map-pin"><div ref={div} tabIndex={0} aria-label="Local map pin. Use the arrow keys to adjust it."/><small>Local coordinates preview · map tiles are disabled</small></div>
}
