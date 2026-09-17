export function explainError(error:unknown):string{
 const raw=error instanceof Error?error.message:String(error);
 if(/No whole-lot route/.test(raw))return 'No available swap meets this amount and maximum payment. Try a smaller amount, reverse the tokens, or place an order.';
 if(/Input spent|order spent|no longer live|Quote is stale/.test(raw))return 'This order or a funding cell was already spent. Refresh the orders and prepare a new quote. Nothing has been signed by this attempt.';
 if(/user.*(reject|cancel)|(reject|cancel).*user|request rejected/i.test(raw))return 'Wallet request cancelled. You can review and try again when ready.';
 if(/Insufficient.*capacity|not enough.*capacity|Unable to.*capacity/i.test(raw))return 'Not enough available CKB for this transaction and its storage reserve. Check the connected account and keep some CKB outside token cells and open orders.';
 if(/fetch failed|Failed to fetch|NetworkError|network request|timeout/i.test(raw))return 'The node or indexer did not respond. Check your connection or change endpoints in Settings, then refresh. Check Activity before retrying any submission.';
 return raw;
}
