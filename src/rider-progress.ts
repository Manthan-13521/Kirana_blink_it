import { useEffect,useMemo,useState } from 'react'
import type { NavigationLeg,Point } from '../worker/navigation-model'
import { confirmedDeviation,emptyProgress,gap,goodAccuracy,measureRoad,progressAlong,riderFix } from './rider-motion'
import type { Progress,RiderFix } from './rider-motion'

type ProgressSample={leg:NavigationLeg;fix:RiderFix;progress:Progress}

export function useRiderLocation(tracking:boolean,leg:NavigationLeg|undefined){
  const [gps,setGps]=useState<RiderFix|null>(null)
  const [gpsError,setError]=useState('')
  const road=useMemo(()=>measureRoad(leg?.line??[]),[leg])
  useEffect(()=>{
    if(!tracking){setGps(null);setError('');return}
    let watch:number|undefined,timer:ReturnType<typeof setTimeout>|undefined,previous:RiderFix|null=null
    let generation=0
    const stop=()=>{
      generation++
      clearTimeout(timer)
      if(watch!==undefined){navigator.geolocation.clearWatch(watch);watch=undefined}
    }
    const sync=()=>{
      stop()
      if(document.visibilityState!=='visible'){setGps(null);return}
      if(!navigator.geolocation){setError('Location is unavailable in this browser.');return}
      const observer=generation
      setError('')
      watch=navigator.geolocation.watchPosition(({coords,timestamp})=>{
        if(observer!==generation)return
        const next=riderFix({latitude:coords.latitude,longitude:coords.longitude,accuracy:coords.accuracy,
          speed:coords.speed,heading:coords.heading,at:timestamp},previous)
        if(!next){
          if(coords.accuracy>goodAccuracy)setError('Weak GPS signal')
          return
        }
        previous=next
        setGps(next);setError('')
        clearTimeout(timer)
        timer=setTimeout(()=>{if(observer===generation){setGps(null);setError('Waiting for a fresh GPS signal…')}},18000)
      },error=>{
        if(observer!==generation)return
        if(error.code===1){stop();setGps(null)}
        setError(error.code===1?'Location permission is off. You can still view the route.':'Waiting for a stronger GPS signal…')
      },{enableHighAccuracy:true,maximumAge:5000,timeout:15000})
    }
    sync()
    document.addEventListener('visibilitychange',sync)
    return ()=>{document.removeEventListener('visibilitychange',sync);stop()}
  },[tracking])
  return {gps:tracking?gps:null,gpsError,road}
}

export function useTurn(leg:NavigationLeg|undefined,road:ReturnType<typeof measureRoad>,gps:RiderFix|null,destination:Point|null,tracking:boolean){
  const [sample,setSample]=useState<ProgressSample|null>(null)
  useEffect(()=>{
    if(!tracking){setSample(null);return}
    if(!gps||!leg||!road.length)return
    setSample(previous=>{
      const prior=previous?.leg===leg?previous:null
      if(prior?.fix===gps)return previous
      const elapsed=prior?Math.max(1,(gps.at-prior.fix.at)/1000):3
      return {leg,fix:gps,progress:progressAlong(road,prior?.progress??emptyProgress,gps,elapsed)}
    })
  },[gps,leg,road,tracking])
  const progress=tracking&&sample?.leg===leg?sample?.progress:undefined
  const advance=progress?.along??0
  const end=road.at(-1)?.at??0
  const fraction=end?Math.min(1,advance/end):0
  const steps=leg?.steps??[]
  const step=advance>4?steps.find(item=>road[item.at]?.at>advance+12):steps[0]
  const offRoute=Boolean(gps&&progress&&confirmedDeviation(progress,gps.at))
  const onRoute=Boolean(gps&&progress?.offSamples===0)
  const nearPin=Boolean(gps&&destination&&gap(gps,destination)<=Math.max(28,gps.accuracy*1.5))
  const arrived=Boolean(gps&&progress?.arrived&&nearPin)
  return {
    travelled:advance,distanceTravelled:(leg?.meters??0)*fraction,timeTravelled:(leg?.seconds??0)*fraction,
    instruction:arrived?'You have arrived':progress?.arrived&&gps?'You are at the end of the driving route':
      step?.text??(leg?'Continue to the delivery pin':''),
    meters:step&&advance>4?Math.max(0,Math.round(road[step.at].at-advance)):null,
    turnAt:step&&step.at>0&&!offRoute&&!arrived?step.at:null,offRoute,onRoute,arrived,
  }
}
