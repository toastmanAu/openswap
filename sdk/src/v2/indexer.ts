import { ccc } from '@ckb-ccc/core';
import type { AssetResolver } from '../assets.js';
import { assertNetwork } from '../orders.js';
import type { Deployment } from '../types.js';
import { parseV2, type OpenSwapOrderV2 } from './orders.js';

/** On-chain v2 orders (committed cells only), like the v1 `scan`. */
export async function* scanV2(client: ccc.Client, deployment: Deployment, resolver: AssetResolver, options: { includeUnsupported?: boolean; signal?: AbortSignal; onMalformed?: (cell: ccc.Cell, error: unknown) => void; maxCells?: number } = {}): AsyncGenerator<OpenSwapOrderV2> {
  if (options.maxCells !== undefined && (!Number.isSafeInteger(options.maxCells) || options.maxCells < 1)) throw new Error('maxCells must be a positive safe integer');
  options.signal?.throwIfAborted();
  await assertNetwork(client, deployment);
  let count = 0;
  for await (const cell of client.findCellsOnChain({ script: { codeHash: deployment.codeHash, hashType: 'data1', args: '0x' }, scriptType: 'lock', scriptSearchMode: 'prefix', withData: true })) {
    options.signal?.throwIfAborted();
    if (options.maxCells !== undefined && count++ >= options.maxCells) return;
    let order: OpenSwapOrderV2;
    try { order = await parseV2(cell, deployment, resolver); }
    catch (error) { options.onMalformed?.(cell, error); continue; }
    if (order.supported || options.includeUnsupported) yield order;
  }
}
