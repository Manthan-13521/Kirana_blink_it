import { useEffect,useRef,useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { mapboxAttribution,mapboxTiles,MapboxLogo } from './mapbox-tiles'
import { gap,roadPosition } from './rider-motion'
import type { RiderFix,RoadVertex } from './rider-motion'
import type { NavigationLeg,Point } from '../worker/navigation-model'

type Marker={id:string;title:string;point:Point;number?:number}
const latLng=(point:Point):L.LatLngTuple=>[point.latitude,point.longitude]
const riderIcon=L.divIcon({className:'rider-location-marker',
  html:'<span class="rider-location-arrow" aria-hidden="true"></span>',iconSize:[34,34],iconAnchor:[17,17]})
const between=(from:number,to:number,part:number)=>from+(to-from)*part


export default function RiderMap({origin,radius,markers,legs,gps,next,onStop,centerRequest,follow,showAll,onManual,road,travelled,turnAt}:{
  origin:Point;radius:number;markers:Marker[];legs:NavigationLeg[];gps:RiderFix|null;next:string|undefined
  onStop:(id:string)=>void;centerRequest:number;follow:boolean;showAll:boolean;onManual:()=>void
  road:RoadVertex[];travelled:number;turnAt:number|null
}){
  const container=useRef<HTMLDivElement>(null),map=useRef<L.Map|null>(null)
  const layers=useRef<L.LayerGroup|null>(null),position=useRef<L.LayerGroup|null>(null)
  const turn=useRef<L.CircleMarker|null>(null)
  const heading=useRef<number|null>(null),rider=useRef<L.Marker|null>(null),accuracy=useRef<L.Circle|null>(null)
  const activeLine=useRef<L.Polyline[]|null>(null),covered=useRef<L.Polyline|null>(null)
  const lastCamera=useRef(0),lastCentered=useRef(0),tracking=useRef(follow)
  const callback=useRef(onStop),manual=useRef(onManual)
  const cameraIsManual=useRef(false)
  const recenterZoom=16

  const viewed=useRef<{ids:Set<string>;showAll:boolean;lastLeg?:NavigationLeg}>({ids:new Set(),showAll:false})
  const touching=useRef(0)
  const [tiles,setTiles]=useState<boolean|null>(null)
  useEffect(()=>{callback.current=onStop;manual.current=onManual;tracking.current=follow},[onStop,onManual,follow])
  useEffect(()=>{
    if(!container.current)return
    const site=latLng(origin),bounds=L.latLng(site).toBounds((radius+6)*2000)
    const instance=L.map(container.current,{minZoom:10,maxZoom:18,maxBounds:bounds,maxBoundsViscosity:1,
      scrollWheelZoom:false,zoomControl:false,keyboard:true}).setView(site,14)
    instance.attributionControl.setPrefix(false).addAttribution(mapboxAttribution)
    L.control.zoom({position:'topleft'}).addTo(instance)
    const suspend=()=>{
      cameraIsManual.current=true
      tracking.current=false
      manual.current()
    }
    const focusMap=(event:KeyboardEvent)=>{
      if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','+','-','=','_'].includes(event.key))suspend()
    }
    const zoomAction=(event:Event)=>{
      if(event.target instanceof Element&&event.target.closest('.leaflet-control-zoom'))suspend()
    }
    instance.on('dragstart boxzoomstart dblclick',suspend)
    instance.on('zoomstart',()=>{
      // Pinch zoom has no drag event. Programmatic zooms do not leave a touch gesture active.
      if(touching.current>1)suspend()
    })
    const touch=(event:TouchEvent)=>{touching.current=event.touches.length;if(touching.current>1)suspend()}
    const canvas=container.current
    canvas.addEventListener('keydown',focusMap)
    canvas.addEventListener('click',zoomAction,true)
    canvas.addEventListener('touchstart',touch,{passive:true})
    canvas.addEventListener('touchend',touch,{passive:true})
    canvas.addEventListener('touchcancel',touch,{passive:true})
    mapboxTiles('/rider/map-session',setTiles).addTo(instance)
    L.marker(site,{title:'Store',icon:L.divIcon({className:'rider-map-store',html:'<span aria-hidden="true">◆</span>',
      iconSize:[30,30],iconAnchor:[15,15]})}).addTo(instance)
    layers.current=L.layerGroup().addTo(instance)
    position.current=L.layerGroup().addTo(instance)
    map.current=instance
    const resize=new ResizeObserver(()=>instance.invalidateSize({pan:false,debounceMoveend:true}))
    resize.observe(container.current)
    return ()=>{
      resize.disconnect()
      canvas.removeEventListener('keydown',focusMap)
      canvas.removeEventListener('click',zoomAction,true)
      canvas.removeEventListener('touchstart',touch)
      canvas.removeEventListener('touchend',touch)
      canvas.removeEventListener('touchcancel',touch)
      instance.remove();map.current=null;layers.current=null;position.current=null;rider.current=null;accuracy.current=null;turn.current=null
      viewed.current={ids:new Set(),showAll:false}
    }
  },[origin.latitude,origin.longitude,radius])
  useEffect(()=>{
    const group=layers.current,instance=map.current
    if(!group||!instance)return
    group.clearLayers()
    activeLine.current=null
    covered.current=L.polyline([],{color:'#7990a3',weight:5,opacity:.8,interactive:false,
      className:'rider-travelled-line'}).addTo(group)
    for(const [i,leg] of legs.entries()){
      if(leg.line.length<2)continue
      const line=leg.line.map(([lon,lat]):L.LatLngTuple=>[lat,lon])
      const edge=L.polyline(line,{color:'#ffffff',weight:9,opacity:.93,interactive:false}).addTo(group)
      const stroke=L.polyline(line,{color:'#145edc',weight:i===0?6:4,opacity:i===0?1:.58,interactive:false,
        className:'rider-road-line'}).addTo(group)
      if(i===0)activeLine.current=[edge,stroke]
    }
    const locations=new Map<string,Marker[]>()
    for(const stop of markers){
      const key=latLng(stop.point).join(),at=locations.get(key)??[]
      at.push(stop);locations.set(key,at)
    }
    for(const stops of locations.values()){
      const numbered=stops.filter(stop=>stop.number!==undefined).sort((a,b)=>a.number!-b.number!)
      const label=numbered.length?numbered[0].number+(numbered.length>1?'+':''):''
      const destination=numbered.find(stop=>stop.id===next)??numbered[0]??stops[0]
      const title=stops.length>1?destination.title+' and '+(stops.length-1)+' more at this pin':destination.title
      const marker=L.marker(latLng(destination.point),{title,alt:title,zIndexOffset:numbered.length?400:0,
        icon:L.divIcon({className:'rider-map-stop'+(label?' numbered':'')+(stops.some(stop=>stop.id===next)?' next':''),
          html:label,iconSize:label?[28,28]:[13,13],iconAnchor:label?[14,14]:[6,6]})}).addTo(group)
      marker.getElement()?.setAttribute('aria-label',title)
      marker.on('click',()=>callback.current(destination.id))
    }
    const selected=markers.filter(stop=>stop.number!==undefined)
    const visible=showAll||!selected.length?markers:selected
    const lastLeg=legs.at(-1),previous=viewed.current
    const changedView=previous.showAll!==showAll||visible.some(stop=>!previous.ids.has(stop.id))
    const newGeometry=lastLeg&&lastLeg!==previous.lastLeg
    if(visible.length&&(changedView||newGeometry)&&(!tracking.current||showAll)&&(!cameraIsManual.current||changedView)){
      const frame=L.latLngBounds([latLng(origin),...visible.map(stop=>latLng(stop.point))])
      if(!showAll||newGeometry)for(const leg of legs)for(const [lon,lat] of leg.line)frame.extend([lat,lon])
      if(changedView||!instance.getBounds().pad(.08).contains(frame)){
        instance.fitBounds(frame,{padding:[30,34],maxZoom:16,animate:false})
      }
    }
    viewed.current={ids:new Set(visible.map(stop=>stop.id)),showAll,lastLeg}
  },[legs,markers,next,origin,showAll])
  useEffect(()=>{
    if(!activeLine.current||road.length<2)return
    const point=roadPosition(road,travelled)
    const complete=road.slice(0,point.index+1).map(latLng)
    const remaining=road.slice(point.index+1).map(latLng)
    covered.current?.setLatLngs(travelled>5?[...complete,latLng(point)]:[])
    for(const line of activeLine.current)line.setLatLngs([latLng(point),...remaining])
  },[travelled,road,legs,markers,next,origin,showAll])
  useEffect(()=>{
    const instance=map.current
    if(!instance)return
    const vertex=turnAt===null?undefined:road[turnAt]
    if(!vertex){turn.current?.remove();turn.current=null;return}
    if(!turn.current){
      turn.current=L.circleMarker(latLng(vertex),{radius:5,color:'#fff',weight:3,fillColor:'#145edc',
        fillOpacity:1,interactive:false,className:'rider-next-turn'}).addTo(instance)
    }else turn.current.setLatLng(latLng(vertex)).bringToFront()
  },[road,turnAt,origin.latitude,origin.longitude])
  useEffect(()=>{
    const group=position.current
    if(!group)return
    if(!gps){group.clearLayers();rider.current=null;accuracy.current=null;heading.current=null;return}
    const target=latLng(gps)
    if(!rider.current){
      rider.current=L.marker(target,{icon:riderIcon,zIndexOffset:900,interactive:false,keyboard:false}).addTo(group)
      rider.current.getElement()?.setAttribute('aria-label','Your GPS position')
      accuracy.current=L.circle(target,{radius:gps.accuracy,weight:1,color:'#1261d4',fillOpacity:.12,interactive:false}).addTo(group)
    }
    const marker=rider.current,element=marker.getElement()
    const from=marker.getLatLng(),bearing=gps.bearing
    const prior=heading.current??bearing??0
    const rotation=bearing===null?0:(bearing-prior+540)%360-180
    const smooth=!matchMedia('(prefers-reduced-motion: reduce)').matches&&
      gap({latitude:from.lat,longitude:from.lng},gps)<250
    const began=performance.now(),duration=smooth?260:0
    let frame=0
    const draw=(time:number)=>{
      const part=duration?Math.min(1,(time-began)/duration):1
      const moved:L.LatLngTuple=[between(from.lat,gps.latitude,part),between(from.lng,gps.longitude,part)]
      marker.setLatLng(moved);accuracy.current?.setLatLng(moved)
      heading.current=prior+rotation*part
      element?.style.setProperty('--rider-bearing',heading.current+'deg')
      element?.classList.toggle('has-bearing',bearing!==null)
      if(part<1)frame=requestAnimationFrame(draw)
    }
    accuracy.current?.setRadius(gps.accuracy)
    if(duration)frame=requestAnimationFrame(draw)
    else draw(began)
    return ()=>cancelAnimationFrame(frame)
  },[gps])
  useEffect(()=>{
    const instance=map.current
    if(!gps||!instance||!follow)return
    const first=centerRequest!==lastCentered.current||lastCamera.current===0
    if(!first&&performance.now()-lastCamera.current<1050)return
    const bearing=(gps.bearing??0)*Math.PI/180
    const zoom=first?Math.max(instance.getZoom(),recenterZoom):instance.getZoom()
    const location=instance.project(latLng(gps),zoom)
    // North-up with extra space in the direction of travel on any screen orientation.
    const lead=gps.bearing!==null?Math.min(95,instance.getSize().y*.20):0
    const center=instance.unproject(location.add(L.point(Math.sin(bearing)*lead,-Math.cos(bearing)*lead)),zoom)
    if(!first&&instance.latLngToContainerPoint(center).distanceTo(instance.getSize().divideBy(2))<30)return
    cameraIsManual.current=false
    lastCentered.current=centerRequest
    lastCamera.current=performance.now()
    if(first)instance.setView(center,zoom,{animate:false})
    else instance.panTo(center,{animate:!matchMedia('(prefers-reduced-motion: reduce)').matches,duration:.25})
  },[centerRequest,gps,follow])
  return <div className="rider-map-frame">
    <div className="rider-map-canvas" ref={container} role="region" aria-label="Interactive delivery map"/>
    {tiles===true&&<MapboxLogo/>}
    {tiles!==true&&<small className="rider-map-notice">{tiles===null?'Loading road map…':'Road map temporarily unavailable. Your stop pins and any loaded directions are still shown.'}</small>}
  </div>
}
