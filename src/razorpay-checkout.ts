export type PaymentChallenge={key:string;orderId:string;amount:number;currency:'INR';mode:'test'|'live'}
export type PaymentProof={razorpay_payment_id:string;razorpay_order_id:string;razorpay_signature:string}
const upiOnly={
  display:{
    blocks:{upi:{name:'Pay via UPI',instruments:[{method:'upi'}]}},
    sequence:['block.upi'],
    preferences:{show_default_blocks:false},
  },
}
export function checkoutDisplay(mode:PaymentChallenge['mode']){
  return mode==='live'?upiOnly:undefined
}
type CheckoutOptions={
  key:string;order_id:string;amount:number;currency:string;name:string;description:string;config?:typeof upiOnly
  handler:(proof:PaymentProof)=>void;modal:{ondismiss:()=>void}
}
type RazorpayConstructor=new (options:CheckoutOptions)=>{open:()=>void}
let loading:Promise<RazorpayConstructor>|undefined
export function loadCheckout(){
  const browser=window as Window&{Razorpay?:RazorpayConstructor}
  if(browser.Razorpay)return Promise.resolve(browser.Razorpay)
  if(!loading){
    loading=new Promise<RazorpayConstructor>((resolve,reject)=>{
      const script=document.createElement('script')
      const failed=()=>{
        window.clearTimeout(timeout)
        script.remove()
        reject(new Error('Razorpay could not load. Try again shortly.'))
      }
      const timeout=window.setTimeout(failed,12000)
      script.src='https://checkout.razorpay.com/v1/checkout.js'
      script.async=true
      script.onerror=failed
      script.onload=()=>{
        if(!browser.Razorpay){failed();return}
        window.clearTimeout(timeout)
        resolve(browser.Razorpay)
      }
      document.head.appendChild(script)
    }).catch(error=>{loading=undefined;throw error})
  }
  return loading
}
