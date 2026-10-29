#![no_std]
#![no_main]

ckb_std::entry!(program_entry);
ckb_std::default_alloc!();

mod args;
mod cancel;
mod entry;
mod error;
mod expiry;
mod fill;
mod sys;
mod wide;

fn program_entry() -> i8 {
    match entry::validate() {
        Ok(()) => 0,
        Err(error) => error as i8,
    }
}
