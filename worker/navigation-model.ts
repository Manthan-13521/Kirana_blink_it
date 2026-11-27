export const tripStopLimit=8
export const riderAssignmentLimit=60

export type Point={latitude:number;longitude:number}
export type RoadPoint=[longitude:number,latitude:number]
export type RoadCost={seconds:number;meters:number}
export type NavigationStep={at:number;text:string}
export type NavigationLeg=RoadCost&{ids:string[];line:RoadPoint[];steps:NavigationStep[]}
export type NavigationPlan=RoadCost&{
  provider:'Mapbox'; legs:NavigationLeg[]; origin:Point
  matrix?:{orderedSeconds:number;optimizedSeconds:number}
}

// Compare all possible endpoints for each visited set. Road costs are directed.
export function fastestTrip(matrix:RoadCost[][]){
  const count=matrix.length-1,sets=1<<count
  const scores=Array.from({length:sets},()=>Array<number>(count).fill(Infinity))
  const meters=Array.from({length:sets},()=>Array<number>(count).fill(Infinity))
  const previous=Array.from({length:sets},()=>Array<number>(count).fill(-1))
  for(let end=0;end<count;end++){
    scores[1<<end][end]=matrix[0][end+1].seconds
    meters[1<<end][end]=matrix[0][end+1].meters
  }
  for(let set=1;set<sets;set++)for(let end=0;end<count;end++){
    if(!Number.isFinite(scores[set][end]))continue
    for(let next=0;next<count;next++){
      if(set&(1<<next))continue
      const visited=set|(1<<next),cost=matrix[end+1][next+1]
      const seconds=scores[set][end]+cost.seconds,distance=meters[set][end]+cost.meters
      if(seconds>scores[visited][next]||seconds===scores[visited][next]&&distance>=meters[visited][next])continue
      scores[visited][next]=seconds
      meters[visited][next]=distance
      previous[visited][next]=end
    }
  }
  let set=sets-1,end=scores[set].reduce((best,seconds,i)=>
    seconds<scores[set][best]||seconds===scores[set][best]&&meters[set][i]<meters[set][best]?i:best,0)
  const seconds=scores[set][end],indices:number[]=[]
  while(end!==-1){
    indices.unshift(end+1)
    const prior=previous[set][end]
    set^=1<<end
    end=prior
  }
  return {indices,seconds}
}
