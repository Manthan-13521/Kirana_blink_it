import assert from 'node:assert/strict'
import {test} from 'node:test'
import {groupTrips,mergeTripGroups} from '../src/rider-trips.ts'

const stop=(index,slotEnd=100,status='ready')=>({
  id:String(index),slotEnd,status,address:{latitude:17.4+index/1000,longitude:78.4},
})
for(const [count,sizes] of [[3,[3]],[5,[5]],[10,[8,2]],[20,[8,8,4]],[45,[8,8,8,8,8,5]]]){
  test(`rider groups ${count} assigned pins into complete trips of up to eight`,()=>{
    const trips=groupTrips(Array.from({length:count},(_,index)=>stop(index)))
    assert.deepEqual(trips.map(trip=>trip.length),sizes)
    assert.equal(new Set(trips.flat()).size,count)
  })
}
test('rider queues earlier delivery windows first and leaves unpinned orders for manual delivery',()=>{
  assert.deepEqual(groupTrips([
    stop(1,200),stop(2,100),stop(3,200),stop(4,100),
    {id:'no-pin',slotEnd:30,address:{latitude:null,longitude:null}},
  ]),[['2','4'],['1','3']])
})
test('sequentially assigned stops combine into one trip before navigation starts and stay separate after start',()=>{
  const firstTwo=[stop(1),stop(2)]
  const initial=mergeTripGroups([],[],firstTwo,true)
  assert.deepEqual(initial,{groups:[['1','2']],reselect:['1','2']})
  const five=[stop(1),stop(2),stop(3),stop(4),stop(5)]
  const combined=mergeTripGroups(initial.groups,initial.reselect,five,true)
  assert.deepEqual(combined,{groups:[['1','2','3','4','5']],reselect:['1','2','3','4','5']})
  const started=mergeTripGroups(combined.groups,combined.reselect,[...five,stop(6)],false)
  assert.deepEqual(started,{groups:[['1','2','3','4','5'],['6']],reselect:null})
})
