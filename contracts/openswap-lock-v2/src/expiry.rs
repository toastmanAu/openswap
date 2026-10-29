use crate::{
    args::{SINCE_ABSOLUTE_TIMESTAMP, SINCE_FLAGS, Terms},
    error::Error,
    sys,
};
use ckb_std::{ckb_constants::Source::Input, high_level::load_input_since};

/// Permissionless return after expiry. The recovery output was already checked;
/// consensus enforces the order input's absolute `since`, so time has passed.
pub fn validate(index: usize, running_hash: &[u8; 32], terms: &Terms) -> Result<(), Error> {
    if terms.expiry == 0 {
        return Err(Error::CancelProofMissing);
    }
    let since = load_input_since(index, Input)?;
    if since & SINCE_FLAGS != SINCE_ABSOLUTE_TIMESTAMP
        || since & !SINCE_FLAGS < terms.expiry & !SINCE_FLAGS
    {
        return Err(Error::ExpiryNotReached);
    }
    if sys::count_outputs(running_hash)?.0 != 0 {
        return Err(Error::OrderRecreated);
    }
    Ok(())
}
