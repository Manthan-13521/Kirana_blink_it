import type { Account,Address,Product,Shop } from '../worker/shared'
export type { Account,Address,Product,Shop }
export type Category = {id:string; label:string; image:string|null}
export type Slot={start:number;end:number;remaining:number}
export type CartLine={product:Product;steps:number}
export type Quote={version:string;subtotal:number;fees:number;tax:number;total:number}
export type OrderRow={
  id:string;status:string;channel:string;fulfillment:string;payment_method:string;payment_status:string
  subtotal:number;fees:number;tax:number;total:number;slot_start:number|null;slot_end:number|null
  created_at:number;updated_at:number;assigned_to:string|null;route_rank:number;address_json?:string|null;reconciled:number;note:string
}
export type OrderItem={product_id:string;sku:string;name:string;unit:string;quantity:number;step:number;price:number;line_total:number;tax:number;tax_bps:number;hsn:string;image:string|null}
export type OrderCase={id:string;kind:string;status:string;reason:string;response:string;created_at:number;order_id:string;total:number;payment_status:string}
export type OrderDetail=OrderRow&{
  address:Address|null;invoice:{name:string;address:string;phone:string;gstin:string;registered:number;buyer:string}|null
  items:OrderItem[];events:{status:string;created_at:number;note:string}[];cases:OrderCase[];refunds:{amount:number;created_at:number}[];trackingVersion?:string;refundPending?:boolean;refundFailed?:boolean;paymentFailed?:boolean;canReconcilePayment?:boolean;liveRefunds?:{id:string;amount:number;status:string}[]
}
export class ApiError extends Error { constructor(public status:number,message:string,public code?:string){super(message)} }
export async function api<T>(path:string,options?:RequestInit):Promise<T>{
  const response=await fetch('/api'+path,options).catch(error=>{
    if(error instanceof TypeError)throw new Error('Connection unavailable. Check your network and try again.')
    throw error
  })
  const body=await response.json().catch(error=>{
    if(error instanceof SyntaxError)return null
    throw error
  }) as (T&{error?:string;code?:string})|null
  if(!response.ok) throw new ApiError(response.status,body?.error??(response.status===429?'The store is busy. Try again in a moment.':'Request failed. Try again.'),body?.code)
  if(body===null)throw new ApiError(response.status,'The server returned an unexpected response.')
  return body
}
export function send<T>(path:string,data:unknown={},method='POST'){
  return api<T>(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
}
type CheckoutDraft={key:string;quote:Quote}
export async function checkoutDraftKey(scope:string,payload:string) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(scope+'\n'+payload))
  return 'kirana-checkout-'+Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('')
}
export function readCheckoutDraft(key:string):CheckoutDraft|null {
  try{
    const record=JSON.parse(sessionStorage.getItem(key)||'null') as (CheckoutDraft&{at:number})|null
    if(record&&Date.now()-record.at<86400000&&record.key&&record.quote?.version)return record
    sessionStorage.removeItem(key)
  }catch{/* An unavailable browser store does not grant order access. */}
  return null
}
export function saveCheckoutDraft(key:string,record:CheckoutDraft) {
  sessionStorage.setItem(key,JSON.stringify({...record,at:Date.now()}))
}
export const rupee=(value:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:value%100?2:0,minimumFractionDigits:0}).format(value/100)
export const pretty=(value:string)=>value.split('_').join(' ').replace(/^./,c=>c.toUpperCase())
const timeFormat=new Intl.DateTimeFormat('en-IN',{hour:'numeric',minute:'2-digit',timeZone:'Asia/Kolkata'})
const dateFormat=new Intl.DateTimeFormat('en-IN',{weekday:'short',day:'numeric',month:'short',timeZone:'Asia/Kolkata'})
export const date=(time:number)=>dateFormat.format(time*1000)
export const clock=(time:number)=>timeFormat.format(time*1000)
const timestampFormat=new Intl.DateTimeFormat('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'})
export const timestamp=(time:number)=>timestampFormat.format(time*1000)
export const windowLabel=(start:number,end:number)=>`${date(start)} · ${clock(start)}–${clock(end)}`
export const displayOrder=(value:string)=>'#'+value.slice(0,8).toUpperCase()
export const message=(error:unknown)=>error instanceof Error?error.message:'Something went wrong.'
export function pack(unit:string,step:number){
  if(unit==='g'&&step>=1000)return (step/1000)+' kg'
  if(unit==='ml'&&step>=1000)return (step/1000)+' L'
  return step+' '+(unit==='pc'?(step===1?'pc':'pcs'):unit)
}
export const dateInput=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'})

export async function invoice(order:OrderDetail,local=false){
  if(!order.invoice) throw new Error('Invoice unavailable.')
  const {jsPDF}=await import('jspdf')
  const doc=new jsPDF()
  const {name,address,phone,gstin,registered,buyer}=order.invoice
  const currency=(n:number)=>'INR '+(n/100).toFixed(2)
  doc.setFontSize(22);doc.text(name,14,20)
  doc.setFontSize(10);doc.text(address,14,29,{maxWidth:180})
  doc.text(phone+(gstin?' · GSTIN '+gstin:''),14,37)
  doc.setFontSize(15);doc.text((registered?'Tax invoice':'Order bill')+(local?' (local demonstration)':''),14,49)
  doc.setFontSize(10);doc.text('Reference: '+order.id,14,59)
  doc.text('Date: '+timestamp(order.created_at)+'   Customer: '+buyer,14,66)
  doc.text('Fulfillment: '+pretty(order.fulfillment)+'   Payment: '+pretty(order.payment_status),14,73)
  if(order.address) doc.text('Delivery: '+order.address.line1+', '+order.address.locality+', '+order.address.pin,14,80,{maxWidth:180})
  let y=92
  for(const row of order.items){
    if(y>260){doc.addPage();y=20}
    const itemLabel=doc.splitTextToSize(row.name+' · '+pack(row.unit,row.step)+' × '+row.quantity/row.step+
      ' · '+currency(row.price)+' per pack'+(row.hsn?' · HSN '+row.hsn:''),132)
    doc.text(itemLabel,14,y);doc.text(currency(row.line_total),196,y,{align:'right'})
    y+=Math.max(8,itemLabel.length*5+3)
  }
  if(y>245){doc.addPage();y=20}
  doc.line(14,y,196,y);y+=8
  doc.text('Subtotal: '+currency(order.subtotal),196,y,{align:'right'});y+=7
  doc.text('Delivery: '+currency(order.fees),196,y,{align:'right'});y+=7
  if(order.tax){doc.text('Tax included: '+currency(order.tax),196,y,{align:'right'});y+=7}
  doc.setFontSize(13);doc.text('Total: '+currency(order.total),196,y,{align:'right'})
  doc.save(`kirana-${order.id.slice(0,8)}.pdf`)
}

export function downloadCsv(rows:Record<string,unknown>[],name:string){
  if(!rows.length)return
  const keys=Object.keys(rows[0])
  const escape=(text:unknown)=>{
    let v=String(text??'')
    if(/^[\s]*[=+\-@]/.test(v))v="'"+v
    return '"'+v.replaceAll('"','""')+'"'
  }
  const body=[keys.map(escape).join(','),...rows.map(row=>keys.map(k=>escape(row[k])).join(','))].join('\r\n')
  const url=URL.createObjectURL(new Blob([body],{type:'text/csv;charset=utf-8'}))
  const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),500)
}
export function readCsv(text:string){
  const result:string[][]=[];let row:string[]=[],field='',quoted=false
  for(let i=0;i<text.length;i++){
    const char=text[i]
    if(char==='"'){
      if(quoted&&text[i+1]==='"'){field+='"';i++}else quoted=!quoted
    } else if(char===','&&!quoted){row.push(field.trim());field=''}
    else if(char==='\n'&&!quoted){row.push(field.trim());if(row.some(Boolean))result.push(row);row=[];field=''}
    else if(char!=='\r'||quoted)field+=char
  }
  if(quoted)throw new Error('An imported CSV quote is not closed.')
  row.push(field.trim());if(row.some(Boolean))result.push(row)
  const [keys,...values]=result
  if(!keys?.length||!values.length)throw new Error('The CSV is empty.')
  return values.map(r=>Object.fromEntries(keys.map((k,i)=>[k,r[i]??''])))
}
export async function productImage(input:File){
  if(input.size>10*1024*1024||!['image/jpeg','image/png','image/webp','image/avif'].includes(input.type)) throw new Error('Choose a JPEG, PNG, AVIF or WebP image under 10 MB.')
  const image=await createImageBitmap(input)
  try {
    const canvas=document.createElement('canvas')
    for(const size of [480,360,260,180,128]){
      const ratio=Math.min(1,size/Math.max(image.width,image.height))
      canvas.width=Math.max(1,Math.round(image.width*ratio));canvas.height=Math.max(1,Math.round(image.height*ratio))
      const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Image processing is unavailable.')
      ctx.drawImage(image,0,0,canvas.width,canvas.height)
      const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/webp',0.8))
      if(blob?.type==='image/webp'&&blob.size<=32768)return blob
      if(blob?.type!=='image/webp'){
        const jpeg=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',0.8))
        if(jpeg?.type==='image/jpeg'&&jpeg.size<=32768)return jpeg
      }
    }
    throw new Error('The image could not be compressed below 32 KiB.')
  } finally {image.close()}
}
