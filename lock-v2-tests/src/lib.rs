#[cfg(test)]
#[path = "../../tests/src/campaign.rs"]
#[allow(dead_code)]
mod campaign;
#[cfg(test)]
#[path = "../../contracts/openswap-lock-v2/src/error.rs"]
mod error;
#[cfg(test)]
mod fixture;
#[cfg(test)]
mod paths;
#[cfg(test)]
mod sdk;
#[cfg(test)]
mod vectors;
#[cfg(test)]
#[path = "../../contracts/openswap-lock-v2/src/wide.rs"]
mod wide;
#[cfg(test)]
#[allow(dead_code)]
#[path = "../../contracts/openswap-lock-v2/src/args.rs"]
mod wire_parser;
