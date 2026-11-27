import { mkdtemp,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { action,harness,login,place } from '../tests/harness.mjs'

const roadPins=[
  [78.41768,17.41694],[78.42982,17.41951],[78.43454,17.40906],[78.42638,17.39856],[78.41173,17.40064],
  [78.40574,17.41492],[78.42273,17.42434],[78.43502,17.41779],[78.43567,17.40347],[78.42114,17.39515],
  [78.4053,17.40361],[78.40524,17.42205],[78.41785,17.42669],[78.43445,17.42334],[78.44036,17.40688],
  [78.42725,17.39311],[78.40666,17.39695],[78.3998,17.41727],[78.42394,17.42981],[78.44102,17.41969],
  [78.43994,17.39935],[78.41916,17.38943],[78.39936,17.40198],[78.40056,17.4263],[78.41728,17.4327],
  [78.43973,17.42706],[78.44591,17.40412],[78.42732,17.38619],[78.40111,17.39314],[78.39428,17.42051],
  [78.42606,17.43604],[78.44751,17.42107],[78.44398,17.39459],[78.41755,17.38366],[78.39307,17.401],
  [78.39664,17.43106],[78.41748,17.43879],[78.44536,17.42972],[78.45145,17.40082],[78.42712,17.38069],
  [78.39499,17.39133],[78.38913,17.42367],[78.42868,17.44142],[78.45365,17.42135],[78.4477,17.38964],
]
const count=Number(process.argv[2]??roadPins.length)
if(![3,5,10,20,45].includes(count))throw new Error('Use a demo size of 3, 5, 10, 20 or 45.')
const {MAPBOX_ROUTING_TOKEN,MAPBOX_TILE_TOKEN}=process.env
if(!MAPBOX_ROUTING_TOKEN||!MAPBOX_TILE_TOKEN)throw new Error('Configure both Mapbox tokens for the local demo.')

const directory=await mkdtemp(join(tmpdir(),'kirana-rider-demo-'))
const seed=join(directory,'seed.sql')
let preview
try{
  await writeFile(seed,`UPDATE settings SET latitude=17.4116,longitude=78.422,radius_km=6,name='Kirana Demo',
    accepting=1,enable_cod=1,enable_online=0,enable_delivery=1,open_hour=0,close_hour=24,
    preparation=0,delivery_capacity=60 WHERE id=1;
    UPDATE products SET stock=1000 WHERE stock>0;`,{mode:0o600})
  preview=await harness(seed,{entry:'qa',vars:{MAPBOX_ROUTING_TOKEN,MAPBOX_TILE_TOKEN}})
  const customer=await login(preview.base,'customer')
  const owner=await login(preview.base,'owner')
  const [slot]=await customer('/api/slots?mode=delivery')
  const {products}=await customer('/api/catalog?limit=20')
  const product=products.find(item=>item.stock===1000&&item.step*item.min_steps<15)
  if(!slot||!product)throw new Error('The local fixtures require an open delivery window and an in-stock demo item.')

  for(const [index,[longitude,latitude]] of roadPins.slice(0,count).entries()){
    const label='Synthetic delivery '+(index+1)
    const address=await action(customer,'/addresses',{label,recipient:label,phone:'9000000099',
      line1:label,locality:'Hyderabad demo',pin:'500034',latitude,longitude},201)
    const delivery=await place(customer,{fulfillment:'delivery',method:'cash',slot:slot.start,addressId:address.id,
      items:[{id:product.id,steps:product.min_steps}]})
    await action(owner,'/orders/'+delivery.id+'/state',{status:'accepted'})
    await action(owner,'/orders/'+delivery.id+'/assign')
    for(const status of ['packing','ready'])await action(owner,'/orders/'+delivery.id+'/state',{status})
    await customer('/api/addresses/'+address.id,{method:'DELETE'})
  }
  console.log(`${count} synthetic deliveries are ready at ${preview.base}/rider`)
  await new Promise(resolve=>{
    const stop=()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);resolve()}
    process.on('SIGINT',stop)
    process.on('SIGTERM',stop)
  })
}finally{
  try{await preview?.stop()}finally{await rm(directory,{recursive:true,force:true})}
}
