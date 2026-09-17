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
/** Human-unit input price per one human-unit output, rounded down for display only. */
export function unitPrice(input:bigint,output:bigint,inputDecimals:number,outputDecimals:number):string {
 if(input<=0n||output<=0n)throw new Error('Price requires positive amounts');
 const scaled=input*10n**BigInt(outputDecimals)*100000000n/(output*10n**BigInt(inputDecimals));
 return scaled===0n?'<0.00000001':formatUnits(scaled,8);
}
