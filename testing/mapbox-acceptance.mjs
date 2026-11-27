import assert from 'node:assert/strict'
import { mkdtemp,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { action,harness,login,place,session } from '../tests/harness.mjs'
import { measureRoad,roadPosition } from '../src/rider-motion.ts'

const {MAPBOX_ROUTING_TOKEN,MAPBOX_TILE_TOKEN,KIRANA_PLAYWRIGHT_MODULE,KIRANA_CHROMIUM_PATH,KIRANA_WEBKIT_PATH}=process.env
if(!MAPBOX_ROUTING_TOKEN||!MAPBOX_TILE_TOKEN)throw new Error('Mapbox acceptance requires both tokens.')
const {chromium,webkit,devices}=await import(KIRANA_PLAYWRIGHT_MODULE||'playwright')
const directory=await mkdtemp(join(tmpdir(),'kirana-mapbox-acceptance-'))
const seed=join(directory,'seed.sql')
const metrics={}
let preview
const pins=[[78.41768,17.41694],[78.42982,17.41951],[78.43454,17.40906]]
const coordinates=([longitude,latitude])=>({longitude,latitude,accuracy:8})
const exact=(container,name)=>container.getByRole('button',{name,exact:true})

try{
  await writeFile(seed,`UPDATE settings SET latitude=17.4116,longitude=78.422,radius_km=6,
    accepting=1,enable_cod=1,enable_online=0,enable_delivery=1,open_hour=0,close_hour=24,
    preparation=0,delivery_capacity=30 WHERE id=1;`)
  preview=await harness(seed,{entry:'qa',vars:{MAPBOX_ROUTING_TOKEN,MAPBOX_TILE_TOKEN}})
  const {base}=preview
  const owner=await login(base,'owner'),rider=await login(base,'rider')
  await action(owner,'/admin/products',{sku:'ACCEPT-MAP-3',name:'Mapbox acceptance pack',category:'fresh',
    unit:'pc',step:1,price:2500,stock:12},201).then(({id})=>{metrics.productId=id})
  const sku=metrics.productId
  delete metrics.productId
  const shipments=new Map()
  const mark=(who,id,status,more={})=>action(who,'/orders/'+id+'/state',{status,...more})
  const read=(who,id)=>who('/api/orders/'+id)
  const signIn=async(browserContext,role)=>{
    const reply=await browserContext.request.post(base+'/api/auth/demo',{headers:{Origin:base},data:{role}})
    assert.equal(reply.status(),200)
  }
  const initially=await rider('/api/rider/route')
  for(const [index,pin] of pins.entries()){
    const account=session(base)
    await action(account,'/auth/register-local',{name:'Isolated buyer '+(index+1)})
    const {id:addressId}=await action(account,'/addresses',{...coordinates(pin),label:'Home',
      recipient:'Isolated buyer '+(index+1),phone:'9000000099',line1:'Acceptance lane '+(index+1),
      locality:'Hyderabad',pin:'500034'},201)
    const [slot]=await account('/api/slots?mode=delivery')
    const {id}=await place(account,{fulfillment:'delivery',method:'cash',slot:slot.start,addressId,items:[{id:sku,steps:1}]})
    await mark(owner,id,'accepted')
    await mark(owner,id,'packing')
    await mark(owner,id,'ready')
    await action(owner,'/orders/'+id+'/assign')
    shipments.set(id,account)
  }
  const assigned=await rider('/api/rider/route?v='+initially.version)
  assert.equal(assigned.orders.length,3)
  assert.deepEqual(await rider('/api/rider/route?v='+assigned.version),{unchanged:true})

  for(const [name,engine,device,executablePath] of [
    ['iPhone WebKit',webkit,devices['iPhone 15'],KIRANA_WEBKIT_PATH],
    ['Android Chromium',chromium,devices['Pixel 7'],KIRANA_CHROMIUM_PATH],
  ]){
    // The two device profiles share the one rider's provider admission budget.
    if(engine===chromium)await delay(5100)
    const browser=await engine.launch(executablePath?{executablePath}:{})
    try{
      const context=await browser.newContext({...device,...(engine===chromium?{permissions:['geolocation'],
        geolocation:coordinates([78.422,17.4116])}:{})})
      const page=await context.newPage()
      if(engine===webkit){
        await signIn(context,'customer')
        await page.goto(base)
        await page.locator('.location-button').click()
        await exact(page,'Add address').click()
        await exact(page,'Set pin').click()
        const map=page.locator('.map-pin-canvas')
        await map.locator('.leaflet-tile-loaded').first().waitFor({timeout:25000})
        assert.equal(await page.getByLabel('Latitude',{exact:true}).count(),0)
        await map.click({position:{x:Math.floor((await map.boundingBox()).width*.65),y:75}})
        await page.getByLabel('Latitude',{exact:true}).waitFor()
        assert.equal(Number.isFinite(Number(await page.getByLabel('Latitude',{exact:true}).inputValue())),true)
        metrics.customerPin={realMapTiles:true,explicitSelection:true,emulated:'iPhone WebKit'}
      }
      await signIn(context,'rider')
      const summary={routes:0,tileRequests:0,tile200:0,tileBodyBytes:0}
      const pending=[]
      let routeStart=0
      const errors=[]
      page.on('pageerror',error=>errors.push(error.name))
      page.on('request',request=>{
        const url=new URL(request.url())
        if(url.pathname==='/api/rider/navigation'){summary.routes++;routeStart=performance.now()}
        if(url.host==='api.mapbox.com'&&url.pathname.includes('/tiles/512/'))summary.tileRequests++
      })
      page.on('requestfinished',request=>{
        const url=new URL(request.url())
        if(url.host==='api.mapbox.com'&&url.pathname.includes('/tiles/512/')){
          pending.push((async()=>{
            const reply=await request.response()
            if(reply?.ok()){
              summary.tile200++
              summary.tileBodyBytes+=(await request.sizes()).responseBodySize
            }
          })())
        }
      })
      const planPromise=page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/rider/navigation',{timeout:30000})
      await page.goto(base+'/rider')
      const response=await planPromise
      assert.equal(response.status(),200,JSON.stringify(await response.json()).slice(0,240))
      const plan=await response.json()
      summary.routeMs=Math.round(performance.now()-routeStart)
      summary.routeBytes=(await response.body()).length
      summary.routeD1=JSON.parse((await response.allHeaders())['x-kirana-d1'])
      assert.equal(plan.provider,'Mapbox')
      assert.equal(plan.legs.length,3)
      assert.equal(new Set(plan.legs.flatMap(leg=>leg.ids)).size,3)
      assert.ok(plan.legs.every(leg=>leg.line.length>2&&leg.steps.length>1))
      assert.ok(plan.matrix.optimizedSeconds<=plan.matrix.orderedSeconds)
      summary.routeMeters=plan.meters
      summary.routePoints=plan.legs.reduce((count,leg)=>count+leg.line.length,0)
      await page.locator('.leaflet-tile-loaded').first().waitFor({timeout:25000})
      await page.locator('.mapbox-logo').waitFor()
      assert.equal(await page.getByText('Start simulation',{exact:true}).count(),0)
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
      if(engine===chromium){
        const road=measureRoad(plan.legs[0].line)
        const start=roadPosition(road,0)
        await context.setGeolocation({...start,accuracy:8})
        await exact(page,'Start delivery').click()
        const marker=page.locator('.rider-location-marker')
        await marker.waitFor()
        const previous=await marker.getAttribute('style')
        await context.setGeolocation({...roadPosition(road,18),accuracy:8})
        await page.waitForFunction(style=>{
          const candidate=document.querySelector('.rider-location-marker')
          return candidate&&candidate.classList.contains('has-bearing')&&candidate.getAttribute('style')!==style
        },previous)
        await exact(page,'Recenter on my location').click()
        await page.locator('.leaflet-control-zoom-out').click()
        await exact(page,'Recenter on my location').click()
        for(const leg of plan.legs){
          const [id]=leg.ids,customer=shipments.get(id)
          if((await read(customer,id)).status==='ready'){
            await exact(page,'Confirm pickup').click()
            await exact(page.getByRole('dialog'),'Confirm pickup').click()
          }
          await exact(page,'Complete delivery').click()
          assert.equal((await read(customer,id)).status,'out_for_delivery')
          const total=(await read(customer,id)).total
          const dialog=page.getByRole('dialog')
          await dialog.getByLabel('Cash collected (₹)').fill(String(total/100))
          await exact(dialog,'Mark delivered').click()
          await dialog.waitFor({state:'detached'})
          const completed=await read(customer,id)
          assert.equal(completed.status,'completed')
          assert.equal(completed.payment_status,'cash_collected')
          assert.equal((await read(owner,id)).status,'completed')
          assert.equal((await read(rider,id)).address,null)
        }
        await page.getByText('No active stops',{exact:true}).waitFor()
        assert.equal(await page.getByRole('region',{name:'Interactive delivery map'}).count(),1)
        assert.equal(await page.getByRole('button',{name:'Start delivery',exact:true}).count(),0)
        assert.equal(summary.routes,1)
        summary.completed=3
      }
      await Promise.all(pending)
      assert.ok(summary.tile200>0)
      assert.deepEqual(errors,[])
      metrics[name]=summary
    }finally{await browser.close()}
  }
  assert.equal((await rider('/api/rider/route')).orders.length,0)
  const stock=await owner('/api/catalog/'+sku)
  assert.equal(stock.stock,9)
  metrics.budgets=await preview.readBusiness("SELECT service,used FROM service_budget WHERE service LIKE 'mapbox-%' ORDER BY service")
  console.log(JSON.stringify(metrics,null,2))
}finally{
  try{await preview?.stop()}finally{await rm(directory,{recursive:true,force:true})}
}
