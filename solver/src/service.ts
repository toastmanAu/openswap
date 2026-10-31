// Always-on solver loop around a reference solver: settle what matches, return
// expired orders, archive deep-enough settlements from the journal, and write a
// status record each cycle. Sending pauses (scanning continues) while the fee
// wallet is below its floor or the rolling 24 h fee budget is spent. Journal rows
// that are rejected or long unresolved are reported for the operator; their inputs
// stay reserved, as the runner already guarantees. Never resolves them itself.
import { ccc } from '@ckb-ccc/core';
import type { ArchivableSubmissionJournal } from './journal.js';
import { archiveCommittedSubmission } from './resolution.js';

export interface ServiceSolver {
  tick(execute?: boolean): Promise<ccc.Transaction | undefined>;
  returnExpired(execute?: boolean): Promise<ccc.Transaction | undefined>;
}
export type ServiceClient = Pick<ccc.Client, 'getTransactionNoCache' | 'getTipHeader' | 'getCellLive'> & { cache: Pick<ccc.ClientCache, 'markUsable'> };
export interface ServiceOptions {
  /** Send transactions. Otherwise build and report only. */
  execute: boolean;
  /** Fee wallet floor in shannons: below it, sending pauses. */
  minBalance: bigint;
  /** Fees in shannons the service may pay per rolling 24 h. May overshoot by one transaction's fee cap. */
  dailyFeeBudget: bigint;
  intervalMs?: number; maxBackoffMs?: number;
  /** Settlements sent per cycle (default 4). Dry runs build one. */
  maxSettlementsPerCycle?: number;
  /** Depth before a committed settlement is archived and its change reused (default 24). */
  minConfirmations?: number;
  /** An unresolved row older than this needs the operator (default 30 min). */
  attentionAfterMs?: number;
  /** Fees already paid, e.g. from the previous status record. */
  fees?: FeeRecord[];
}
export interface ServiceDeps {
  solver: ServiceSolver; journal: ArchivableSubmissionJournal; client: ServiceClient;
  balance(): Promise<bigint>;
  feeOf(tx: ccc.Transaction): Promise<bigint>;
  writeStatus(status: ServiceStatus): Promise<void> | void;
  emit?: (event: string, details: unknown) => void;
  now?: () => number;
}
export interface FeeRecord { at: number; txHash: ccc.Hex; fee: string; kind: 'settlement' | 'return' }
export interface ServiceStatus {
  version: 1; mode: 'live' | 'dry-run'; state: 'running' | 'paused' | 'error' | 'stopped';
  pauseReasons: string[]; startedAt: string; lastCycleAt?: string; lastSendAt?: string; nextCycleAt?: string;
  cycles: number; sent: { settlements: number; returns: number }; lastBuilt?: { kind: 'settlement' | 'return'; txHash: ccc.Hex; at: string };
  balance?: string; minBalance: string; feesLast24h: string; dailyFeeBudget: string;
  journal: { active: number; archived: number; attention: { hash: ccc.Hex; status: string; ageSeconds: number }[] };
  consecutiveErrors: number; lastError?: string; fees: FeeRecord[];
}
const DAY = 86_400_000;

export class SolverService {
  private readonly now: () => number;
  private readonly status: ServiceStatus;
  private fees: FeeRecord[];
  constructor(private readonly deps: ServiceDeps, private readonly options: ServiceOptions) {
    const max = options.maxSettlementsPerCycle ?? 4;
    if (!Number.isSafeInteger(max) || max < 1 || max > 32) throw new Error('maxSettlementsPerCycle must be 1..32');
    if (options.minBalance < 0n || options.dailyFeeBudget < 0n) throw new Error('Balance floor and fee budget must not be negative');
    this.now = deps.now ?? Date.now;
    this.fees = [...(options.fees ?? [])];
    this.status = {
      version: 1, mode: options.execute ? 'live' : 'dry-run', state: 'running', pauseReasons: [], startedAt: new Date(this.now()).toISOString(),
      cycles: 0, sent: { settlements: 0, returns: 0 }, minBalance: options.minBalance.toString(), feesLast24h: '0', dailyFeeBudget: options.dailyFeeBudget.toString(),
      journal: { active: 0, archived: 0, attention: [] }, consecutiveErrors: 0, fees: [],
    };
  }
  private emit(event: string, details: unknown) { this.deps.emit?.(event, details); }
  private spent(): bigint {
    this.fees = this.fees.filter(f => f.at > this.now() - DAY);
    return this.fees.reduce((s, f) => s + BigInt(f.fee), 0n);
  }
  /** Archive committed settlements at depth, and make their live outputs (the solver's change) usable again. */
  private async archive() {
    const { journal, client } = this.deps;
    for (const row of journal.list()) {
      if (row.status !== 'committed') continue;
      const tip = (await client.getTipHeader()).number, seen = await client.getTransactionNoCache(row.hash);
      if (seen?.status !== 'committed' || seen.blockNumber === undefined || tip - seen.blockNumber + 1n < BigInt(this.options.minConfirmations ?? 24)) continue;
      await archiveCommittedSubmission(journal, client, row.hash, this.options.minConfirmations ?? 24);
      const tx = ccc.Transaction.fromBytes(row.transaction);
      for (let index = 0; index < tx.outputs.length; index++) {
        const cell = await client.getCellLive({ txHash: row.hash, index }, true, true);
        if (cell) await client.cache.markUsable(cell);
      }
      this.status.journal.archived++;
      this.emit('settlement_archived', { txHash: row.hash });
    }
  }
  private attention() {
    const limit = this.options.attentionAfterMs ?? 30 * 60_000;
    return this.deps.journal.list()
      .filter(r => r.status === 'rejected' || (r.status === 'unknown' && this.now() - r.createdAt > limit))
      .map(r => ({ hash: r.hash, status: r.status, ageSeconds: Math.floor((this.now() - r.createdAt) / 1000) }));
  }
  private async send(kind: FeeRecord['kind'], execute: boolean, build: (execute: boolean) => Promise<ccc.Transaction | undefined>) {
    const tx = await build(execute);
    if (!tx) return false;
    const at = this.now(), txHash = tx.hash();
    this.status.lastBuilt = { kind, txHash, at: new Date(at).toISOString() };
    if (!execute) return false;
    this.fees.push({ at, txHash, fee: (await this.deps.feeOf(tx)).toString(), kind });
    this.status.lastSendAt = new Date(at).toISOString();
    this.status.sent[kind === 'settlement' ? 'settlements' : 'returns']++;
    return true;
  }
  /** One cycle. Returns the delay before the next one. */
  async cycle(): Promise<number> {
    const interval = this.options.intervalMs ?? 15_000;
    this.status.cycles++;
    this.status.lastCycleAt = new Date(this.now()).toISOString();
    try {
      await this.archive();
      const balance = await this.deps.balance(), reasons: string[] = [];
      this.status.balance = balance.toString();
      if (balance < this.options.minBalance) reasons.push('fee wallet below its floor');
      if (this.spent() >= this.options.dailyFeeBudget) reasons.push('24 h fee budget spent');
      // The budget is checked before every send, so it is overshot by at most one transaction's fee.
      const execute = this.options.execute && !reasons.length, budgetLeft = () => this.spent() < this.options.dailyFeeBudget;
      for (let i = 0; i < (execute ? this.options.maxSettlementsPerCycle ?? 4 : 1) && (!execute || budgetLeft()); i++)
        if (!await this.send('settlement', execute, e => this.deps.solver.tick(e))) break;
      if (execute && !budgetLeft()) reasons.push('24 h fee budget spent');
      await this.send('return', execute && !reasons.length, e => this.deps.solver.returnExpired(e));
      this.status.pauseReasons = this.options.execute ? reasons : [];
      this.status.state = this.status.pauseReasons.length ? 'paused' : 'running';
      this.status.consecutiveErrors = 0;
      delete this.status.lastError;
    } catch (error) {
      this.status.state = 'error';
      this.status.consecutiveErrors++;
      this.status.lastError = error instanceof Error ? error.message : String(error);
      this.emit('service_error', { message: this.status.lastError, consecutive: this.status.consecutiveErrors });
    }
    const delay = this.status.consecutiveErrors ? Math.min(interval * 2 ** this.status.consecutiveErrors, this.options.maxBackoffMs ?? 300_000) : interval;
    await this.write(delay);
    return delay;
  }
  private async write(delay?: number) {
    // A journal read failure is itself reported, not thrown out of the loop.
    try { this.status.journal.active = this.deps.journal.list().length; this.status.journal.attention = this.attention(); }
    catch (error) { this.status.journal.attention = []; this.status.lastError ??= error instanceof Error ? error.message : String(error); }
    this.status.feesLast24h = this.spent().toString();
    this.status.fees = [...this.fees];
    if (delay === undefined) delete this.status.nextCycleAt; else this.status.nextCycleAt = new Date(this.now() + delay).toISOString();
    await this.deps.writeStatus(structuredClone(this.status));
  }
  /** Cycle until the signal aborts; the cycle in progress finishes first. */
  async run(signal: AbortSignal, sleep: (ms: number, signal: AbortSignal) => Promise<void>) {
    while (!signal.aborted) {
      const delay = await this.cycle();
      if (!signal.aborted) await sleep(delay, signal);
    }
    this.status.state = 'stopped';
    await this.write();
  }
}
