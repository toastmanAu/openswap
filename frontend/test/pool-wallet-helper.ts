// Injected only into isolated test pages. A mock JoyID-typed signer: no keys,
// no WebAuthn, and its "signature" is a fixed placeholder no node would accept.
import {ccc} from '@ckb-ccc/core';
type Mode='ok'|'refuse'|'hang';
const state=globalThis as unknown as {poolSignMode:Mode;poolSignCalls:number;poolHangRelease?:()=>void};
export function installJoyId(lockJson:string,publicKey:string){
 const connector=document.querySelector('ccc-connector') as HTMLElement&{client:ccc.Client};
 const lock=ccc.Script.from(JSON.parse(lockJson));
 state.poolSignMode??='ok';state.poolSignCalls=0;
 class MockJoyId extends ccc.SignerDummy {
  constructor(){super(connector.client,ccc.SignerType.CKB);}
  get signType(){return ccc.SignerSignType.JoyId;}
  async connect(){}
  async disconnect(){}
  async getIdentity(){return JSON.stringify({keyType:'main_key',publicKey});}
  async getAddressObjs(){return [ccc.Address.fromScript(lock,connector.client)];}
  async getInternalAddress(){return ccc.Address.fromScript(lock,connector.client).toString();}
  async getBalance(){return 0n;}
  async *findCells(){/* Order-tab balances are not part of the pool fixture. */}
  // This bundle has its own CCC copy; rebuilding via its Transaction.from would
  // alter the app's input caches, so operate on the app's own instance.
  async prepareTransaction(input:ccc.TransactionLike){return (input as ccc.Transaction).clone();}
  async signOnlyTransaction(input:ccc.TransactionLike){
   state.poolSignCalls++;
   if(state.poolSignMode==='refuse')throw new Error('User rejected the request');
   if(state.poolSignMode==='hang')await new Promise<void>(resolve=>{state.poolHangRelease=resolve;});
   const tx=(input as ccc.Transaction).clone();
   const index=tx.witnesses.findIndex(w=>{try{return ccc.bytesFrom(ccc.WitnessArgs.fromBytes(w).lock??'0x').length===1000;}catch{return false;}});
   const args=ccc.WitnessArgs.fromBytes(tx.witnesses[index]!);args.lock=ccc.hexFrom(new Uint8Array(100).fill(9));
   tx.witnesses[index]=ccc.hexFrom(args.toBytes());return tx;
  }
 }
 const event=new Event('connection',{bubbles:true});
 Object.assign(event,{connectionOwner:new ccc.OwnerUnique({wallet:{name:'Mock JoyID',icon:''},signerInfo:{name:'Mock JoyID',signer:new MockJoyId()}},()=>{})});
 connector.dispatchEvent(event);
}
