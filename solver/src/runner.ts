import { ccc } from '@ckb-ccc/core';
import { defaultResolver, scan, fillOrders, submit, orderKey, type OpenSwapOrder, type BuildContext, type BuiltTransaction } from '@openswap/sdk';
import { match } from './matcher.js';
import { recoverConflictedTransaction } from './recovery.js';
import type {SubmissionJournal,SubmissionRecord} from './journal.js';
/** A settlement chosen by a solver strategy: its built transaction and the order keys it consumes. */
export interface Settlement { built: BuiltTransaction; orders: string[] }
export class ReferenceSolver {
  private readonly pending = new Map<ccc.Hex, {orders:string[];tx:ccc.Transaction}>();
  private running = false;
  constructor(protected readonly context: BuildContext, protected readonly emit: (event: string, details: unknown) => void = () => {}, protected readonly options: { acceptOrder?: (order: OpenSwapOrder) => boolean; journal?:SubmissionJournal } = {}) {}
  /** One scan/build attempt. State is local and recoverable from live chain cells. */
  async tick(execute = false): Promise<ccc.Transaction | undefined> {
    return this.settle(execute, reserved => this.plan(reserved));
  }
  /** v1 strategy: bounded reciprocal whole-lot bundles. */
  protected async plan(reserved: Set<string>): Promise<Settlement | undefined> {
    const client = this.context.signer.client;
    const book = [];
    for await (const order of scan(client, this.context.deployment, this.context.resolver ?? defaultResolver(client), {maxCells:10000})) if (!reserved.has(orderKey(order)) && (this.options.acceptOrder?.(order) ?? true)) book.push(order);
    const bundle = match(book);
    if (!bundle) return;
    this.emit('candidate_bundle', { orders: bundle.orders.map(orderKey) });
    return { built: await fillOrders(this.context, bundle.orders.map(o=>o.outPoint)), orders: bundle.orders.map(orderKey) };
  }
  /** Reconcile journaled submissions, plan one settlement, then (if executing) journal and send it once. */
  protected async settle(execute: boolean, plan: (reserved: Set<string>) => Promise<Settlement | undefined>): Promise<ccc.Transaction | undefined> {
    if (this.running) throw new Error('Solver tick already running');
    this.running = true;
    try {
      const client = this.context.signer.client;
      const journal=this.options.journal;
      if(execute&&!journal)throw new Error('Executing solver requires a durable submission journal');
      if(journal){
        const scope=journal.getScope(),addresses=await this.context.signer.getAddressObjs();
        if(scope.genesisHash!==this.context.deployment.genesisHash||addresses.length!==1||addresses[0]!.script.hash()!==scope.accountLockHash)throw new Error('Solver journal account/network mismatch');
        if((await client.getHeaderByNumber(0))?.hash!==scope.genesisHash)throw new Error('Solver journal network mismatch');
        // Reload before every scan, including previously committed rows: a reorg
        // must not turn their old inputs into an unreserved replacement attempt.
        for(const row of journal.list())this.pending.set(row.hash,{orders:row.orders,tx:ccc.Transaction.fromBytes(row.transaction)});
      }
      for (const [hash, pending] of this.pending) {
        if(journal)await client.cache.markUnusable([...pending.tx.inputs.map(i=>i.previousOutput),...pending.tx.outputs.map((_,index)=>({txHash:hash,index}))]);
        const tx = await client.getTransactionNoCache(hash);
        if (tx?.status === 'pending' || tx?.status === 'proposed' || tx?.status === 'sent') {
          if(journal){const row=journal.list().find(row=>row.hash===hash)!;if(row.status!=='unknown')journal.put({...row,status:'unknown'});}
          continue;
        }
        if(journal){
          const row=journal.list().find(row=>row.hash===hash)!;
          const status=tx?.status==='committed'?'committed':tx?.status==='rejected'?'rejected':'unknown';
          if(row.status!==status)journal.put({...row,status});
          // Unknown/absent does not prove failure. Keep every input unavailable
          // and discard speculative outputs. No automatic rebroadcast/replacement.
          await client.cache.markUnusable([...pending.tx.inputs.map(i=>i.previousOutput),...pending.tx.outputs.map((_,index)=>({txHash:hash,index}))]);
          this.emit(`settlement_${status}`,{txHash:hash});
          continue;
        }
        if (tx?.status !== 'committed') await recoverConflictedTransaction(client,pending.tx);
        this.pending.delete(hash);
        this.emit(tx?.status === 'committed' ? 'settlement_committed' : 'settlement_conflict', { txHash: hash });
      }
      const reserved = new Set([...this.pending.values()].flatMap(p=>p.orders));
      const settlement = await plan(reserved);
      if (!settlement) return;
      const {built} = settlement;
      built.assertLayout();
      const reservedInputs=new Set([...this.pending.values()].flatMap(p=>p.tx.inputs.map(i=>`${i.previousOutput.txHash}:${i.previousOutput.index}`)));
      if(built.tx.inputs.some(i=>reservedInputs.has(`${i.previousOutput.txHash}:${i.previousOutput.index}`)))throw new Error('Solver funding overlaps an unresolved submission');
      this.emit('settlement_built', { txHash: built.tx.hash() });
      if (execute) {
        const hash = await submit(built, this.context.signer, {
          // Reserve before sending: a lost RPC reply does not mean rejection.
          beforeBroadcast: (hash,transaction) => {
            const row:SubmissionRecord={hash,transaction,orders:settlement.orders,status:'unknown',createdAt:Date.now()};
            journal!.put(row); // failure prevents send and later scans fail closed
            this.pending.set(hash,{orders:row.orders,tx:ccc.Transaction.fromBytes(transaction)});
          },
        });
        this.emit('settlement_submitted',{txHash:hash});
      }
      return built.tx;
    } catch (error) {
      this.emit('settlement_failed',{message:error instanceof Error ? error.message : String(error)});
      throw error;
    } finally { this.running=false; }
  }
}
