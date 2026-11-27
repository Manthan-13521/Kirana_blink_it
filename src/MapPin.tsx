import { useEffect,useRef,useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { mapboxAttribution,mapboxTiles,MapboxLogo } from './mapbox-tiles'
import type { Point } from '../worker/navigation-model'

export default function MapPin({latitude,longitude,point,set}:Point&{point:Point|null;set:(lat:number,lng:number)=>void}){
  const div=useRef<HTMLDivElement>(null),map=useRef<L.Map|null>(null),marker=useRef<L.CircleMarker|null>(null)
  const callback=useRef(set),visible=useRef(false),chosen=useRef(point)
  const [tiles,setTiles]=useState<boolean|null>(null)
  useEffect(()=>{callback.current=set;chosen.current=point},[set,point])
  useEffect(()=>{
    if(!div.current)return
    const center:L.LatLngTuple=[latitude,longitude]
    const canvas=div.current
    const instance=L.map(canvas,{minZoom:10,maxZoom:18,scrollWheelZoom:false,
      maxBounds:L.latLng(center).toBounds(40000),maxBoundsViscosity:1}).setView(center,15)
    instance.attributionControl.setPrefix(false).addAttribution(mapboxAttribution)
    mapboxTiles('/addresses/map-session',shown=>{visible.current=shown;setTiles(shown)}).addTo(instance)
    instance.on('click',event=>{if(visible.current)callback.current(event.latlng.lat,event.latlng.lng)})
    const keys:Record<string,[number,number]>={ArrowUp:[.0005,0],ArrowDown:[-.0005,0],ArrowLeft:[0,-.0005],ArrowRight:[0,.0005]}
    const adjust=(event:KeyboardEvent)=>{
      const change=keys[event.key]
      if(event.target!==canvas||!change||!visible.current)return
      event.preventDefault();event.stopPropagation()
      const from=chosen.current??{latitude,longitude}
      callback.current(Math.max(-85,Math.min(85,from.latitude+change[0])),
        ((from.longitude+change[1]+540)%360)-180)
    }
    canvas.addEventListener('keydown',adjust,true)
    map.current=instance
    return ()=>{
      canvas.removeEventListener('keydown',adjust,true)
      instance.remove();map.current=null;marker.current=null;visible.current=false
    }
  },[latitude,longitude])
  useEffect(()=>{
    const instance=map.current
    if(!instance)return
    if(!point||!Number.isFinite(point.latitude)||Math.abs(point.latitude)>85||
        !Number.isFinite(point.longitude)||Math.abs(point.longitude)>180){
      marker.current?.remove();marker.current=null;return
    }
    const selected:L.LatLngTuple=[point.latitude,point.longitude]
    if(!marker.current)marker.current=L.circleMarker(selected,{radius:8,color:'#145edc',fillOpacity:1,
      interactive:false}).addTo(instance)
    else marker.current.setLatLng(selected)
    if(!instance.getBounds().contains(selected))instance.panTo(selected,{animate:false})
  },[point,latitude,longitude])
  return <div className="map-pin">
    <div className="map-pin-frame"><div className="map-pin-canvas" ref={div} aria-label="Delivery address map"/>
      {tiles===true&&<MapboxLogo/>}
    </div>
    <small>{tiles===true?'Tap your delivery location to place the pin. You can also use the arrow keys.':
      tiles===false?'Road map unavailable. You can still use your device location.':'Loading the road map…'}</small>
  </div>
}
