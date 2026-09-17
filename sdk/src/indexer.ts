import { ccc } from '@ckb-ccc/core';
import type { AssetResolver } from './assets.js';
import { assertNetwork, parse } from './orders.js';
import type { Deployment, OpenSwapOrder } from './types.js';
export async function* scan(client: ccc.Client, deployment: Deployment, resolver: AssetResolver, options: { includeUnsupported?: boolean; signal?: AbortSignal; onMalformed?: (cell: ccc.Cell, error: unknown) => void; maxCells?: number } = {}): AsyncGenerator<OpenSwapOrder> {
  if (options.maxCells !== undefined && (!Number.isSafeInteger(options.maxCells) || options.maxCells < 1)) throw new Error('maxCells must be a positive safe integer');
  options.signal?.throwIfAborted();
  await assertNetwork(client, deployment);
  let count = 0;
  // Exclude speculative local change and stale cached orders from the public book.
  for await (const cell of client.findCellsOnChain({ script: { codeHash: deployment.codeHash, hashType: 'data1', args: '0x' }, scriptType: 'lock', scriptSearchMode: 'prefix', withData: true })) {
    options.signal?.throwIfAborted();
    if (options.maxCells !== undefined && count++ >= options.maxCells) return;
    let order: OpenSwapOrder;
    try { order = await parse(cell, deployment, resolver); }
    catch (error) { options.onMalformed?.(cell, error); continue; }
    if (order.supported || options.includeUnsupported) yield order;
  }
}
