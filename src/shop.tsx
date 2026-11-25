import { useEffect,useMemo,useRef,useState } from 'react'
import { ArrowDownRight,ArrowRight,Clock3,MapPin,Minus,Plus,Search,ShoppingBasket,Sparkles } from 'lucide-react'
import { api,message,pack,rupee} from './lib'
import type { Account,CartLine,Category,Product,Shop } from './lib'
import { Empty,ErrorText,Heading,Sheet,TextArrow } from './ui'
import { Cart } from './checkout'

const shapes=['#e6eddb','#f1e5d3','#f9e7be','#f1e2d9','#e2e9e2']
function photo(product:Product){
  return product.image?<img src={product.image} alt="" width={240} height={180} loading="lazy" decoding="async"/>:<ShoppingBasket size={36}/>
}
function Quantity({count,onChange,name,disabled=false,min=1,max=100}:{count:number;onChange:(amount:number)=>void;name:string;disabled?:boolean;min?:number;max?:number}){
  return count?<div className="quantity"><button aria-label={'Remove '+name} onClick={()=>onChange(count<=min?0:count-1)}><Minus size={14}/></button><b>{count}</b><button aria-label={'Increase '+name} disabled={count>=max} onClick={()=>onChange(count+1)}><Plus size={14}/></button></div>
    :<button className="add-button" disabled={disabled} onClick={()=>onChange(min)} aria-label={(disabled?'Out of stock: ':'Add ')+name}>{disabled?'Sold out':<>Add <Plus size={15}/></>}</button>
}
export function ProductCard({product,count,change,open}:{product:Product;count:number;change:(count:number)=>void;open:()=>void}){
  const savings=product.mrp>product.price?Math.floor((product.mrp-product.price)*100/product.mrp):0
  const max=Math.min(product.max_steps,Math.floor(product.stock/product.step))
  return <article className="product-card">
    <button type="button" className="product-photo" onClick={open} aria-label={'View '+product.name}>{photo(product)}{savings>0&&<span className="sale-tag">{savings}% off</span>}</button>
    <div className="product-info">
      <small>{pack(product.unit,product.step)}</small>
      <button type="button" className="product-name" onClick={open}>{product.name}</button>
      <div className="product-bottom"><div><strong>{rupee(product.price)}</strong>{product.mrp>product.price&&<del>{rupee(product.mrp)}</del>}</div>
      <Quantity count={count} onChange={change} name={product.name} disabled={max<product.min_steps} min={product.min_steps} max={max}/></div>
    </div>
  </article>
}
type Props={
  shop:Shop; account:Account|null; query:string; setQuery:(v:string)=>void
  cart:CartLine[]; setCart:(lines:CartLine[])=>void; cartOpen:boolean; startCheckout:boolean; openCart:(open:boolean)=>void
  requireLogin:()=>void; openOrder:(order:string)=>void; setLocation:()=>void
}
export function Storefront({shop,account,query,setQuery,cart,setCart,cartOpen,startCheckout,openCart,requireLogin,openOrder,setLocation}:Props){
  const [categories,setCategories]=useState<Category[]>([])
  const [active,setActive]=useState('')
  const [browseAll,setBrowseAll]=useState(false),[loadingMore,setLoadingMore]=useState(false)
  const [sub,setSub]=useState('')
  const [catalog,setCatalog]=useState<Product[]>([])
  const [next,setNext]=useState<string|null>(null)
  const [error,setError]=useState('')
  const [loading,setLoading]=useState(true)
  const [selected,setSelected]=useState<Product|null>(null)
  const [debounced,setDebounced]=useState(query)
  const nextRequest=useRef<AbortController|null>(null)
  useEffect(()=>{api<Category[]>('/categories').then(setCategories,e=>setError(message(e)))},[])
  useEffect(()=>{const t=setTimeout(()=>setDebounced(query),220);return()=>clearTimeout(t)},[query])
  const params=useMemo(()=>new URLSearchParams({
    ...(!debounced.trim()&&!active&&!browseAll?{featured:'1'}:{}),...(debounced.trim()?{q:debounced.trim()}:{}),...(!debounced.trim()&&active?{category:active}:{}),...(!debounced.trim()&&sub?{subcategory:sub}:{}),
  }),[debounced,active,sub,browseAll])
  useEffect(()=>{
    const signal=new AbortController()
    nextRequest.current?.abort();setLoadingMore(false)
    setLoading(true);setNext(null);setError('')
    api<{products:Product[];next:string|null}>('/catalog?'+params,{signal:signal.signal}).then(r=>{
      if(signal.signal.aborted)return
      if(!r.products.length&&params.has('featured')){setBrowseAll(true);return}
      setCatalog(r.products);setNext(r.next);setLoading(false)
    },e=>{if(!signal.signal.aborted){setError(message(e));setLoading(false)}})
    return()=>{signal.abort();nextRequest.current?.abort()}
  },[params])
  const subcategories=[...new Set(catalog.map(p=>p.subcategory).filter(Boolean))]
  const total=cart.reduce((sum,line)=>sum+line.steps*line.product.price,0)
  const count=cart.reduce((sum,line)=>sum+line.steps,0)
  const change=(product:Product,steps:number)=>{
    if(steps>0&&cart.length>=40&&!cart.some(l=>l.product.id===product.id)){setError('Your basket already has 40 different products.');return}
    const previous=cart.find(l=>l.product.id===product.id)
    setCart(steps===0?cart.filter(x=>x.product.id!==product.id):previous?cart.map(l=>l.product.id===product.id?{product,steps}:l):[...cart,{product,steps}])
  }
  const navigate=(category:string)=>{
    setQuery('');setActive(category);setSub('');setBrowseAll(!category)
    requestAnimationFrame(()=>document.getElementById('products')?.scrollIntoView({behavior:'smooth',block:'start'}))
  }
  const reset=()=>{setQuery('');setActive('');setSub('');setBrowseAll(true)}
  return <>
    {(active||query)&&<nav className="category-strip" aria-label="Categories">
      <div className="shell strip-inner">
        <button className={!active||query?'selected':''} onClick={reset}>All products</button>
        {categories.map(category=><button key={category.id} className={!query&&active===category.id?'selected':''} onClick={()=>navigate(category.id)}>{category.label}</button>)}
        <button className="service-area" onClick={setLocation}><MapPin size={15}/> Delivery & pickup</button>
      </div>
    </nav>}
    <main className="shell storefront">
      {!active&&!query&&<>
        <section className="hero" aria-label="Fresh groceries">
          <div className="hero-copy">
            <span className="hero-kicker"><Sparkles size={13}/> YOUR NEIGHBOURHOOD GROCER</span>
            <h1>Fresh groceries.<br/>Close to home.</h1>
            <p>Shop local for pickup or home delivery.</p>
            <button className="button primary hero-button" onClick={()=>navigate('fresh')}>Shop fresh <ArrowRight size={17}/></button>
          </div>
        </section>
        <section className="section-block">
          <Heading title="Shop by category"/>
          <div className="category-grid">
            {categories.map((category,i)=><button className="category-card" key={category.id} onClick={()=>navigate(category.id)} style={{background:shapes[i%shapes.length]}}><span className="category-image">{category.image?<img src={category.image} alt="" width={120} height={100}/>:<ShoppingBasket size={30}/>}</span><span>{category.label}</span><ArrowDownRight size={16} className="category-arrow"/></button>)}
          </div>
        </section>
      </>}
      <section id="products" className="section-block product-section">
        <Heading title={query?`Search results for “${query}”`:categories.find(x=>x.id===active)?.label??(browseAll?'All products':'Everyday favourites')}
          action={query||active?<TextArrow click={reset}>Clear filters</TextArrow>:browseAll?undefined:<TextArrow click={()=>navigate('')}>Shop all</TextArrow>}/>
        {active&&!query&&!sub&&subcategories.length>1&&<div className="chips">{subcategories.map(s=><button key={s} className="chip" onClick={()=>setSub(s)}>{s}</button>)}</div>}
        {sub&&!query&&<button className="chip" onClick={()=>setSub('')}>{sub} ×</button>}
        <ErrorText text={error}/>
        {loading&&!catalog.length?<div className="product-grid" aria-label="Loading products">{[0,1,2,3,4].map(i=><div className="skeleton" key={i}/>)}</div>
          :!catalog.length&&!error?<Empty title="No products found" detail="Try another product name or browse a category." action={<button className="button secondary" onClick={reset}><Search size={16}/> Browse all</button>}/>
          :<div className="product-grid">{catalog.map(p=><ProductCard key={p.id} product={p} count={cart.find(l=>l.product.id===p.id)?.steps??0} change={n=>change(p,n)} open={()=>setSelected(p)}/>)}</div>}
        {next&&<button className="button secondary load-more" disabled={loading||loadingMore} onClick={async()=>{
          const request=new AbortController()
          nextRequest.current=request;setLoadingMore(true)
          try{
            const more=new URLSearchParams(params);more.set('after',next)
            const page=await api<{products:Product[];next:string|null}>('/catalog?'+more,{signal:request.signal})
            if(!request.signal.aborted){setCatalog(prev=>[...prev,...page.products]);setNext(page.next)}
          }catch(e){if(!request.signal.aborted)setError(message(e))}
          finally{if(!request.signal.aborted)setLoadingMore(false)}
        }}>{loadingMore?'Loading…':'Load more products'}</button>}
      </section>
      <footer className="shop-footer"><strong>{shop.name}</strong><p>{shop.address} · <a href={'tel:'+shop.phone}>{shop.phone}</a></p><p><Clock3 size={14}/> Open {shop.open_hour}:00–{shop.close_hour}:00 daily</p><small>{shop.policy}</small></footer>
    </main>
    {count>0&&<button className="mobile-cart" onClick={()=>openCart(true)}><ShoppingBasket size={21}/><span>{count} {count===1?'item':'items'} · {rupee(total)}</span><b>View basket <ArrowRight size={17}/></b></button>}
    {selected&&<Sheet title={selected.name} onClose={()=>setSelected(null)}>
      <div className="detail-image">{photo(selected)}</div><p className="muted">{selected.brand} · {pack(selected.unit,selected.step)}</p>
      <p>{selected.description}</p><div className="summary-line"><strong>{rupee(selected.price)}</strong><Quantity name={selected.name} count={cart.find(l=>l.product.id===selected.id)?.steps??0} onChange={n=>change(selected,n)} min={selected.min_steps} max={Math.min(selected.max_steps,Math.floor(selected.stock/selected.step))} disabled={selected.stock<selected.step*selected.min_steps}/></div>
    </Sheet>}
    {cartOpen&&<Cart shop={shop} account={account} startAtCheckout={startCheckout} cart={cart} change={change} onClose={()=>openCart(false)} requireLogin={requireLogin} complete={oid=>{setCart([]);openCart(false);openOrder(oid)}}/>}
  </>
}
