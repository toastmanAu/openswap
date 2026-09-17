// Playground injects these modules; the bundle keeps their imports external.
declare module '@ckb-ccc/ccc' {
  export { ccc } from '@ckb-ccc/shell';
}
declare module '@ckb-ccc/playground' {
  export const signer: import('@ckb-ccc/core').Signer;
  export const client: import('@ckb-ccc/core').Client;
  export function render(value: unknown): Promise<void>;
}
