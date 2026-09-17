import { ccc } from '@ckb-ccc/core';
import { defaultResolver, scan, fillOrders, submit, orderKey, type OpenSwapOrder, type BuildContext } from '@openswap/sdk';
import { match } from './matcher.js';
import { recoverConflictedTransaction } from './recovery.js';
export class ReferenceSolver {
  private readonly pending = new Map<ccc.Hex, {orders:string[];tx:ccc.Transaction}>();
  private running = false;
  constructor(private readonly context: BuildContext, private readonly emit: (event: string, details: unknown) => void = () => {}, private readonly options: { acceptOrder?: (order: OpenSwapOrder) => boolean } = {}) {}
  /** One scan/build attempt. State is local and recoverable from live chain cells. */
  async tick(execute = false): Promise<ccc.Transaction | undefined> {
    if (this.running) throw new Error('Solver tick already running');
    this.running = true;
    try {
      const client = this.context.signer.client;
      for (const [hash, pending] of this.pending) {
        const tx = await client.getTransactionNoCache(hash);
        if (tx?.status === 'pending' || tx?.status === 'proposed' || tx?.status === 'sent') continue;
        if (tx?.status !== 'committed') await recoverConflictedTransaction(client,pending.tx);
        this.pending.delete(hash);
        this.emit(tx?.status === 'committed' ? 'settlement_committed' : 'settlement_conflict', { txHash: hash });
      }
      const reserved = new Set([...this.pending.values()].flatMap(p=>p.orders));
      const book = [];
      for await (const order of scan(client, this.context.deployment, this.context.resolver ?? defaultResolver(client), {maxCells:10000})) if (!reserved.has(orderKey(order)) && (this.options.acceptOrder?.(order) ?? true)) book.push(order);
      const bundle = match(book);
      if (!bundle) return;
      this.emit('candidate_bundle', { orders: bundle.orders.map(orderKey) });
      const built = await fillOrders(this.context, bundle.orders.map(o=>o.outPoint));
      built.assertLayout();
      this.emit('settlement_built', { txHash: built.tx.hash() });
      if (execute) {
        const hash = await submit(built, this.context.signer);
        this.pending.set(hash,{orders:bundle.orders.map(orderKey),tx:built.tx.clone()});
        this.emit('settlement_submitted',{txHash:hash});
      }
      return built.tx;
    } catch (error) {
      this.emit('settlement_failed',{message:error instanceof Error ? error.message : String(error)});
      throw error;
    } finally { this.running=false; }
  }
}
