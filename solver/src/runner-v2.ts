// v2 reference solver: reciprocal matching with partial fills over v2 orders
// (and whole v1 lots when a v1 deployment is given), plus a keeper that returns
// expired v2 orders to their owners. Time comes from the chain tip, not the host
// clock. Journaling, reservation and single-send rules are the v1 runner's.
import { ccc } from '@ckb-ccc/core';
import { assetKey, defaultResolver, fillOrdersV2, isExpired, isV2, orderKey, returnExpiredV2, scan, scanV2, type AnyOrder, type BuildContext, type Deployment } from '@openswap/sdk';
import type { SubmissionJournal } from './journal.js';
import { matchV2 } from './matcher-v2.js';
import { ReferenceSolver, type Settlement } from './runner.js';

export interface V2SolverOptions {
  /** Also match whole v1 lots from this deployment. */
  v1?: Deployment;
  journal?: SubmissionJournal;
  acceptOrder?: (order: AnyOrder) => boolean;
  /** Stop filling this long before expiry (default 300 s). */
  expiryMarginSeconds?: bigint;
  /** Return orders only this long after expiry by tip time (default 900 s), so the
   * chain's median time (which `since` uses, and which lags the tip) has passed it. */
  returnDelaySeconds?: bigint;
  /** Orders returned per transaction (default 16). */
  maxReturns?: number;
}

export class ReferenceSolverV2 extends ReferenceSolver {
  constructor(context: BuildContext, emit: (event: string, details: unknown) => void = () => {}, private readonly v2: V2SolverOptions = {}) {
    super(context, emit, { journal: v2.journal });
  }
  /** Seconds since the epoch at the chain tip. */
  async chainSeconds(): Promise<bigint> {
    return (await this.context.signer.client.getTipHeader()).timestamp / 1000n;
  }
  private async book(reserved: Set<string>): Promise<AnyOrder[]> {
    const client = this.context.signer.client, resolver = this.context.resolver ?? defaultResolver(client);
    const book: AnyOrder[] = [];
    const keep = (o: AnyOrder) => !reserved.has(orderKey(o)) && (this.v2.acceptOrder?.(o) ?? true);
    for await (const o of scanV2(client, this.context.deployment, resolver, { maxCells: 10000 })) if (keep(o)) book.push(o);
    if (this.v2.v1) for await (const o of scan(client, this.v2.v1, resolver, { maxCells: 10000 })) if (keep(o)) book.push(o);
    return book;
  }
  protected override async plan(reserved: Set<string>): Promise<Settlement | undefined> {
    const now = await this.chainSeconds(), margin = this.v2.expiryMarginSeconds ?? 300n;
    const m = matchV2(await this.book(reserved), { nowSeconds: now, expiryMarginSeconds: margin });
    if (!m) return;
    const orders = m.legs.map(l => orderKey(l.order));
    const takes = m.legs.map(l => l.take?.toString() ?? 'whole');
    // Named by what was found: two reciprocal orders, several in one market, or a ring
    // (with its route: each order's offer asset in turn, as assetKeys, first repeated).
    if ('ring' in m) this.emit('candidate_ring', { orders, takes, route: [...m.legs, m.legs[0]!].map(l => assetKey(l.order.offerAsset)) });
    else this.emit(m.legs.length === 2 ? 'candidate_pair' : 'candidate_book', { orders, takes });
    const built = await fillOrdersV2(this.context, m.legs.map(l => ({ outPoint: l.order.outPoint, take: isV2(l.order) ? l.take : undefined })), { v1: this.v2.v1, nowSeconds: now + margin });
    return { built, orders };
  }
  /** Keeper: return up to `maxReturns` expired v2 orders to their owners. The solver pays the fee. */
  async returnExpired(execute = false): Promise<ccc.Transaction | undefined> {
    return this.settle(execute, reserved => this.planReturn(reserved));
  }
  private async planReturn(reserved: Set<string>): Promise<Settlement | undefined> {
    const cutoff = (await this.chainSeconds()) - (this.v2.returnDelaySeconds ?? 900n);
    const max = this.v2.maxReturns ?? 16;
    if (!Number.isSafeInteger(max) || max < 1 || max > 32) throw new Error('maxReturns must be 1..32');
    const expired = (await this.book(reserved)).filter((o): o is Extract<AnyOrder, { version: 2 }> => isV2(o) && isExpired(o, cutoff)).slice(0, max);
    if (!expired.length) return;
    const orders = expired.map(orderKey);
    this.emit('candidate_return', { orders });
    return { built: await returnExpiredV2(this.context, expired.map(o => o.outPoint), cutoff), orders };
  }
}
