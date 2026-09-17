use crate::{args::Terms, error::Error, sys};
use ckb_std::{ckb_constants::Source::Input, high_level::*};

pub fn validate_offer(index: usize, terms: &Terms) -> Result<(), Error> {
    let asset = load_cell_type_hash(index, Input)?;
    let capacity = load_cell_capacity(index, Input)?;
    if asset.is_some() {
        if sys::amount(index, Input, Error::OfferDataInvalid)? == 0 {
            return Err(Error::OfferAmountZero);
        }
        if terms.capacity_refund != capacity {
            return Err(Error::CapacityRefundInvalid);
        }
    } else {
        if !sys::empty_data(index, Input)? {
            return Err(Error::OfferDataInvalid);
        }
        if terms.capacity_refund < load_cell_occupied_capacity(index, Input)?
            || terms.capacity_refund >= capacity
        {
            return Err(Error::CapacityRefundInvalid);
        }
    }
    if asset == terms.ask_hash {
        return Err(Error::SameAsset);
    }
    Ok(())
}
