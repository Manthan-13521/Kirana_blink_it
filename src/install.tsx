import { useEffect,useState } from 'react'

type BrowserInstallEvent=Event&{prompt:()=>Promise<void>;userChoice:Promise<{outcome:'accepted'|'dismissed'}>}
let availablePrompt:BrowserInstallEvent|null=null
window.addEventListener('beforeinstallprompt',event=>{availablePrompt=event as BrowserInstallEvent})
export function InstallStore(){
  const [prompt,setPrompt]=useState<BrowserInstallEvent|null>(availablePrompt)
  const [installed,setInstalled]=useState(()=>window.matchMedia('(display-mode: standalone)').matches||
    Boolean((navigator as Navigator&{standalone?:boolean}).standalone))
  const [guide,setGuide]=useState(false)
  useEffect(()=>{
    const available=(event:Event)=>{
      event.preventDefault()
      setPrompt(event as BrowserInstallEvent)
    }
    const done=()=>setInstalled(true)
    window.addEventListener('beforeinstallprompt',available)
    window.addEventListener('appinstalled',done)
    return()=>{
      window.removeEventListener('beforeinstallprompt',available)
      window.removeEventListener('appinstalled',done)
    }
  },[])
  if(installed)return null
  return <div className="stack compact">
    <button className="button secondary align-start" onClick={async()=>{
      if(!prompt){setGuide(!guide);return}
      try{
        await prompt.prompt()
        setInstalled((await prompt.userChoice).outcome==='accepted')
      }catch{setGuide(true)}finally{availablePrompt=null;setPrompt(null)}
    }}>Install store app</button>
    {guide&&<p className="muted">On iPhone, open Safari’s Share menu and select Add to Home Screen. In Android Chrome, use the browser menu and select Install app or Add to Home screen.</p>}
  </div>
}
