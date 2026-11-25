import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const [output,contact]=process.argv.slice(2)
if(!output||!/^mailto:[^\s]+@[^\s]+$/.test(contact??'')){
  throw new Error('Usage: node tools/create-vapid.mjs PRIVATE_OUTPUT mailto:OWNER_EMAIL')
}
const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'})
const {x,y}=publicKey.export({format:'jwk'})
const publicValue=Buffer.concat([Buffer.of(4),Buffer.from(x,'base64url'),Buffer.from(y,'base64url')]).toString('base64url')
writeFileSync(output,JSON.stringify({VAPID_PUBLIC_KEY:publicValue,VAPID_PRIVATE_JWK:JSON.stringify(privateKey.export({format:'jwk'})),VAPID_CONTACT:contact}),{flag:'wx',mode:0o600})
console.log('Created a private Wrangler secrets file.')
