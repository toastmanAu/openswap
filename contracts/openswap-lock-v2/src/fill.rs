//! Full or partial fill. Every check below is mirrored, in order, by the
//! TypeScript reference model (sdk/src/v2/model.ts); shared vectors pin both.
use crate::{args::Terms, error::Error, sys, wide};
use ckb_std::{
    ckb_constants::Source::{Input, Output},
    error::SysError,
    high_level::*,
};

pub fn validate(index: usize, running_hash: &[u8; 32], terms: &Terms) -> Result<(), Error> {
    // Offer: UDT carries a non-zero 16-byte amount; CKB carries empty data.
    let offer_type = load_cell_type_hash(index, Input)?;
    let c_in = load_cell_capacity(index, Input)?;
    let amount_in = if offer_type.is_some() {
        let amount = sys::amount(index, Input, Error::OfferDataInvalid)?;
        if amount == 0 {
            return Err(Error::OfferAmountZero);
        }
        if terms.capacity_refund != 0 {
            return Err(Error::CapacityRefundInvalid);
        }
        Some(amount)
    } else {
        if !sys::empty_data(index, Input)? {
            return Err(Error::OfferDataInvalid);
        }
        None
    };
    if offer_type == terms.ask_hash {
        return Err(Error::SameAsset);
    }

    // Payment at the order's own index, to the owner, in the ask asset.
    match load_cell_lock_hash(index, Output) {
        Ok(hash) if hash == terms.owner_hash => (),
        Ok(_) => return Err(Error::PaymentOwnerMismatch),
        Err(SysError::IndexOutOfBound) => return Err(Error::PaymentOutputMissing),
        Err(e) => return Err(e.into()),
    }
    if load_cell_type_hash(index, Output)? != terms.ask_hash {
        return Err(Error::AskAssetMismatch);
    }
    let payment_capacity = load_cell_capacity(index, Output)?;

    // At most one remainder: same lock (identical args), same offer asset.
    let (count, at) = sys::count_outputs(running_hash)?;
    if count > 1 {
        return Err(Error::RemainderDuplicate);
    }
    let remainder = if count == 1 {
        if load_cell_type_hash(at, Output)? != offer_type {
            return Err(Error::RemainderTypeMismatch);
        }
        let amount = if amount_in.is_some() {
            sys::amount(at, Output, Error::RemainderDataInvalid)?
        } else if sys::empty_data(at, Output)? {
            0
        } else {
            return Err(Error::RemainderDataInvalid);
        };
        Some((load_cell_capacity(at, Output)?, amount))
    } else {
        None
    };
    let c_out = remainder.map_or(0, |r| r.0);
    // Capacity leaving the order; it may only go to the maker's payment.
    let leaving = c_in
        .checked_sub(c_out)
        .ok_or(Error::RemainderCapacityInvalid)?;

    // Offer consumed by the taker, and offer left in the remainder.
    let (taken, left) = match amount_in {
        Some(amount) => {
            let rest = remainder.map_or(0, |r| r.1);
            (amount.checked_sub(rest).ok_or(Error::FillZero)?, rest)
        }
        None => {
            let taken = leaving
                .checked_sub(payment_capacity)
                .ok_or(Error::FillZero)?;
            let rest = match remainder {
                Some(_) => c_out
                    .checked_sub(terms.capacity_refund)
                    .ok_or(Error::RemainderBelowMinimum)?,
                None => 0,
            };
            (u128::from(taken), u128::from(rest))
        }
    };
    if taken == 0 {
        return Err(Error::FillZero);
    }

    let paid = match terms.ask_hash {
        None => {
            if !sys::empty_data(index, Output)? {
                return Err(Error::AskDataInvalid);
            }
            u128::from(
                payment_capacity
                    .checked_sub(leaving)
                    .ok_or(Error::PaymentCapacityInvalid)?,
            )
        }
        Some(_) => {
            let paid = sys::amount(index, Output, Error::AskDataInvalid)?;
            let expected = if amount_in.is_some() {
                leaving
            } else {
                terms.capacity_refund
            };
            if payment_capacity != expected {
                return Err(Error::PaymentCapacityInvalid);
            }
            paid
        }
    };
    // paid / taken >= ask_amount / offer_amount, rounding toward the maker.
    if !wide::product_at_least(paid, terms.offer_amount, taken, terms.ask_amount) {
        return Err(Error::AskAmountInsufficient);
    }
    if remainder.is_some() {
        if taken < terms.min_fill {
            return Err(Error::FillBelowMinimum);
        }
        if left < terms.min_fill {
            return Err(Error::RemainderBelowMinimum);
        }
    }
    Ok(())
}
