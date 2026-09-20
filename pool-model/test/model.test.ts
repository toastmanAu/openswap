import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPool,swap,deposit,withdraw,transition,validateTransition,validateState,capacities,circulatingShares,sqrtFloor,ModelError,U64_MAX,U256_MAX,RESERVE_MAX,FEE_DENOMINATOR,type Parameters,type PoolState,type Operation,type Result} from '../src/model.js';
const p:Parameters={feeBps:30n,lockedShares:1000n,backing:{state:20000000000n,ckb:10000000000n,token:20000000000n}};
const initial=()=>createPool(p,1_000_000n,4_000_000n,1n).next;
function error(code:string){return (e:unknown)=>e instanceof ModelError&&e.code===code;}
function conserved(before:PoolState,r:Result){
 assert.equal(r.next.x,before.x+r.flows.paidX-r.flows.receivedX);
 assert.equal(r.next.y,before.y+r.flows.paidY-r.flows.receivedY);
 assert.equal(r.next.totalShares,before.totalShares+r.flows.mintedShares-r.flows.burnedShares);
 assert.deepEqual(r.next.backing,before.backing);assert.equal(r.next.lockedShares,before.lockedShares);assert.equal(r.next.feeBps,before.feeBps);
 validateState(r.next);
}
test('genesis has explicit virtual locked shares and excludes storage from reserves',()=>{
 const r=createPool(p,1_000_000n,4_000_000n,1_999_000n);
 assert.equal(r.next.totalShares,2_000_000n);assert.equal(r.flows.mintedShares,1_999_000n);
 assert.equal(circulatingShares(r.next),r.flows.mintedShares);
 assert.deepEqual(capacities(r.next),{state:p.backing.state,ckb:p.backing.ckb+1_000_000n,token:p.backing.token});
 assert.throws(()=>createPool(p,1000n,1000n,1n),error('SHARES'));
 assert.throws(()=>createPool(p,1_000_000n,4_000_000n,2_000_000n),error('SLIPPAGE'));
});
test('integer square root satisfies independent lower/upper bounds',()=>{
 for(const n of [0n,1n,2n,3n,4n,15n,16n,17n,(1n<<224n)-1n,U256_MAX]){
  const r=sqrtFloor(n);assert(r*r<=n);assert((r+1n)*(r+1n)>n);
 }
 assert.throws(()=>sqrtFloor(-1n),error('RANGE'));assert.throws(()=>sqrtFloor(U256_MAX+1n),error('RANGE'));
});
test('exact-input swaps charge LP fee in either direction and preserve backing',()=>{
 const before=initial(),copy=structuredClone(before);
 const forward=swap(before,'xToY',10_000n,39_486n);assert.equal(forward.flows.receivedY,39_486n);
 const reverse=swap(before,'yToX',40_000n,9_871n);assert.equal(reverse.flows.receivedX,9_871n);
 for(const r of [forward,reverse]){conserved(before,r);assert(r.next.x*r.next.y>=before.x*before.y);assert.equal(r.next.totalShares,before.totalShares);}
 assert.deepEqual(before,copy);
 assert.throws(()=>swap(before,'xToY',10_000n,39_487n),error('SLIPPAGE'));
});
test('unbalanced deposit charges ceil-backed amounts and leaves unused budget',()=>{
 const before=initial(),r=deposit(before,10_000n,100_000n,20_000n);
 assert.equal(r.flows.mintedShares,20_000n);assert.equal(r.flows.paidX,10_000n);assert.equal(r.flows.paidY,40_000n);
 assert.equal(r.flows.unusedY,60_000n);conserved(before,r);
 const odd=createPool({...p,lockedShares:1n},10n,20n,1n).next;
 const q=deposit(odd,3n,9n,1n);assert.equal(q.flows.mintedShares,4n);assert.equal(q.flows.paidX,3n);assert.equal(q.flows.paidY,6n);assert.equal(q.flows.unusedY,3n);
 assert.throws(()=>deposit(before,10_000n,100_000n,20_001n),error('SLIPPAGE'));
});
test('withdrawal of all circulating shares leaves permanent backing and virtual reserves',()=>{
 const before=initial(),r=withdraw(before,circulatingShares(before),1n,1n);
 assert.equal(r.next.totalShares,p.lockedShares);assert.equal(r.next.x,500n);assert.equal(r.next.y,2000n);
 conserved(before,r);assert.equal(circulatingShares(r.next),0n);
 assert.throws(()=>withdraw(r.next,1n,1n,1n),error('SHARES'));
 assert.throws(()=>withdraw(before,before.totalShares,1n,1n),error('SHARES'));
 // A new depositor can reactivate a pool whose only shares are virtual.
 const added=deposit(r.next,500n,2000n,1000n);assert.equal(circulatingShares(added.next),1000n);
});
test('zero/dust and invalid numeric inputs fail explicitly',()=>{
 const before=initial();
 assert.throws(()=>swap(before,'xToY',0n,1n),error('RANGE'));
 assert.throws(()=>swap(before,'yToX',1n,1n),error('ZERO_OUTPUT'));
 assert.throws(()=>withdraw(before,1n,1n,1n),error('ZERO_OUTPUT'));
 assert.throws(()=>deposit({...before,totalShares:1000n},1n,1n,1n),error('SHARES'));
 assert.throws(()=>swap(before,'xToY',1 as unknown as bigint,1n),error('INTEGER'));
 assert.throws(()=>createPool({...p,feeBps:10000n},10000n,10000n,1n),error('RANGE'));
 assert.throws(()=>createPool({...p,lockedShares:0n},10000n,10000n,1n),error('RANGE'));
 assert.throws(()=>createPool({...p,backing:{...p.backing,ckb:U64_MAX}},10000n,10000n,1n),error('RANGE'));
 assert.throws(()=>transition(before,{kind:'donate'} as unknown as Operation),error('OPERATION'));
});
test('u64 CKB capacity, u112 token reserves and near-limit products are checked',()=>{
 const near=createPool(p,U64_MAX-p.backing.ckb-100n,RESERVE_MAX-100n,1n).next;
 conserved(near,swap(near,'xToY',1n,1n));
 assert.throws(()=>swap(near,'xToY',101n,1n),error('RANGE'));
 assert.throws(()=>swap(near,'yToX',101n,1n),error('RANGE'));
 assert.throws(()=>createPool(p,U64_MAX-p.backing.ckb+1n,10_000n,1n),error('RANGE'));
 assert.throws(()=>createPool(p,10_000n,RESERVE_MAX+1n,1n),error('RANGE'));
 assert.throws(()=>validateState({...initial(),totalShares:1n<<127n}),error('STATE'));
});
test('claimed transitions cannot change fees, shares, reserves, flows or storage',()=>{
 const before=initial(),op:Operation={kind:'deposit',maxX:10_000n,maxY:40_000n,minShares:1n},r=transition(before,op);
 validateTransition(before,op,r);
 const mutations=[
  (a:Result)=>({...a,next:{...a.next,x:a.next.x-1n}}),
  (a:Result)=>({...a,next:{...a.next,totalShares:a.next.totalShares+1n}}),
  (a:Result)=>({...a,next:{...a.next,feeBps:0n}}),
  (a:Result)=>({...a,next:{...a.next,lockedShares:1n}}),
  (a:Result)=>({...a,next:{...a.next,backing:{...a.next.backing,token:1n}}}),
  (a:Result)=>({...a,flows:{...a.flows,mintedShares:a.flows.mintedShares+1n}}),
  (a:Result)=>({...a,flows:{...a.flows,unusedX:a.flows.unusedX+1n}}),
 ];
 for(const mutate of mutations)assert.throws(()=>validateTransition(before,op,mutate(r)),error('TRANSITION'));
 assert.throws(()=>validateTransition(swap(before,'xToY',10000n,1n).next,op,r),error('TRANSITION'));
});
/** Oracle uses the fee-adjusted product predicate and binary search, not quote division. */
function invariantQuote(input:bigint,output:bigint,amount:bigint,fee:bigint):bigint {
 const adjusted=(input+amount)*10000n-amount*fee;let lo=0n,hi=output;
 while(lo+1n<hi){const mid=(lo+hi)/2n;if(adjusted*(output-mid)>=input*output*10000n)lo=mid;else hi=mid;}
 return lo;
}
test('small-reserve exhaustive swaps match an independent invariant oracle',()=>{
 for(const fee of [0n,30n,9999n])for(let x=2n;x<=20n;x++)for(let y=2n;y<=20n;y++)for(let amount=1n;amount<=12n;amount++){
  const s=createPool({...p,feeBps:fee,lockedShares:1n},x,y,1n).next;
  for(const direction of ['xToY','yToX'] as const){
   const input=direction==='xToY'?x:y,output=direction==='xToY'?y:x;
   const expected=invariantQuote(input,output,amount,fee);
   if(expected===0n){assert.throws(()=>swap(s,direction,amount,1n),error('ZERO_OUTPUT'));continue;}
   const r=swap(s,direction,amount,1n);conserved(s,r);
   assert.equal(direction==='xToY'?r.flows.receivedY:r.flows.receivedX,expected);
  }
 }
});
test('small deposits are maximal under budgets and immediate redemption cannot profit',()=>{
 for(let x=2n;x<=16n;x++)for(let y=2n;y<=16n;y++)for(let budget=1n;budget<=10n;budget++){
  const s=createPool({...p,lockedShares:1n},x,y,1n).next,maxX=budget,maxY=11n-budget;
  let expected=0n;
  for(let shares=1n;shares<=200n;shares++)if(shares*x<=maxX*s.totalShares&&shares*y<=maxY*s.totalShares)expected=shares;
  if(expected===0n){assert.throws(()=>deposit(s,maxX,maxY,1n),error('SHARES'));continue;}
  const added=deposit(s,maxX,maxY,1n);assert.equal(added.flows.mintedShares,expected);conserved(s,added);
  assert(added.flows.paidX*s.totalShares>=expected*x);assert((added.flows.paidX-1n)*s.totalShares<expected*x);
  assert(added.flows.paidY*s.totalShares>=expected*y);assert((added.flows.paidY-1n)*s.totalShares<expected*y);
  try{const removed=withdraw(added.next,expected,1n,1n);assert(removed.flows.receivedX<=added.flows.paidX);assert(removed.flows.receivedY<=added.flows.paidY);}
  catch(e){assert(e instanceof ModelError&&e.code==='ZERO_OUTPUT');}
 }
});
test('deterministic mixed operation sequences conserve assets and issued shares',()=>{
 let seed=0x746f617374n;const next=()=>{seed^=seed<<13n;seed^=seed>>7n;seed^=seed<<17n;seed&=U64_MAX;return seed;};
 let s=initial(),walletX=100_000_000n,walletY=400_000_000n,walletShares=circulatingShares(s);
 const totalX=walletX+s.x,totalY=walletY+s.y;let accepted=0;
 for(let i=0;i<3000;i++){
  const n=next(),amount=1n+n%10_000n;
  const op:Operation=n%3n===0n?{kind:'swap',direction:n%2n===0n?'xToY':'yToX',amountIn:amount,minOut:1n}:
   n%3n===1n?{kind:'deposit',maxX:amount,maxY:amount*4n,minShares:1n}:{kind:'withdraw',shares:amount,minX:1n,minY:1n};
  let r:Result;try{r=transition(s,op);}catch(e){assert(e instanceof ModelError);continue;}
  assert(walletX>=r.flows.paidX&&walletY>=r.flows.paidY&&walletShares>=r.flows.burnedShares);
  conserved(s,r);walletX+=r.flows.receivedX-r.flows.paidX;walletY+=r.flows.receivedY-r.flows.paidY;
  walletShares+=r.flows.mintedShares-r.flows.burnedShares;s=r.next;accepted++;
  assert.equal(walletX+s.x,totalX);assert.equal(walletY+s.y,totalY);assert.equal(walletShares,circulatingShares(s));
 }
 assert(accepted>2000);
});
test('repeated round trips cannot extract rounding profit and small fees accumulate for LPs',()=>{
 let s=initial();const startProduct=s.x*s.y;
 for(let i=0;i<1000;i++){
  const out=swap(s,'xToY',1000n,1n);const back=swap(out.next,'yToX',out.flows.receivedY,1n);
  assert(back.flows.receivedX<=1000n);s=back.next;
 }
 assert(s.x*s.y>startProduct);assert.equal(s.totalShares,initial().totalShares);
 assert.equal(FEE_DENOMINATOR,10000n);
});
test('large and asymmetric reserves match the independent quote oracle',()=>{
 for(const x of [1n,1_000_000n,1n<<53n,(U64_MAX-p.backing.ckb)/2n])
 for(const y of [1n,1_000_000n,1n<<100n,RESERVE_MAX/2n])
 for(const fee of [0n,30n,9999n]){
  if(x*y<=1n)continue;
  const s=createPool({...p,feeBps:fee,lockedShares:1n},x,y,1n).next;
  for(const direction of ['xToY','yToX'] as const){
   const input=direction==='xToY'?x:y,output=direction==='xToY'?y:x;
   const amount=input/7n+1n,expected=invariantQuote(input,output,amount,fee);
   if(expected===0n){assert.throws(()=>swap(s,direction,amount,1n),error('ZERO_OUTPUT'));continue;}
   const r=swap(s,direction,amount,1n);conserved(s,r);assert.equal(direction==='xToY'?r.flows.receivedY:r.flows.receivedX,expected);
  }
 }
});
