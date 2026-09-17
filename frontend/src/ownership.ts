import {ccc} from '@ckb-ccc/core';
import type {OpenSwapOrder} from '@openswap/sdk';
export function isOwnOrder(order:Pick<OpenSwapOrder,'ownerLock'>,locks:readonly ccc.Script[]):boolean {
 return locks.some(lock=>lock.eq(order.ownerLock));
}
/** Wallet containers can expose the same CKB account. Compare scripts, not wallet names. */
export async function assertExternalFill(wallet:Pick<ccc.Signer,'getAddressObjs'>,orders:readonly Pick<OpenSwapOrder,'ownerLock'>[]):Promise<void> {
 const locks=(await wallet.getAddressObjs()).map(a=>a.script);
 if(orders.some(order=>isOwnOrder(order,locks)))throw new Error('This order belongs to the connected CKB account. Filling it would pay the tokens back to yourself. Use Cancel to recover your order, or connect a different CKB account to trade.');
}
