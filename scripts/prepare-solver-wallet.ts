import {ccc} from '@ckb-ccc/shell';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const directory=new URL('../.local/',import.meta.url);
await mkdir(directory,{recursive:true,mode:0o700});
const keyFile=new URL('testnet-solver-key',directory);
try{await writeFile(keyFile,ccc.hexFrom(randomBytes(32)),{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
const owned=ccc.ClientPublicTestnet.open({urls:['https://testnet.ckb.dev']});
try{
 const signer=new ccc.SignerCkbPrivateKey(owned.value,(await readFile(keyFile,'utf8')).trim());
 const address=await signer.getRecommendedAddressObj();
 const config={network:'testnet',address:address.toString(),lock:address.script};
 await writeFile(new URL('../deployments/solver-wallet.json',import.meta.url),ccc.stringify(config)+'\n');
 console.log('Prepared testnet-only solver wallet:',address.toString());
 console.log('Private key stays in ignored .local/testnet-solver-key with owner-only permissions.');
}finally{await owned.dispose();}
