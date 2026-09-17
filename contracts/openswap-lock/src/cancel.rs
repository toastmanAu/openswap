use crate::{error::Error, sys};
use ckb_std::{
    ckb_constants::Source::{Input, Output},
    error::SysError,
    high_level::*,
};

pub fn is_recovery(index: usize, owner: &[u8; 32]) -> Result<bool, Error> {
    match load_cell_lock_hash(index, Output) {
        Ok(hash) if &hash == owner => (),
        Ok(_) | Err(SysError::IndexOutOfBound) => return Ok(false),
        Err(e) => return Err(e.into()),
    }
    Ok(
        load_cell_type_hash(index, Output)? == load_cell_type_hash(index, Input)?
            && load_cell_data_hash(index, Output)? == load_cell_data_hash(index, Input)?
            && load_cell_capacity(index, Output)? >= load_cell_capacity(index, Input)?,
    )
}

pub fn validate(index: usize, owner: &[u8; 32]) -> Result<(), Error> {
    let mut j = 0;
    loop {
        let hash = match load_cell_lock_hash(j, Input) {
            Ok(hash) => hash,
            Err(SysError::IndexOutOfBound) => return Err(Error::CancelProofMissing),
            Err(e) => return Err(e.into()),
        };
        if j != index
            && &hash == owner
            && load_cell_type_hash(j, Input)?.is_none()
            && sys::empty_data(j, Input)?
        {
            match load_cell_lock_hash(j, Output) {
                Ok(h) if &h == owner => {
                    if load_cell_type_hash(j, Output)?.is_none()
                        && sys::empty_data(j, Output)?
                        && load_cell_capacity(j, Output)? < load_cell_capacity(j, Input)?
                    {
                        return Ok(());
                    }
                }
                Ok(_) | Err(SysError::IndexOutOfBound) => (),
                Err(e) => return Err(e.into()),
            }
        }
        j += 1;
    }
}
