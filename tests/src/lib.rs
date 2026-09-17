#[cfg(test)]
mod consensus;
#[cfg(test)]
#[path = "../../contracts/openswap-lock/src/error.rs"]
mod error;
#[cfg(test)]
mod fixture;
#[cfg(test)]
mod owner;
#[cfg(test)]
mod vectors;
#[cfg(test)]
#[allow(dead_code)]
#[path = "../../contracts/openswap-lock/src/args.rs"]
mod wire_parser;
#[cfg(test)]
mod xudt;
