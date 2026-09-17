import { ccc } from '@ckb-ccc/core';
import { readFileSync } from 'node:fs';
import * as sdk from '../src/index.js';
export const deployment = JSON.parse(readFileSync(new URL('../../deployments/testnet.json', import.meta.url), 'utf8')) as sdk.Deployment;
export const hex = (n: number, size = 32) => ccc.hexFrom(new Uint8Array(size).fill(n));
export const owner = ccc.Script.from({ codeHash: hex(3), hashType: 'type', args: hex(4,20) });
export const a = ccc.Script.from({ codeHash: hex(2), hashType: 'data1', args: hex(1) });
export const b = ccc.Script.from({ codeHash: hex(2), hashType: 'data1', args: hex(2) });
export function setup() {
  const cells: ccc.Cell[] = []; let next = 1; let reorder = false; let signing = false;
  const add = (cell: ccc.CellAny) => { const c = ccc.Cell.from({ ...cell, outPoint: { txHash: hex(next++), index: 0 } }); cells.push(c); return c; };
  const client = {
    addressPrefix: 'ckt',
    getHeaderByNumber: async () => ({ hash: deployment.genesisHash }),
    getKnownScript: async (kind: ccc.KnownScript) => ({ codeHash: kind === ccc.KnownScript.XUdt ? a.codeHash : kind === ccc.KnownScript.JoyId ? owner.codeHash : hex(99), hashType: kind === ccc.KnownScript.XUdt ? 'data1' : 'type', cellDeps: [] }),
    getCellDeps: async () => [],
    getFeeRate: async () => 1000n,
    getCellLive: async (p: ccc.OutPointLike) => cells.find(c => c.outPoint.eq(p)),
    getCell: async (p: ccc.OutPointLike) => cells.find(c => c.outPoint.eq(p)),
  } as unknown as ccc.Client;
  client.findCellsOnChain=async function* (key,order,limit){yield* client.findCells(key,order,limit);};
  class Wallet extends ccc.SignerDummy {
    constructor() { super(client, ccc.SignerType.CKB); }
    async connect() {}
    async getAddressObjs() { return [ccc.Address.fromScript(owner, client)]; }
    async getInternalAddress() { return ccc.Address.fromScript(owner,client).toString(); }
    async *findCells(filter: any) {
      for (const c of cells) {
        if (!c.cellOutput.lock.eq(owner)) continue;
        if (filter.script && !c.cellOutput.type?.eq(filter.script)) continue;
        if (filter.scriptLenRange?.[0] === 0 && c.cellOutput.type) continue;
        const len = (c.outputData.length - 2) / 2;
        if (filter.outputDataLenRange && (len < Number(filter.outputDataLenRange[0]) || len >= Number(filter.outputDataLenRange[1]))) continue;
        yield c;
      }
    }
    async prepareTransaction(input: ccc.TransactionLike) {
      const tx = ccc.Transaction.from(input);
      await tx.prepareSighashAllWitness(owner, 1000, client);
      if (reorder) tx.outputs.reverse();
      return tx;
    }
    async signOnlyTransaction(input: ccc.TransactionLike) { signing = true; return ccc.Transaction.from(input); }
  }
  const signer = new Wallet();
  const context: sdk.BuildContext = { signer, deployment };
  const fund = () => add(ccc.CellAny.from({cellOutput:{lock:owner,capacity:10000000000000n},outputData:'0x'}));
  const order = (offer: sdk.AssetId, ask: sdk.AssetId, amount = 100n, askAmount = 100n) => add(sdk.estimateCapacity(deployment,{ownerLock:owner,nonce:new Uint8Array(16).fill(next),askAsset:ask,askAmount},offer,amount).cell);
  return { cells, add, client, signer, context, fund, order, corrupt: () => { reorder = true; }, signed: () => signing };
}
