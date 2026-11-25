import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, open, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const [mode, input, output] = process.argv.slice(2)
if (!['encrypt','decrypt'].includes(mode) || !input || !output || resolve(input) === resolve(output)) {
  throw new Error('Usage: merchant-backup.mjs encrypt|decrypt INPUT OUTPUT. Read the passphrase from stdin.')
}
let passphrase = ''
for await (const chunk of process.stdin) {
  passphrase += chunk.toString()
  if(passphrase.length>1024) throw new Error('Passphrase is too long.')
}
passphrase = passphrase.replace(/\r?\n$/, '')
if (passphrase.length < 16) throw new Error('Use a merchant-held passphrase of at least 16 characters.')

const prefix=Buffer.from('KIRANA01')
const headerBytes=prefix.length+16+12
const temporary=output+'.'+randomBytes(8).toString('hex')+'.tmp'
const derive=(salt)=>promisify(scrypt)(passphrase,salt,32,{N:32768,maxmem:96*1024*1024})
try {
  if (mode==='encrypt') {
    const header=Buffer.concat([prefix,randomBytes(16),randomBytes(12)])
    const key=await derive(header.subarray(prefix.length,prefix.length+16))
    const cipher=createCipheriv('aes-256-gcm',key,header.subarray(prefix.length+16))
    cipher.setAAD(header)
    const handle=await open(temporary,'wx',0o600)
    try{
      await handle.write(header)
      await pipeline(createReadStream(input),cipher,createWriteStream(temporary,{fd:handle.fd,autoClose:false,start:headerBytes}))
      const {size}=await handle.stat()
      await handle.write(cipher.getAuthTag(),0,16,size)
      await handle.sync()
    }finally{await handle.close()}
  } else {
    const handle=await open(input,'r')
    let header,tag,size
    try {
      size=(await handle.stat()).size
      if(size<headerBytes+16)throw new Error('Archive is truncated.')
      header=Buffer.alloc(headerBytes);tag=Buffer.alloc(16)
      if((await handle.read(header,0,header.length,0)).bytesRead!==header.length || !header.subarray(0,prefix.length).equals(prefix)) throw new Error('Unknown archive format.')
      if((await handle.read(tag,0,16,size-16)).bytesRead!==16)throw new Error('Archive is truncated.')
    }finally{await handle.close()}
    const key=await derive(header.subarray(prefix.length,prefix.length+16))
    const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(prefix.length+16))
    decipher.setAAD(header)
    decipher.setAuthTag(tag)
    if(size===headerBytes+16) {
      decipher.final()
      const empty=await open(temporary,'wx',0o600)
      await empty.close()
    } else {
      await pipeline(createReadStream(input,{start:headerBytes,end:size-17}),decipher,createWriteStream(temporary,{flags:'wx',mode:0o600}))
    }
  }
  // Link atomically and fail if the destination already exists.
  await link(temporary,output)
} finally {
  await rm(temporary,{force:true})
}
