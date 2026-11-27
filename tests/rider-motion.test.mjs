import assert from 'node:assert/strict'
import {test} from 'node:test'
import {confirmedDeviation,emptyProgress,measureRoad,progressAlong,riderFix,roadPosition} from '../src/rider-motion.ts'

const sample=(latitude,longitude,at,options={})=>({
  latitude,longitude,at,accuracy:8,speed:null,heading:null,...options,
})
const route=()=>measureRoad([[78.422,17.4116],[78.423,17.4116],[78.423,17.4126]])

test('rider GPS rejects weak and late fixes, holds a stationary marker and derives the direction of travel',()=>{
  const start=riderFix(sample(17.4116,78.422,1000),null)
  assert.equal(start.bearing,null)
  const drift=riderFix(sample(17.41161,78.42201,2000),start)
  assert.equal(drift.latitude,start.latitude)
  assert.equal(drift.longitude,start.longitude)
  assert.equal(riderFix(sample(17.4116,78.422,3000,{accuracy:80}),drift),null)
  assert.equal(riderFix(sample(17.4116,78.422,1500),drift),null)
  const east=riderFix(sample(17.4116,78.4225,4000),drift)
  assert.equal(east.bearing,90)
  assert.equal(riderFix(sample(17.4117,78.4225,5000,{speed:3,heading:355}),east).bearing,355)
})

test('rider route confirms arrival only with a reliable nearby fix and never advances on a distant fix',()=>{
  const road=route()
  const middle=riderFix(sample(17.4116,78.4225,1000),null)
  const progress=progressAlong(road,emptyProgress,middle,3)
  assert.ok(progress.along>50&&progress.along<60)
  assert.equal(progress.arrived,false)
  const off=riderFix(sample(17.414,78.425,5000),null)
  const deviation=progressAlong(road,progress,off,4)
  assert.equal(deviation.offSince,5000)
  assert.equal(deviation.offSamples,1)
  assert.equal(deviation.along,progress.along)
  const end=riderFix(sample(17.4126,78.423,10000),null)
  const arrival=progressAlong(road,deviation,end,5)
  assert.equal(arrival.arrived,true)
  assert.equal(arrival.offSamples,0)
  assert.equal(progressAlong(road,deviation,{...end,accuracy:38},5).arrived,false)
})

test('rider geometry interpolation reaches the turn and destination along the measured line',()=>{
  const road=route()
  const turn=roadPosition(road,road[1].at)
  const end=roadPosition(road,road.at(-1).at)
  assert.equal(turn.latitude,17.4116)
  assert.equal(turn.longitude,78.423)
  assert.equal(end.latitude,17.4126)
  assert.equal(end.longitude,78.423)
})

test('rider deviation requires repeated reliable fixes over time and clears after returning to the route',()=>{
  const road=route()
  const nearby=riderFix(sample(17.4116,78.4225,1000),null)
  const onRoute=progressAlong(road,emptyProgress,nearby,3)
  const off={...nearby,latitude:17.414,longitude:78.425}
  const first=progressAlong(road,onRoute,{...off,at:2000},1)
  const second=progressAlong(road,first,{...off,at:6000},4)
  const recovered=progressAlong(road,second,{...nearby,at:9500},3.5)
  assert.equal(confirmedDeviation(first,10000),false)
  assert.equal(confirmedDeviation(second,10000),false)
  assert.equal(confirmedDeviation(progressAlong(road,second,{...off,at:8500},2.5),8500),true)
  assert.equal(confirmedDeviation(recovered,10000),false)
})
