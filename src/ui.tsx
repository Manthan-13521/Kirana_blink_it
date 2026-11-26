import { useId,useLayoutEffect,useRef } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight, CircleAlert, CircleCheck, Package, ShoppingBasket, X } from 'lucide-react'
import { pretty } from './lib'

export function Mark({name='Neighbourhood Kirana'}:{name?:string}){
  return <span className="wordmark"><span className="logo-mark"><ShoppingBasket size={23} strokeWidth={2.4}/></span><span>{name}</span></span>
}
export function Sheet({title,children,onClose,wide=false,suspended=false}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean;suspended?:boolean}){
  const dialog=useRef<HTMLDialogElement>(null)
  const titleId=useId()
  useLayoutEffect(()=>{const node=dialog.current;if(!suspended&&!node?.open)node?.showModal();return()=>node?.close()},[suspended])
  return <dialog ref={dialog} aria-labelledby={titleId} className={'sheet '+(wide?'sheet-wide':'')} onCancel={e=>{e.preventDefault();onClose()}} onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
    <header className="sheet-header"><h2 id={titleId}>{title}</h2><button className="icon-button" type="button" aria-label="Close" onClick={onClose}><X size={21}/></button></header>
    <div className="sheet-body">{children}</div>
  </dialog>
}
export function Empty({title,detail,action}:{title:string;detail?:string;action?:ReactNode}){
  return <div className="empty"><div className="empty-icon"><Package size={28}/></div><h3>{title}</h3>{detail&&<p>{detail}</p>}{action}</div>
}
export function ErrorText({text}:{text:string}){return text?<div className="alert" role="alert"><CircleAlert size={17}/><span>{text}</span></div>:null}
export function Success({text}:{text:string}){return text?<div className="notice" role="status"><CircleCheck size={17}/><span>{text}</span></div>:null}
export function Status({value}:{value:string}){return <span className={'status status-'+value}>{pretty(value)}</span>}
export function Heading({title,detail,action}:{title:string;detail?:string;action?:ReactNode}){
  return <div className="heading"><div><h2>{title}</h2>{detail&&<p>{detail}</p>}</div>{action}</div>
}
export function TextArrow({children,click}:{children:ReactNode;click:()=>void}){
  return <button type="button" className="text-arrow" onClick={click}>{children}<ChevronRight size={15}/></button>
}
