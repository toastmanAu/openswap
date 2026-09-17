//! Only fixed-buffer data/script reads. Fixed-size high-level field helpers are safe.
use crate::error::Error;
use ckb_std::{ckb_constants::Source, error::SysError, high_level, syscalls};

pub const MAX_RUNNING_SCRIPT_BYTES: usize = 4096;

pub fn running_script(buffer: &mut [u8; MAX_RUNNING_SCRIPT_BYTES]) -> Result<usize, Error> {
    match syscalls::load_script(buffer, 0) {
        Ok(n) => Ok(n),
        Err(SysError::LengthNotEnough(_)) => Err(Error::ScriptTooLarge),
        Err(e) => Err(e.into()),
    }
}

pub fn empty_data(index: usize, source: Source) -> Result<bool, Error> {
    match syscalls::load_cell_data(&mut [0; 1], 0, index, source) {
        Ok(n) => Ok(n == 0),
        Err(SysError::LengthNotEnough(_)) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

pub fn amount(index: usize, source: Source, invalid: Error) -> Result<u128, Error> {
    let mut bytes = [0; 16];
    match syscalls::load_cell_data(&mut bytes, 0, index, source) {
        Ok(16) => Ok(u128::from_le_bytes(bytes)),
        Ok(_) | Err(SysError::LengthNotEnough(_)) => Err(invalid),
        Err(e) => Err(e.into()),
    }
}

pub fn order_index() -> Result<usize, Error> {
    let point = high_level::load_input_out_point(0, Source::GroupInput)?;
    match high_level::load_input_out_point(1, Source::GroupInput) {
        Err(SysError::IndexOutOfBound) => (),
        Ok(_) => return Err(Error::InvalidGroupInputCount),
        Err(e) => return Err(e.into()),
    }
    let mut index = 0;
    loop {
        match high_level::load_input_out_point(index, Source::Input) {
            Ok(p) if p == point => return Ok(index),
            Ok(_) => index += 1,
            Err(SysError::IndexOutOfBound) => return Err(Error::InputIndexNotFound),
            Err(e) => return Err(e.into()),
        }
    }
}
