/** Exact decimal conversion; no floating point token amounts. */
export function parseUnits(value:string,decimals:number):bigint {
 const match=/^(\d+)(?:\.(\d*))?$/.exec(value.trim());
 if(!match || (match[2]?.length??0)>decimals)throw new Error(`Enter an amount with at most ${decimals} decimal places`);
 const amount=BigInt(match[1]!)*10n**BigInt(decimals)+BigInt((match[2]??'').padEnd(decimals,'0')||'0');
 if(amount<=0n)throw new Error('Enter an amount greater than zero');return amount;
}
export function formatUnits(amount:bigint,decimals:number):string {
 const sign=amount<0n?'-':'';const digits=(amount<0n?-amount:amount).toString().padStart(decimals+1,'0');
 if(!decimals)return sign+digits;
 const fraction=digits.slice(-decimals).replace(/0+$/,'');return sign+digits.slice(0,-decimals)+(fraction?'.'+fraction:'');
}
