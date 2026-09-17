use crate::{args, cancel, error::Error, settle, sys};
use ckb_std::{
    ckb_types::{packed::ScriptReader, prelude::*},
    high_level::load_script_hash,
};

pub fn validate() -> Result<(), Error> {
    let mut buffer = [0; sys::MAX_RUNNING_SCRIPT_BYTES];
    let size = sys::running_script(&mut buffer)?;
    let running = ScriptReader::from_slice(&buffer[..size]).map_err(|_| Error::Encoding)?;
    let index = sys::order_index()?;
    let args = running.args().raw_data();
    let owner = args::owner_prefix(args)?;
    let owner_hash = owner.script.calc_script_hash().unpack();
    let running_hash = load_script_hash()?;
    if owner_hash == running_hash {
        return Err(Error::SelfOwnerLock);
    }
    if cancel::is_recovery(index, &owner_hash)? {
        return cancel::validate(index, &owner_hash);
    }
    settle::validate(index, &running_hash, &args::terms(args, &owner)?)
}
