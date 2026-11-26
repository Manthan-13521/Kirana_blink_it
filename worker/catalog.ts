import { Hono } from 'hono'
import { jpegMime,mediaFileId,validMedia,webpMime } from './media-format'
import { all,audit,I,id,json,now,obj,one,Problem,role,S,statement } from './shared'
import type { Ctx, Env, Product } from './shared'

export const catalog=new Hono<Env>()
const terms=(value:string)=>[...new Set(value.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu)||[])]
const publicFields='id,sku,name,brand,description,category,subcategory,unit,step,price,mrp,stock,min_steps,max_steps,image,featured,variant_group'
async function searchCatalog(db:D1Database,words:string[],cursor:string){
  const aliases=await all<{term:string;canonical:string}>(db,`SELECT term,canonical FROM synonyms WHERE term IN (${words.map(()=>'?').join(',')})`,...words)
  const canonical=new Map(aliases.map(row=>[row.term,row.canonical]))
  // Prefer a pack or SKU token, otherwise start from the longest word.
  const [anchor,...additional]=words.map(word=>canonical.get(word)??word).sort((a,b)=>Number(/\d/.test(b))-Number(/\d/.test(a))||b.length-a.length)
  const prefix=(word:string)=>Array.from(word).slice(0,12).join('')
  const filters=['match.prefix=? AND match.product_id>?']
  const params=[prefix(anchor),cursor]
  for(const word of additional){
    if(word!==prefix(word))continue
    filters.push('EXISTS (SELECT 1 FROM search_prefixes extra WHERE extra.product_id=products.id AND extra.prefix=?)')
    params.push(word)
  }
  for(const word of [anchor,...additional].filter(word=>word!==prefix(word))){
    filters.push('EXISTS (SELECT 1 FROM search_terms term WHERE term.product_id=products.id AND instr(term.term,?)=1)')
    params.push(word)
  }
  return {source:'search_prefixes AS match CROSS JOIN products ON products.id=match.product_id',filters,params}
}
catalog.get('/categories',async c=>c.json(await all(c.env.DB,'SELECT id,label,image FROM categories ORDER BY sort,id')))
catalog.get('/catalog',async c=>{
  const db=c.env.DB
  const search=S(c.req.query('q')??'','search',100,false), category=c.req.query('category'), subcategory=c.req.query('subcategory')
  const words=terms(search).slice(0,5)
  const filters=["active=1 AND (expiry IS NULL OR expiry>=date('now','+330 minutes'))"]
  const params:unknown[]=[]
  const cursor=S(c.req.query('after')??'','cursor',80,false)
  const amount=c.req.query('limit')?I(Number(c.req.query('limit')),1,60,'page size'):24
  const featured=c.req.query('featured')==='1'
  if(category){filters.push('category=?');params.push(S(category,'category',60))}
  if(subcategory){filters.push('subcategory=?');params.push(S(subcategory,'subcategory',60))}
  if(featured) filters.push('featured=1')

  let source='products INDEXED BY '+(category&&subcategory?'products_category_subcategory':category?'products_category':subcategory?'products_subcategory':featured?'products_featured':'products_active_id')
  let sort='id'
  if(words.length){
    const search=await searchCatalog(db,words,cursor)
    source=search.source
    sort='match.product_id'
    filters.push(...search.filters)
    params.push(...search.params)
  } else {
    filters.push('id>?');params.push(cursor)
  }
  const products=await all<Product>(db,`SELECT ${publicFields} FROM ${source} WHERE ${filters.join(' AND ')} ORDER BY ${sort} LIMIT ?`,...params,amount+1)
  return c.json({products:products.slice(0,amount),next:products.length>amount?products[amount-1].id:null})
})
catalog.get('/catalog/:id',async c=>{
  const db=c.env.DB, product=await one<Product>(db,`SELECT ${publicFields} FROM products WHERE id=? AND active=1 AND (expiry IS NULL OR expiry>=date('now','+330 minutes'))`,c.req.param('id'))
  if(!product) throw new Problem(404,'Product not found.')
  if(c.req.query('variants')==='1'){
    const variants=product.variant_group?await all<Product>(db,`SELECT ${publicFields} FROM products
      WHERE variant_group=? AND variant_group<>'' AND active=1 AND (expiry IS NULL OR expiry>=date('now','+330 minutes'))
      ORDER BY step,id LIMIT 24`,product.variant_group):[]
    return c.json({product,variants})
  }
  return c.json(product)
})
catalog.get('/admin/products',async c=>{
  role(c,'owner','staff')
  const q=S(c.req.query('q')??'','search',100,false)
  const after=S(c.req.query('after')??'','cursor',80,false)
  const db=c.env.DB
  const stock=c.req.query('stock')
  if(stock!==undefined&&stock!=='low'&&stock!=='out')throw new Problem(400,'Invalid stock filter.')
  const stockFilter=stock==='out'?' AND products.active=1 AND products.stock=0'
    :stock==='low'?' AND products.active=1 AND products.stock>0 AND products.stock<=products.threshold':''
  const words=terms(q).slice(0,5)
  const search=words.length?await searchCatalog(db,words,after):null
  const data=search
    ?await all<Product>(db,`SELECT products.* FROM ${search.source} WHERE ${search.filters.join(' AND ')}${stockFilter} ORDER BY match.product_id LIMIT 81`,...search.params)
    :await all<Product>(db,'SELECT * FROM products WHERE id>?'+stockFilter+' ORDER BY id LIMIT 81',after)
  return c.json({products:data.slice(0,80),next:data.length>80?data[79].id:null})
})
catalog.get('/admin/products/:id/stock',async c=>{
  role(c,'owner','staff')
  const db=c.env.DB,productId=c.req.param('id')
  const events='SELECT id,quantity,reason,order_id,created_at FROM stock_events WHERE product_id=? ORDER BY id DESC LIMIT 50'
  if(c.req.query('summary')!=='1')return c.json(await all(db,events,productId))
  const result=await one<{available:number;reserved:number;events:string}>(db,`SELECT p.stock AS available,
    (SELECT COALESCE(SUM(i.quantity),0) FROM orders o JOIN order_items i ON i.order_id=o.id AND i.product_id=p.id
      WHERE o.stocked=1 AND o.status IN ('awaiting_payment','placed','accepted','packing','ready','out_for_delivery')) AS reserved,
    (SELECT json_group_array(json_object('id',id,'quantity',quantity,'reason',reason,'order_id',order_id,'created_at',created_at))
      FROM (${events})) AS events
    FROM products p WHERE p.id=?`,productId,productId)
  if(!result)throw new Problem(404,'Product not found.')
  return c.json({...result,events:JSON.parse(result.events)})
})
catalog.post('/admin/products/:id/stock',async c=>{
  const actor=role(c,'owner','staff'), db=c.env.DB, data=await json(c)
  const productId=c.req.param('id'), quantity=I(data.quantity,-100000000,100000000,'stock units')
  const reason=S(data.reason,'stock reason',40)
  if(!['receipt','adjustment','damaged','expired','return'].includes(reason)||!quantity||(['damaged','expired'].includes(reason)&&quantity>0)||(['receipt','return'].includes(reason)&&quantity<0)) throw new Problem(400,'Check the movement type and quantity.')
  if(!await one(db,'SELECT id FROM products WHERE id=?',productId)) throw new Problem(404,'Product not found.')
  await db.batch([
    statement(db,'INSERT INTO stock_events(product_id,quantity,reason,actor,created_at) VALUES(?,?,?,?,?)',productId,quantity,reason,actor.id,now()),
    audit(db,actor.id,'stock.'+reason,productId,String(quantity)),
  ])
  return c.json({ok:true})
})

function productFields(raw:Record<string,unknown>) {
  const sku=S(raw.sku,'SKU',40)
  if(!/^[\p{L}\p{N}_. -]+$/u.test(sku)) throw new Problem(400,'Use letters, numbers or basic separators in SKU.')
  const name=S(raw.name,'name',120), brand=S(raw.brand??'','brand',80,false)
  const description=S(raw.description??'','description',750,false), category=S(raw.category,'category',50)
  const subcategory=S(raw.subcategory??'','subcategory',70,false)
  const unit=S(raw.unit,'unit',3), step=I(raw.step,1,100000,'pack size')
  if(!['g','ml','pc'].includes(unit)) throw new Problem(400,'Invalid product unit.')
  const price=I(raw.price,1,10000000,'price'), mrp=I(raw.mrp??price,price,10000000,'MRP')
  const threshold=I(raw.threshold??0,0,100000000,'low-stock threshold')
  const min=I(raw.min_steps??1,1,100,'minimum pack count'), max=I(raw.max_steps??20,min,100,'maximum pack count')
  const tax=I(raw.tax_bps??0,0,2800,'GST rate'), hsn=S(raw.hsn??'','HSN',12,false)
  if(hsn&&!/^\d{4,8}$/.test(hsn)) throw new Problem(400,'HSN must be 4–8 digits.')
  const expiry=raw.expiry?S(raw.expiry,'expiry date',10):null
  if(expiry&&!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new Problem(400,'Invalid date.')
  const variant=raw.variant_group===undefined?null:S(raw.variant_group,'variant group',60,false).normalize('NFKC').toLowerCase()
  return { values:[sku,name,brand,description,category,subcategory,unit,step,price,mrp,threshold,min,max,tax,hsn,I(raw.active??1,0,1,'active'),I(raw.featured??0,0,1,'featured'),expiry,now()], variant,search:terms([sku,name,brand,subcategory].join(' ')).slice(0,35) }
}
const keys='sku,name,brand,description,category,subcategory,unit,step,price,mrp,threshold,min_steps,max_steps,tax_bps,hsn,active,featured,expiry,updated_at'.split(',')
function writeProduct(db:D1Database,raw:Record<string,unknown>,actor:string,productId:string,update:boolean) {
  const p=productFields(raw)
  const count=update?0:I(raw.stock??0,0,100000000,'opening stock')
  const operations=[
    update?statement(db,`UPDATE products SET ${keys.map(k=>k+'=?').join(',')}${p.variant===null?'':',variant_group=?'} WHERE id=?`,...p.values,...(p.variant===null?[]:[p.variant]),productId)
      :statement(db,`INSERT INTO products(id,stock,${keys.join(',')},variant_group) VALUES(?,0,${keys.map(()=>'?').join(',')},?)`,productId,...p.values,p.variant??''),
    statement(db,'DELETE FROM search_prefixes WHERE product_id=?',productId),
    statement(db,'DELETE FROM search_terms WHERE product_id=?',productId),
    statement(db,`INSERT OR IGNORE INTO search_terms(term,product_id) VALUES ${p.search.map(()=>'(?,?)').join(',')}`,...p.search.flatMap(term=>[term,productId])),
    audit(db,actor,update?'product.update':'product.create',productId),
  ]
  if(count) operations.push(statement(db,'INSERT INTO stock_events(product_id,quantity,reason,actor,created_at) VALUES(?,?,?,?,?)',productId,count,'opening',actor,now()))
  return operations
}
catalog.post('/admin/products',async c=>{
  const actor=role(c,'owner','staff'), db=c.env.DB, raw=await json(c), productId=id()
  await db.batch(writeProduct(db,raw,actor.id,productId,false))
  return c.json({id:productId},201)
})
catalog.put('/admin/products/:id',async c=>{
  const actor=role(c,'owner','staff'), db=c.env.DB, raw=await json(c), productId=c.req.param('id')
  if(!await one(db,'SELECT id FROM products WHERE id=?',productId)) throw new Problem(404,'Product not found.')
  await db.batch(writeProduct(db,raw,actor.id,productId,true))
  return c.json({ok:true})
})
catalog.delete('/admin/products/:id',async c=>{
  const actor=role(c,'owner'),db=c.env.DB,productId=c.req.param('id'),time=now()
  await db.batch([
    statement(db,'UPDATE products SET active=0,updated_at=? WHERE id=? AND active=1',time,productId),
    statement(db,"INSERT INTO audit(actor,action,subject,created_at) SELECT ?,'product.archive',?,? WHERE changes()=1",actor.id,productId,time),
  ])
  return c.json({ok:true})
})
catalog.post('/admin/products/import',async c=>{
  const actor=role(c,'owner'), db=c.env.DB, data=await json(c), entries=data.products
  if(!Array.isArray(entries)||!entries.length||entries.length>25) throw new Problem(400,'Import 1–25 rows per batch.')
  await db.batch(entries.flatMap(row=>writeProduct(db,obj(row),actor.id,id(),false)))
  return c.json({imported:entries.length})
})
catalog.post('/admin/categories',async c=>{
  const actor=role(c,'owner'), db=c.env.DB, data=await json(c), categoryId=id()
  const label=S(data.label,'category name',60)
  await db.batch([statement(db,'INSERT INTO categories(id,label,sort) VALUES(?,?,99)',categoryId,label),audit(db,actor.id,'category.create',categoryId,label)])
  return c.json({id:categoryId,label,image:null})
})
catalog.put('/admin/categories/:id',async c=>{
  const actor=role(c,'owner'),db=c.env.DB,categoryId=c.req.param('id'),data=await json(c)
  const label=S(data.label,'category name',60)
  const result=await db.batch([
    statement(db,'UPDATE categories SET label=? WHERE id=?',label,categoryId),
    statement(db,"INSERT INTO audit(actor,action,subject,detail,created_at) SELECT ?,'category.rename',?,?,? WHERE changes()=1",actor.id,categoryId,label,now()),
  ])
  if(!result[0].meta.changes)throw new Problem(404,'Category not found.')
  return c.json({ok:true})
})

async function stageImage(c:Ctx){
  const mime=c.req.header('content-type')??''
  if(mime!==webpMime&&mime!==jpegMime)throw new Problem(400,'Use a WebP or JPEG image.')
  const data=await c.req.arrayBuffer()
  if(!validMedia(data,mime))throw new Problem(400,'Use a valid image up to 512 pixels and 32 KiB.')
  const key=id(),imageUrl='/media/'+key+(mime===jpegMime?'.jpg':''),time=now()
  await statement(c.env.MEDIA,'INSERT INTO media(id,payload,size,created_at,expires_at,mime) VALUES(?,?,?,?,?,?)',
    key,data,data.byteLength,time,time+172800,mime).run()
  return {key,imageUrl,time}
}
async function activateImage(media:D1Database,key:string,time:number){
  await statement(media,'UPDATE media SET expires_at=NULL WHERE id=? AND expires_at=?',key,time+172800).run()
}
async function retireImage(media:D1Database,previous:string|null){
  // A delayed activation must not clear an expiry set by a later replacement or removal.
  if(previous?.startsWith('/media/'))await statement(media,'UPDATE media SET expires_at=? WHERE id=?',now()+172801,mediaFileId(previous)).run()
}

catalog.post('/admin/settings/logo',async c=>{
  const actor=role(c,'owner'),db=c.env.DB,media=c.env.MEDIA
  const settings=await one<{logo:string|null}>(db,'SELECT logo FROM settings WHERE id=1')
  if(!settings)throw new Problem(503,'Store setup has not been completed.')
  const {key,imageUrl,time}=await stageImage(c)
  const result=await db.batch([
    statement(db,'UPDATE settings SET logo=? WHERE id=1 AND logo IS ?',imageUrl,settings.logo),
    statement(db,"INSERT INTO audit(actor,action,subject,detail,created_at) SELECT ?,'store.logo.publish','settings',?,? WHERE changes()=1",actor.id,imageUrl,time),
  ])
  if(!result[0].meta.changes)throw new Problem(409,'The logo changed. Refresh before replacing it.')
  await activateImage(media,key,time)
  await retireImage(media,settings.logo)
  return c.json({logo:imageUrl})
})
catalog.delete('/admin/settings/logo',async c=>{
  const actor=role(c,'owner'),db=c.env.DB,time=now()
  const settings=await one<{logo:string|null}>(db,'SELECT logo FROM settings WHERE id=1')
  if(!settings?.logo)return c.json({logo:null})
  const result=await db.batch([
    statement(db,'UPDATE settings SET logo=NULL WHERE id=1 AND logo=?',settings.logo),
    statement(db,"INSERT INTO audit(actor,action,subject,created_at) SELECT ?,'store.logo.remove','settings',? WHERE changes()=1",actor.id,time),
  ])
  if(!result[0].meta.changes)throw new Problem(409,'The logo changed. Refresh before removing it.')
  await retireImage(c.env.MEDIA,settings.logo)
  return c.json({logo:null})
})

catalog.post('/admin/products/:id/image',async c=>{
  const actor=role(c,'owner','staff'), db=c.env.DB, media=c.env.MEDIA
  const productId=c.req.param('id')
  const product=await one<{image:string|null}>(db,'SELECT image FROM products WHERE id=?',productId)
  if(!product) throw new Problem(404,'Product not found.')
  const {key,imageUrl,time}=await stageImage(c)
  const result=await db.batch([
    statement(db,'UPDATE products SET image=?,updated_at=? WHERE id=? AND image IS ?',imageUrl,time,productId,product.image),
    statement(db,`INSERT INTO media_jobs(id,product_id,action,status,previous_url,image_url,created_at)
      SELECT ?,?,'publish','published',?,?,? WHERE changes()=1`,id(),productId,product.image,imageUrl,time),
    statement(db,"INSERT INTO audit(actor,action,subject,detail,created_at) SELECT ?,'media.publish',?,?,? WHERE changes()=1",actor.id,productId,imageUrl,time),
  ])
  if(!result[0].meta.changes) throw new Problem(409,'The image changed. Refresh before replacing it.')
  await activateImage(media,key,time)
  await retireImage(media,product.image)
  return c.json({image:imageUrl,status:'published'})
})
catalog.delete('/admin/products/:id/image',async c=>{
  const actor=role(c,'owner','staff'), db=c.env.DB
  const productId=c.req.param('id'), time=now()
  const p=await one<{image:string|null}>(db,'SELECT image FROM products WHERE id=?',productId)
  if(!p) throw new Problem(404,'Product not found.')
  if(!p.image)return c.json({ok:true})
  const result=await db.batch([
    statement(db,'UPDATE products SET image=NULL,updated_at=? WHERE id=? AND image IS ?',time,productId,p.image),
    statement(db,`INSERT INTO media_jobs(id,product_id,action,status,previous_url,created_at)
      SELECT ?,?,'remove','published',?,? WHERE changes()=1`,id(),productId,p.image,time),
    statement(db,"INSERT INTO audit(actor,action,subject,created_at) SELECT ?,'media.remove',?,? WHERE changes()=1",actor.id,productId,time),
  ])
  if(!result[0].meta.changes) throw new Problem(409,'The image changed.')
  await retireImage(c.env.MEDIA,p.image)
  return c.json({ok:true})
})
