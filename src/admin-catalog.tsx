import { useEffect,useRef,useState } from 'react'
import type { FormEvent } from 'react'
import { Archive,Boxes,FileDown,ImagePlus,PackagePlus,Plus,Search,Trash2,Upload } from 'lucide-react'
import { api,downloadCsv,message,pack,readCsv,rupee,send,productImage } from './lib'
import type { Category,Product } from './lib'
import { Empty,ErrorText,Heading,Sheet,Success } from './ui'

type Draft=Partial<Product>&{id?:string}
const draftInitial=(category:string):Draft=>({sku:'',name:'',brand:'',description:'',category,subcategory:'',unit:'pc',step:1,price:0,mrp:0,stock:0,threshold:0,min_steps:1,max_steps:20,tax_bps:0,hsn:'',active:1,featured:0,expiry:null})
export function AdminCatalog({owner}:{owner:boolean}){
  const [data,setData]=useState<Product[]>([]),[categories,setCategories]=useState<Category[]>([])
  const [search,setSearch]=useState(''),[after,setAfter]=useState<string|null>(null)
  const [stockFilter,setStockFilter]=useState('')
  const [draft,setDraft]=useState<Draft|null>(null),[stock,setStock]=useState<Product|null>(null)
  const [categoryForm,setCategoryForm]=useState(false),[categoryId,setCategoryId]=useState(''),[categoryName,setCategoryName]=useState('')
  const [error,setError]=useState(''),[ok,setOk]=useState(''),[busy,setBusy]=useState(false)
  const load=async(cursor?:string,signal?:AbortSignal)=>{
    try{
      const q=new URLSearchParams({q:search,...(stockFilter?{stock:stockFilter}:{}),...(cursor?{after:cursor}:{})})
      const result=await api<{products:Product[];next:string|null}>('/admin/products?'+q,{signal})
      if(!signal?.aborted){setData(previous=>cursor?[...previous,...result.products]:result.products);setAfter(result.next)}
    }catch(e){if(!signal?.aborted)setError(message(e))}
  }
  useEffect(()=>{api<Category[]>('/categories').then(setCategories,e=>setError(message(e)))},[])
  useEffect(()=>{const controller=new AbortController();const t=setTimeout(()=>void load(undefined,controller.signal),200);return()=>{clearTimeout(t);controller.abort()}},[search,stockFilter])
  const act=async(task:()=>Promise<unknown>,hint:string)=>{
    setBusy(true);setError('');setOk('')
    try {await task();setOk(hint);await load()}catch(e){setError(message(e))}finally{setBusy(false)}
  }
  return <section className="stack catalog-workspace">
    <Heading title="Catalog & inventory" detail="One inventory for online orders and the counter." action={<button className="button primary" onClick={()=>setDraft(draftInitial(categories[0]?.id||''))}><Plus size={17}/> Add product</button>}/>
    <div className="toolbar"><label className="search-box compact-search"><Search size={18}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search product or SKU" aria-label="Search products"/></label>
      <select aria-label="Filter by stock level" value={stockFilter} onChange={e=>setStockFilter(e.target.value)}><option value="">All stock levels</option><option value="low">Low stock</option><option value="out">Out of stock</option></select>
      <button className="button secondary" disabled={busy} onClick={()=>downloadCsv(data,'kirana-catalog-page.csv')}><FileDown size={16}/> Export displayed</button>
      {owner&&<><label className={'button secondary file-button '+(busy?'disabled':'')}><Upload size={16}/> Import CSV <input type="file" accept=".csv,text/csv" disabled={busy} onChange={e=>{
        const file=e.target.files?.[0];e.target.value=''
        if(!file)return
        void act(async()=>{
          if(file.size>60000)throw new Error('Import a CSV under 60 KB, up to 25 rows at a time.')
          const entries=readCsv(await file.text()).map(r=>({
            ...r,category:categories.find(c=>c.id===r.category||c.label.toLowerCase()===r.category?.toLowerCase())?.id??r.category,
            step:Number(r.step||1),price:Number(r.price),mrp:Number(r.mrp||r.price),stock:Number(r.stock||0),
            threshold:Number(r.threshold||0),min_steps:Number(r.min_steps||1),max_steps:Number(r.max_steps||20),tax_bps:Number(r.tax_bps||0),
            active:r.active==='0'?0:1,featured:r.featured==='1'?1:0,
          }))
          await send('/admin/products/import',{products:entries})
        },'CSV imported.')
      }}/></label><button className="button secondary" onClick={()=>{setCategoryId('');setCategoryName('');setCategoryForm(true)}}>Manage categories</button></>}
    </div>
    <ErrorText text={error}/><Success text={ok}/>
    <div className="panel table-scroll catalog-table">{data.length?<table><thead><tr><th>Product</th><th>Price</th><th>Stock</th><th>Expiry</th><th>Actions</th></tr></thead><tbody>
      {data.map(p=><tr key={p.id}><td><div className="table-product"><span>{p.image?<img src={p.image} alt="" loading="lazy"/>:<Boxes size={20}/>}</span><div><strong>{p.name}</strong><small>{p.sku} · {pack(p.unit,p.step)}{p.active?'':' · Archived'}</small></div></div></td>
      <td><small className="catalog-mobile-label" aria-hidden="true">Price</small>{rupee(p.price)}</td><td><small className="catalog-mobile-label" aria-hidden="true">Stock</small><span className={p.stock<=p.threshold?'low-stock':''}>{p.stock} {p.unit}</span></td><td><small className="catalog-mobile-label" aria-hidden="true">Expiry</small>{p.expiry||'—'}</td>
      <td><div className="actions"><button className="button secondary small" aria-label={'Edit '+p.name} onClick={()=>setDraft(p)}>Edit</button><button className="button secondary small" aria-label={'Stock for '+p.name} onClick={()=>setStock(p)}>Stock</button></div></td></tr>)}
    </tbody></table>:<Empty title="No products" detail="Try a different search or add a new product."/>}</div>
    {after&&<button className="button secondary align-start" onClick={()=>void load(after)}>Load more products</button>}
    {categoryForm&&<Sheet title="Manage categories" onClose={()=>setCategoryForm(false)}><form className="stack" onSubmit={async e=>{
      e.preventDefault();setBusy(true);setError('');setOk('')
      const label=categoryName.trim()
      try{
        if(categoryId){
          await send('/admin/categories/'+categoryId,{label},'PUT')
          setCategories(rows=>rows.map(row=>row.id===categoryId?{...row,label}:row))
        }else{
          const category=await send<Category>('/admin/categories',{label})
          setCategories(rows=>[...rows,category])
        }
        setCategoryForm(false);setOk(categoryId?'Category renamed.':'Category added.')
      }catch(e){setError(message(e))}finally{setBusy(false)}
    }}>
      <ErrorText text={error}/>
      <label>Category<select value={categoryId} onChange={e=>{const id=e.target.value;setCategoryId(id);setCategoryName(categories.find(row=>row.id===id)?.label??'')}}>
        <option value="">Add a new category</option>{categories.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}
      </select></label>
      <label>Category name<input value={categoryName} onChange={e=>setCategoryName(e.target.value)} required maxLength={60}/></label>
      <button className="button primary" disabled={busy}>{categoryId?'Rename category':'Add category'}</button>
    </form></Sheet>}
    {draft&&<ProductForm product={draft} categories={categories} canArchive={owner} close={()=>setDraft(null)} saved={hint=>{setDraft(null);setOk(hint);void load()}}/>}
    {stock&&<StockForm product={stock} close={()=>setStock(null)} saved={()=>{setStock(null);setOk('Stock movement recorded.');void load()}}/>}
  </section>
}

function ProductForm({product,categories,canArchive,close,saved}:{product:Draft;categories:Category[];canArchive:boolean;close:()=>void;saved:(hint:string)=>void}){
  const [value,setValue]=useState(product),[file,setFile]=useState<File|null>(null),[remove,setRemove]=useState(false)
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmArchive,setConfirmArchive]=useState(false)
  const savedDetails=useRef<string|undefined>(undefined)
  const change=(key:keyof Product, val:unknown)=>setValue(v=>({...v,[key]:val}))
  const submit=async(e:FormEvent)=>{
    e.preventDefault();setBusy(true);setError('')
    let savingPhoto=false
    try{
      const image=file?await productImage(file):null
      const {id,...details}=value
      let productId=id
      const fields={...details,mrp:details.mrp||details.price}
      const submittedDetails=JSON.stringify(fields)
      if(!productId){
        const created=await send<{id:string}>('/admin/products',fields)
        productId=created.id;setValue(d=>({...d,id:created.id}))
      }else if(savedDetails.current!==submittedDetails){
        await send('/admin/products/'+productId,fields,'PUT')
      }
      savedDetails.current=submittedDetails
      savingPhoto=Boolean(image)||remove
      if(image)await api('/admin/products/'+productId+'/image',{method:'POST',headers:{'Content-Type':image.type},body:image})
      else if(remove)await api('/admin/products/'+productId+'/image',{method:'DELETE'})
      saved('Product saved.')
    }catch(e){
      setError(savingPhoto?'Product details were saved. The photo could not be updated. '+message(e):message(e))
    }finally{setBusy(false)}
  }
  const text=(key:keyof Product,label:string,required=false,maxLength=120)=><label>{label}<input value={String(value[key]??'')} onChange={e=>change(key,e.target.value)} maxLength={maxLength} required={required}/></label>
  const num=(key:keyof Product,label:string,min=0,money=false)=><label>{label}<input type="number" min={min} step={money?'0.01':'1'} value={Number(value[key]??0)/(money?100:1)} onChange={e=>change(key,Math.round(Number(e.target.value)*(money?100:1)))} required/></label>
  return <Sheet title={value.id?'Edit product':'Add product'} onClose={close} wide>
    <ErrorText text={error}/><form className="stack" onSubmit={submit}>
      <div className="form-grid">
        {text('name','Product name',true)}{text('sku','SKU',true,40)}
        <label>Category<select required value={value.category??''} onChange={e=>change('category',e.target.value)}><option value="">Select a category</option>{categories.map(c=><option value={c.id} key={c.id}>{c.label}</option>)}</select></label>
        <label>Base unit<select value={value.unit??'pc'} onChange={e=>change('unit',e.target.value)}><option value="pc">Pieces</option><option value="g">Grams</option><option value="ml">Millilitres</option></select></label>
        {num('step','Units per pack',1)}{num('price','Selling price (₹)',0.01,true)}
        {!value.id&&num('stock','Opening stock (base units)')}
      </div>
      <details className="product-options"><summary>More product options</summary><div className="form-grid">
        {text('brand','Brand')}{text('subcategory','Subcategory',false,70)}{num('mrp','MRP (₹) · 0 uses selling price',0,true)}
        <label>Variant group<input value={value.variant_group??''} onChange={e=>change('variant_group',e.target.value)} maxLength={60}/><small>Use the same group on each pack or variant. Each SKU keeps its own price and stock.</small></label>
        {num('threshold','Low-stock warning')}{num('min_steps','Minimum packs',1)}{num('max_steps','Maximum packs',1)}
        {num('tax_bps','GST (%)',0,true)}{text('hsn','HSN',false,12)}
        <label>Expiry date<input type="date" value={value.expiry??''} onChange={e=>change('expiry',e.target.value||null)}/></label>
        <label className="span-full">Description<textarea value={value.description??''} maxLength={750} onChange={e=>change('description',e.target.value)}/></label>
      </div></details>
      <div className="actions">
        <label className="check-label"><input type="checkbox" checked={Boolean(value.active)} onChange={e=>change('active',Number(e.target.checked))}/><Archive size={15}/> On storefront</label>
        <label className="check-label"><input type="checkbox" checked={Boolean(value.featured)} onChange={e=>change('featured',Number(e.target.checked))}/> Featured</label>
      </div>
      <div className="media-form">
        {value.image&&!remove&&<img src={value.image} alt="Current product"/>}
        <label className="button secondary file-button"><ImagePlus size={16}/> {file?file.name:'Choose image'}<input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={e=>{setFile(e.target.files?.[0]??null);setRemove(false)}}/></label>
        {(value.image||file)&&<button type="button" className="button secondary" onClick={()=>{setRemove(true);setFile(null)}}><Trash2 size={15}/> Remove image</button>}
      </div>
      <div className="actions"><button className="button primary" disabled={busy}>{busy?'Saving…':'Save product'}</button><button type="button" className="button secondary" onClick={close}>Cancel</button></div>
      {canArchive&&value.id&&Boolean(product.active)&&<div className="stack">
        {confirmArchive&&<p className="muted">Remove this product from sale? Its inventory records and order history will be retained.</p>}
        <button type="button" className="button secondary align-start" disabled={busy} onClick={async()=>{
          if(!confirmArchive){setConfirmArchive(true);return}
          setBusy(true);setError('')
          try{await api('/admin/products/'+value.id,{method:'DELETE'});saved('Product archived.')}
          catch(e){setError(message(e))}finally{setBusy(false)}
        }}><Archive size={15}/> {confirmArchive?'Confirm archive':'Archive product'}</button>
      </div>}
    </form>
  </Sheet>
}

function StockForm({product,close,saved}:{product:Product;close:()=>void;saved:()=>void}){
  const [summary,setSummary]=useState<{available:number;reserved:number;events:{id:number;quantity:number;reason:string}[]} | null>(null)
  const [error,setError]=useState(''),[busy,setBusy]=useState(false)
  useEffect(()=>{api<NonNullable<typeof summary>>('/admin/products/'+product.id+'/stock?summary=1').then(setSummary,e=>setError(message(e)))},[product.id])
  const entries=summary?.events??[]
  return <Sheet title={'Stock · '+product.name} onClose={close}><div className="stack">
    <div className="info-box stack compact"><span>Available to sell · {summary?.available??product.stock} {product.unit}</span>
      {summary&&<span>Reserved for open orders · {summary.reserved} {product.unit}</span>}
    </div><ErrorText text={error}/>
    <form className="stack" onSubmit={async e=>{
      e.preventDefault();setBusy(true);setError('')
      const data=new FormData(e.currentTarget)
      try{await send('/admin/products/'+product.id+'/stock',{quantity:Number(data.get('quantity')),reason:data.get('reason')});saved()}
      catch(e){setError(message(e))}finally{setBusy(false)}
    }}>
      <label>Movement type<select name="reason"><option value="receipt">Stock receipt (+)</option><option value="adjustment">Manual adjustment (+/−)</option><option value="damaged">Damaged (−)</option><option value="expired">Expired (−)</option><option value="return">Return to stock (+)</option></select></label>
      <label>Change in {product.unit}<input name="quantity" type="number" required placeholder="+ or − quantity"/></label><button className="button primary" disabled={busy}><PackagePlus size={17}/> Record movement</button>
    </form>
    <h3>Recent stock movement</h3>{entries.length?entries.map(x=><div className="summary-line" key={x.id}><span>{x.reason.replaceAll('_',' ')}</span><b>{x.quantity>0?'+':''}{x.quantity} {product.unit}</b></div>):<p className="muted">No recorded movement.</p>}
  </div></Sheet>
}
