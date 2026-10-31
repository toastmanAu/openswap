import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import { SolverService, type ServiceOptions, type ServiceStatus } from '../src/service.js';
import type { SubmissionRecord, SubmissionResolution } from '../src/journal.js';

const tx = (n: number) => ccc.Transaction.from({ inputs: [{ previousOutput: { txHash: `0x${n.toString(16).padStart(64, '0')}`, index: 0 } }], outputs: [{ capacity: 100n, lock: ccc.Script.from({ codeHash: `0x${'11'.repeat(32)}`, hashType: 'type', args: '0x' }) }], outputsData: ['0x'] });
const row = (t: ccc.Transaction, status: SubmissionRecord['status'], createdAt: number): SubmissionRecord =>
  ({ hash: t.hash(), transaction: ccc.hexFrom(t.toBytes()), orders: [`${t.inputs[0]!.previousOutput.txHash}:0`], status, createdAt });

function harness(options: Partial<ServiceOptions> = {}, rows: SubmissionRecord[] = []) {
  let clock = 1_000_000_000_000, n = 0;
  const calls: string[] = [], statuses: ServiceStatus[] = [], archived: [ccc.Hex, SubmissionResolution][] = [], usable: string[] = [];
  const state = { balance: 10_000n * 10n ** 8n, matches: 0, expired: 0, fail: undefined as string | undefined, tip: 100n, committedAt: new Map<string, bigint>() };
  const journal = {
    getScope: () => ({ genesisHash: `0x${'00'.repeat(32)}` as ccc.Hex, accountLockHash: `0x${'00'.repeat(32)}` as ccc.Hex }),
    list: () => structuredClone(rows), put: (r: SubmissionRecord) => { rows = [...rows.filter(x => x.hash !== r.hash), r]; },
    archive: (hash: ccc.Hex, resolution: SubmissionResolution) => { archived.push([hash, resolution]); rows = rows.filter(r => r.hash !== hash); },
  };
  const client = {
    getTipHeader: async () => ({ number: state.tip }),
    getTransactionNoCache: async (hash: ccc.Hex) => state.committedAt.has(hash) ? { status: 'committed', blockNumber: state.committedAt.get(hash) } : { status: 'pending' },
    getCellLive: async (p: ccc.OutPointLike) => ({ outPoint: ccc.OutPoint.from(p) }),
    cache: { markUsable: async (c: { outPoint: ccc.OutPoint }) => { usable.push(`${c.outPoint.txHash}:${c.outPoint.index}`); } },
  };
  const solver = {
    tick: async (execute = false) => { calls.push(`tick:${execute}`); if (state.fail) throw new Error(state.fail); if (!state.matches) return; if (execute) state.matches--; return tx(++n); },
    returnExpired: async (execute = false) => { calls.push(`return:${execute}`); if (!state.expired) return; if (execute) state.expired--; return tx(1000 + ++n); },
  };
  const service = new SolverService({
    solver, journal, client: client as never, balance: async () => state.balance, feeOf: async () => 2000n,
    writeStatus: s => { statuses.push(s); }, now: () => clock,
  }, { execute: true, minBalance: 500n * 10n ** 8n, dailyFeeBudget: 10_000n, intervalMs: 1000, ...options });
  return { service, calls, statuses, archived, usable, state, journal, advance: (ms: number) => { clock += ms; }, last: () => statuses.at(-1)! };
}

test('dry run builds one settlement per cycle and never sends', async () => {
  const h = harness({ execute: false });
  h.state.matches = 3; h.state.expired = 1;
  assert.equal(await h.service.cycle(), 1000);
  assert.deepEqual(h.calls, ['tick:false', 'return:false']);
  assert.equal(h.last().mode, 'dry-run'); assert.equal(h.last().state, 'running');
  assert.deepEqual(h.last().sent, { settlements: 0, returns: 0 }); assert.equal(h.last().lastBuilt?.kind, 'return');
  assert.equal(h.last().feesLast24h, '0');
});

test('live cycle settles up to the per-cycle cap, then returns expired orders, recording fees', async () => {
  const h = harness({ maxSettlementsPerCycle: 2 });
  h.state.matches = 3; h.state.expired = 1;
  await h.service.cycle();
  assert.deepEqual(h.calls, ['tick:true', 'tick:true', 'return:true']);
  assert.deepEqual(h.last().sent, { settlements: 2, returns: 1 });
  assert.equal(h.last().feesLast24h, '6000'); assert.equal(h.last().fees.length, 3);
  h.calls.length = 0; await h.service.cycle();
  assert.deepEqual(h.calls, ['tick:true', 'tick:true', 'return:true']);
  assert.equal(h.last().sent.settlements, 3);
});

test('a spent 24 h fee budget pauses sending until fees age out', async () => {
  const h = harness({ dailyFeeBudget: 4000n });
  h.state.matches = 5; h.state.expired = 1;
  await h.service.cycle();
  // Budget reached after two settlements: no further settlement is sent; the return is only built.
  assert.deepEqual(h.calls, ['tick:true', 'tick:true', 'return:false']);
  assert.equal(h.last().state, 'paused'); assert.deepEqual(h.last().pauseReasons, ['24 h fee budget spent']);
  h.calls.length = 0; await h.service.cycle();
  assert.deepEqual(h.calls, ['tick:false', 'return:false']);
  h.advance(86_400_001); h.calls.length = 0; h.state.matches = 1; await h.service.cycle();
  assert.equal(h.last().state, 'running'); assert.deepEqual(h.calls, ['tick:true', 'tick:true', 'return:true']);
  assert.equal(h.last().feesLast24h, '4000');
});

test('fees carried over from a previous run count against the budget', async () => {
  const h = harness({ dailyFeeBudget: 4000n, fees: [{ at: 1_000_000_000_000 - 1000, txHash: `0x${'aa'.repeat(32)}`, fee: '4000', kind: 'settlement' }] });
  h.state.matches = 1;
  await h.service.cycle();
  assert.deepEqual(h.calls, ['tick:false', 'return:false']); assert.equal(h.last().state, 'paused');
});

test('a fee wallet below its floor pauses sending but keeps scanning', async () => {
  const h = harness();
  h.state.balance = 499n * 10n ** 8n; h.state.matches = 1;
  await h.service.cycle();
  assert.deepEqual(h.calls, ['tick:false', 'return:false']);
  assert.deepEqual(h.last().pauseReasons, ['fee wallet below its floor']); assert.equal(h.last().balance, (499n * 10n ** 8n).toString());
  assert.equal(h.last().sent.settlements, 0);
});

test('committed settlements are archived at depth and their outputs made usable again', async () => {
  const deep = tx(1), shallow = tx(2), pending = tx(3);
  const h = harness({}, [row(deep, 'committed', 0), row(shallow, 'committed', 0), row(pending, 'unknown', 1_000_000_000_000)]);
  h.state.committedAt.set(deep.hash(), 77n); h.state.committedAt.set(shallow.hash(), 78n);
  await h.service.cycle();
  assert.deepEqual(h.archived, [[deep.hash(), 'committed']]);
  assert.deepEqual(h.usable, [`${deep.hash()}:0`]);
  assert.equal(h.last().journal.active, 2); assert.equal(h.last().journal.archived, 1);
  assert.deepEqual(h.last().journal.attention, []);
});

test('rejected and long-unresolved submissions are reported, never resolved', async () => {
  const rejected = tx(1), stale = tx(2), fresh = tx(3), start = 1_000_000_000_000;
  const h = harness({}, [row(rejected, 'rejected', start), row(stale, 'unknown', start - 31 * 60_000), row(fresh, 'unknown', start - 60_000)]);
  await h.service.cycle();
  assert.deepEqual(h.last().journal.attention.map(a => [a.hash, a.status]), [[rejected.hash(), 'rejected'], [stale.hash(), 'unknown']]);
  assert.equal(h.last().journal.attention[1]!.ageSeconds, 31 * 60);
  assert.deepEqual(h.archived, []); assert.equal(h.last().journal.active, 3);
});

test('errors back off exponentially up to the cap and clear on success', async () => {
  const h = harness({ maxBackoffMs: 5000 });
  h.state.fail = 'node down';
  assert.equal(await h.service.cycle(), 2000);
  assert.equal(await h.service.cycle(), 4000);
  assert.equal(await h.service.cycle(), 5000);
  assert.equal(h.last().state, 'error'); assert.equal(h.last().lastError, 'node down'); assert.equal(h.last().consecutiveErrors, 3);
  h.state.fail = undefined;
  assert.equal(await h.service.cycle(), 1000);
  assert.equal(h.last().state, 'running'); assert.equal(h.last().lastError, undefined);
});

test('run stops after the cycle in progress and records the stop', async () => {
  const h = harness(), stop = new AbortController();
  let sleeps = 0;
  await h.service.run(stop.signal, async () => { if (++sleeps === 2) stop.abort(); });
  assert.equal(sleeps, 2); assert.equal(h.last().state, 'stopped'); assert.equal(h.last().cycles, 2);
  assert.equal(h.last().nextCycleAt, undefined);
});

test('invalid bounds are refused', () => {
  assert.throws(() => harness({ maxSettlementsPerCycle: 0 }), /1\.\.32/);
  assert.throws(() => harness({ dailyFeeBudget: -1n }), /negative/);
});
