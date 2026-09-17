// Injected only into an isolated test page. Contains no private key; not in frontend/dist.
import {ccc} from '@ckb-ccc/core';
export function install(publicKey:ccc.Hex){
 const connector=document.querySelector('ccc-connector') as HTMLElement&{client:ccc.Client};
 class TestSigner extends ccc.SignerCkbPublicKey{
  async signOnlyTransaction(input:ccc.TransactionLike){
   const signed=await (globalThis as unknown as {openswapTestSign:(raw:string)=>Promise<string>}).openswapTestSign(ccc.stringify(ccc.Transaction.from(input)));
   return ccc.Transaction.from(JSON.parse(signed));
  }
 }
 const signer=new TestSigner(connector.client,publicKey);
 const event=new Event('connection',{bubbles:true});Object.assign(event,{connectionOwner:new ccc.OwnerUnique({wallet:{name:'Local test secp',icon:''},signerInfo:{name:'Local test secp',signer}},()=>{})});connector.dispatchEvent(event);
}
/** Read-only account-switch fixture. Never holds keys and cannot sign. */
export async function installAddress(address:string){
 const connector=document.querySelector('ccc-connector') as HTMLElement&{client:ccc.Client};
 const resolved=await ccc.Address.fromString(address,connector.client);
 class AddressSigner extends ccc.SignerDummy {
  constructor(){super(connector.client,ccc.SignerType.CKB);}
  async connect(){}
  async getAddressObjs(){return [resolved];}
  async getInternalAddress(){return address;}
  async getBalance(){return 0n;}
  async *findCells(){/* No spendable funding in this fixture. */}
  async disconnect(){(globalThis as any).openswapDisconnects=((globalThis as any).openswapDisconnects??0)+1;}
 }
 const event=new Event('connection',{bubbles:true});Object.assign(event,{connectionOwner:new ccc.OwnerUnique({wallet:{name:'Read-only fixture',icon:''},signerInfo:{name:'Read-only fixture',signer:new AddressSigner()}},()=>{})});connector.dispatchEvent(event);
}
