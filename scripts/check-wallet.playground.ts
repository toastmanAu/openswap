// Read-only diagnostic: no transaction, signature request, or broadcast.
import { signer, client } from "@ckb-ccc/playground";

console.log("WALLET CHECK — READ ONLY");
console.log("Network:", client.addressPrefix === "ckt" ? "CKB testnet" : "CKB mainnet");
console.log("Signer type:", signer.signType);
console.log("Connected:", await signer.isConnected());
console.log("Wallet-reported address:", await signer.getInternalAddress());
for (const address of await signer.getAddressObjs()) {
  console.log("CKB address:", address.toString());
  console.log("Lock code hash:", address.script.codeHash);
  console.log("Lock hash type:", address.script.hashType);
  console.log("Lock args:", address.script.args);
}
