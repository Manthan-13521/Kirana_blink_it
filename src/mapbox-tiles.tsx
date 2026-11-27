import L from 'leaflet'
import { send } from './lib'

export const mapboxAttribution='© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://apps.mapbox.com/feedback/">Improve this map</a>'
type MapSession={token:string;tileAllowance:number}

export function mapboxTiles(sessionPath:string,onAvailability:(shown:boolean)=>void){
  const jobs=new Map<HTMLElement,AbortController>()
  let grant:MapSession|undefined,loading:Promise<MapSession>|undefined,hasTiles=false,retryAt=0
  async function tileToken(){
    if(!grant?.tileAllowance){
      if(Date.now()<retryAt)throw new Error('Map temporarily unavailable')
      loading??=send<MapSession>(sessionPath).then(session=>{
        if(!session.token.startsWith('pk.')||!Number.isSafeInteger(session.tileAllowance)||session.tileAllowance<1){
          throw new Error('Invalid map session')
        }
        grant=session
        return session
      }).catch(error=>{
        retryAt=Date.now()+60000
        throw error
      }).finally(()=>{loading=undefined})
      const session=await loading
      if(!session.tileAllowance)return tileToken()
    }
    grant!.tileAllowance--
    return grant!.token
  }
  class RiderTiles extends L.GridLayer {
    createTile(coords:L.Coords,done:L.DoneCallback){
      const tile=document.createElement('img'),controller=new AbortController()
      tile.alt=''
      tile.referrerPolicy='strict-origin-when-cross-origin'
      jobs.set(tile,controller)
      const finish=(error?:Error)=>{
        jobs.delete(tile)
        if(controller.signal.aborted)return
        if(!error){hasTiles=true;onAvailability(true)}
        else if(!hasTiles)onAvailability(false)
        done(error,tile)
      }
      void tileToken().then(token=>{
        if(controller.signal.aborted)return
        tile.onload=()=>finish()
        tile.onerror=()=>finish(new Error('Map tile unavailable'))
        // A 512 px Mapbox tile covers the same area as four standard Leaflet tiles.
        tile.src='https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/'+
          (coords.z-1)+'/'+coords.x+'/'+coords.y+'?access_token='+encodeURIComponent(token)
      }).catch(()=>finish(new Error('Map tile unavailable')))
      return tile
    }
  }
  const layer=new RiderTiles({tileSize:512,minZoom:10,maxZoom:18,noWrap:true,keepBuffer:1})
  function cancel(tile:HTMLImageElement){
    jobs.get(tile)?.abort()
    jobs.delete(tile)
    tile.removeAttribute('src')
  }
  layer.on('tileunload',event=>cancel(event.tile))
  layer.on('remove',()=>{for(const tile of jobs.keys())cancel(tile as HTMLImageElement)})
  return layer
}

export function MapboxLogo(){
  return <a className="mapbox-logo" href="https://www.mapbox.com/" aria-label="Mapbox">
    <img src="/mapbox-logo.svg" alt="" width="82" height="20"/>
  </a>
}
