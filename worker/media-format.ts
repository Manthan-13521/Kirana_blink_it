export const mediaFileId=(path:string)=>path.slice(7).replace(/\.jpg$/,'')
export const jpegMime='image/jpeg'
export const webpMime='image/webp'

function jpegDimensions(view:DataView){
  if(view.getUint16(0)!==0xffd8||view.getUint16(view.byteLength-2)!==0xffd9)return null
  let offset=2
  while(offset+9<=view.byteLength){
    if(view.getUint8(offset++)!==0xff)return null
    while(offset<view.byteLength&&view.getUint8(offset)===0xff)offset++
    if(offset+7>=view.byteLength)return null
    const marker=view.getUint8(offset++)
    if(marker===0xda||marker===0xd9)return null
    const length=view.getUint16(offset)
    if(length<2||offset+length>view.byteLength)return null
    if([0xc0,0xc1,0xc2].includes(marker)&&length>=8)return [view.getUint16(offset+5),view.getUint16(offset+3)]
    offset+=length
  }
  return null
}
function webpDimensions(view:DataView){
  if(view.getUint32(0)!==0x52494646||view.getUint32(8)!==0x57454250||view.getUint32(4,true)+8!==view.byteLength)return null
  const kind=view.getUint32(12)
  if(kind===0x56503820&&view.byteLength>=30&&view.getUint16(23)===0x9d01&&view.getUint8(25)===0x2a){
    return [view.getUint16(26,true)&0x3fff,view.getUint16(28,true)&0x3fff]
  }
  if(kind===0x5650384c&&view.getUint8(20)===0x2f){
    const bits=view.getUint32(21,true)
    return [(bits&0x3fff)+1,((bits>>>14)&0x3fff)+1]
  }
  if(kind===0x56503858&&view.byteLength>=30&&(view.getUint8(20)&2)===0){
    const dimension=(offset:number)=>1+view.getUint8(offset)+256*view.getUint8(offset+1)+65536*view.getUint8(offset+2)
    return [dimension(24),dimension(27)]
  }
  return null
}
export function validMedia(data:ArrayBuffer,mime:string){
  if(data.byteLength<25||data.byteLength>32768)return false
  const view=new DataView(data)
  const dimensions=mime===webpMime?webpDimensions(view):mime===jpegMime?jpegDimensions(view):null
  return Boolean(dimensions?.every(size=>size>=1&&size<=512))
}
