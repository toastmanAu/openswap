use crate::error::Error;
use ckb_std::ckb_types::{packed::ScriptReader, prelude::*};

pub const MAX_OWNER_SCRIPT_BYTES: usize = 1024;
pub const MAX_ASK_SCRIPT_BYTES: usize = 1024;
pub const FIXED_TAIL: usize = 88;

/// CKB `since`: bit 63 relative, bits 61..62 metric, bits 56..60 reserved.
pub const SINCE_FLAGS: u64 = 0xff00_0000_0000_0000;
pub const SINCE_ABSOLUTE_TIMESTAMP: u64 = 0x4000_0000_0000_0000;

pub struct Owner<'a> {
    pub script: ScriptReader<'a>,
    pub end: usize,
}

pub struct Terms {
    pub owner_hash: [u8; 32],
    pub capacity_refund: u64,
    /// 0 = none, else an absolute timestamp `since`.
    pub expiry: u64,
    pub ask_hash: Option<[u8; 32]>,
    pub ask_amount: u128,
    pub offer_amount: u128,
    pub min_fill: u128,
}

fn le<const N: usize>(bytes: &[u8], offset: usize) -> Result<[u8; N], Error> {
    bytes
        .get(offset..offset + N)
        .and_then(|s| s.try_into().ok())
        .ok_or(Error::ArgsTooShort)
}

pub fn owner_prefix(args: &[u8]) -> Result<Owner<'_>, Error> {
    let end = u32::from_le_bytes(le(args, 0)?) as usize;
    if end > MAX_OWNER_SCRIPT_BYTES {
        return Err(Error::OwnerScriptTooLarge);
    }
    let bytes = args.get(..end).ok_or(Error::OwnerScriptInvalid)?;
    let script = ScriptReader::from_slice(bytes).map_err(|_| Error::OwnerScriptInvalid)?;
    Ok(Owner { script, end })
}

pub fn terms(args: &[u8], owner: &Owner<'_>) -> Result<Terms, Error> {
    let tail = args.get(owner.end..).ok_or(Error::ArgsTooShort)?;
    if tail.len() < FIXED_TAIL {
        return Err(Error::ArgsTooShort);
    }
    if tail[0] != 2 {
        return Err(Error::UnsupportedVersion);
    }
    if tail[1] != 0 {
        return Err(Error::UnsupportedFlags);
    }
    if tail[2..4] != [0, 0] {
        return Err(Error::ReservedNonZero);
    }
    if tail[4..20] == [0; 16] {
        return Err(Error::NonceZero);
    }
    let capacity_refund = u64::from_le_bytes(le(tail, 20)?);
    let expiry = u64::from_le_bytes(le(tail, 28)?);
    if expiry != 0
        && (expiry & SINCE_FLAGS != SINCE_ABSOLUTE_TIMESTAMP || expiry & !SINCE_FLAGS == 0)
    {
        return Err(Error::ExpiryInvalid);
    }
    let ask_size = u32::from_le_bytes(le(tail, 36)?) as usize;
    if ask_size > MAX_ASK_SCRIPT_BYTES {
        return Err(Error::AskScriptTooLarge);
    }
    if tail.len() != FIXED_TAIL + ask_size {
        return Err(Error::ArgsLengthInvalid);
    }
    let ask_hash = if ask_size == 0 {
        None
    } else {
        let script = ScriptReader::from_slice(&tail[40..40 + ask_size])
            .map_err(|_| Error::AskScriptInvalid)?;
        Some(script.calc_script_hash().unpack())
    };
    let at = 40 + ask_size;
    let ask_amount = u128::from_le_bytes(le(tail, at)?);
    let offer_amount = u128::from_le_bytes(le(tail, at + 16)?);
    let min_fill = u128::from_le_bytes(le(tail, at + 32)?);
    if ask_amount == 0 {
        return Err(Error::AskAmountZero);
    }
    if offer_amount == 0 {
        return Err(Error::OfferTermZero);
    }
    if min_fill == 0 || min_fill > offer_amount {
        return Err(Error::MinFillInvalid);
    }
    Ok(Terms {
        owner_hash: owner.script.calc_script_hash().unpack(),
        capacity_refund,
        expiry,
        ask_hash,
        ask_amount,
        offer_amount,
        min_fill,
    })
}
