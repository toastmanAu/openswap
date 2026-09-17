use crate::{args::Terms, asset, error::Error, sys};
use ckb_std::{ckb_constants::Source::Output, error::SysError, high_level::*};

pub fn validate(index: usize, running_hash: &[u8; 32], terms: &Terms) -> Result<(), Error> {
    asset::validate_offer(index, terms)?;
    let owner = match load_cell_lock_hash(index, Output) {
        Ok(hash) => hash,
        Err(SysError::IndexOutOfBound) => return Err(Error::PaymentOutputMissing),
        Err(e) => return Err(e.into()),
    };
    if owner != terms.owner_hash {
        return Err(Error::PaymentOwnerMismatch);
    }
    if load_cell_type_hash(index, Output)? != terms.ask_hash {
        return Err(Error::AskAssetMismatch);
    }
    let capacity = load_cell_capacity(index, Output)?;
    if terms.ask_hash.is_some() {
        if sys::amount(index, Output, Error::AskDataInvalid)? < terms.ask_amount {
            return Err(Error::AskAmountInsufficient);
        }
        if capacity != terms.capacity_refund {
            return Err(Error::PaymentCapacityInvalid);
        }
    } else {
        if !sys::empty_data(index, Output)? {
            return Err(Error::AskDataInvalid);
        }
        // checked_add also rejects u128 overflow from hostile ask amounts.
        let required = terms
            .ask_amount
            .checked_add(u128::from(terms.capacity_refund))
            .filter(|n| *n <= u128::from(u64::MAX))
            .ok_or(Error::CkbAskUnrepresentable)?;
        if u128::from(capacity) < required {
            return Err(Error::PaymentCapacityInvalid);
        }
    }
    let mut j = 0;
    loop {
        match load_cell_lock_hash(j, Output) {
            Ok(hash) if &hash == running_hash => return Err(Error::OrderRecreated),
            Ok(_) => j += 1,
            Err(SysError::IndexOutOfBound) => return Ok(()),
            Err(e) => return Err(e.into()),
        }
    }
}
