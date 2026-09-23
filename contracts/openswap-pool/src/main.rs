#![no_std]
#![no_main]

ckb_std::entry!(program_entry);
ckb_std::default_alloc!();

mod validator;

fn program_entry() -> i8 {
    match validator::validate() {
        Ok(()) => 0,
        Err(code) => code,
    }
}
