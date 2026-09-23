//! Draft shared-role validator. All untrusted variable-size reads are bounded.
use ckb_hash::{blake2b_256, new_blake2b};
use ckb_std::ckb_types::prelude::*;
use ckb_std::{
    ckb_constants::{CellField, Source},
    error::SysError,
    high_level as hl, syscalls,
};
use openswap_pool_arithmetic::{
    Outcome, State, U256, create, transition,
    wire::{self, Action, Args, Phase, Role, StateData},
};

type Result<T> = core::result::Result<T, i8>;
const SYSCALL: i8 = 1;
const BOUND: i8 = 2;
const IDENTITY: i8 = 5;
const GENESIS: i8 = 6;
const LINEAGE: i8 = 7;
const IMMUTABLE: i8 = 8;
const CELL: i8 = 9;
const SUPPLY: i8 = 10;
const TRANSITION: i8 = 29;

// Local VM fixture profile only. SHA256/CKB hash verified by verify-fixtures.py.
const XUDT_HASH: [u8; 32] = [
    0x50, 0xbd, 0x8d, 0x66, 0x80, 0xb8, 0xb9, 0xcf, 0x98, 0xb7, 0x3f, 0x3c, 0x08, 0xfa, 0xf8, 0xb2,
    0xa2, 0x19, 0x14, 0x31, 0x19, 0x54, 0x11, 0x8a, 0xd6, 0x60, 0x9b, 0xe6, 0xe7, 0x8a, 0x1b, 0x95,
];
fn syscall(e: SysError) -> i8 {
    if matches!(e, SysError::LengthNotEnough(_)) {
        BOUND
    } else {
        SYSCALL
    }
}
fn hash_script(index: usize, source: Source, field: CellField) -> Result<Option<[u8; 32]>> {
    let mut buffer = [0; wire::SCRIPT_MAX_LEN];
    match syscalls::load_cell_by_field(&mut buffer, 0, index, source, field) {
        Ok(n) => Ok(Some(blake2b_256(&buffer[..n]))),
        Err(SysError::ItemMissing) if field == CellField::Type => Ok(None),
        Err(e) => Err(syscall(e)),
    }
}
fn data<const N: usize>(index: usize, source: Source) -> Result<[u8; N]> {
    let mut value = [0; N];
    match syscalls::load_cell_data(&mut value, 0, index, source) {
        Ok(n) if n == N => Ok(value),
        Ok(_) | Err(SysError::LengthNotEnough(_)) => Err(CELL),
        Err(e) => Err(syscall(e)),
    }
}
#[derive(Default)]
struct Scan {
    state: Option<usize>,
    lp: U256,
    locks: [u16; 3],
    count: usize,
}
fn scan(source: Source, hashes: &[[u8; 32]; 5]) -> Result<Scan> {
    let mut result = Scan::default();
    for i in 0..=wire::CELL_COUNT_MAX as usize {
        match hl::load_cell_capacity(i, source) {
            Err(SysError::IndexOutOfBound) => return Ok(result),
            Err(e) => return Err(syscall(e)),
            Ok(_) if i == wire::CELL_COUNT_MAX as usize => return Err(BOUND),
            Ok(_) => (),
        }
        result.count += 1;
        let lock = hash_script(i, source, CellField::Lock)?.ok_or(CELL)?;
        let type_ = hash_script(i, source, CellField::Type)?;
        if lock == hashes[0] || lock == hashes[4] || hashes[1..4].iter().any(|h| Some(*h) == type_)
        {
            return Err(IDENTITY);
        }
        for (role, hash) in hashes[1..4].iter().enumerate() {
            if *hash == lock {
                result.locks[role] += 1;
            }
        }
        if type_ == Some(hashes[0]) && result.state.replace(i).is_some() {
            return Err(LINEAGE);
        }
        if type_ == Some(hashes[4]) {
            let amount = u128::from_le_bytes(data::<16>(i, source)?);
            result.lp = result.lp.checked_add(U256::from(amount)).ok_or(SUPPLY)?;
            if result.lp > U256::from(u128::MAX) {
                return Err(SUPPLY);
            }
        }
    }
    Err(BOUND)
}
fn state_data(index: usize, source: Source) -> Result<StateData> {
    StateData::decode(&data::<{ wire::STATE_LEN }>(index, source)?).map_err(|e| e as i8)
}
fn token_hash(s: StateData, hashes: &[[u8; 32]; 5]) -> Result<[u8; 32]> {
    if s.token_code_hash != XUDT_HASH || hashes[1..4].contains(&s.token_owner) {
        return Err(IDENTITY);
    }
    // Canonical Script with the profile's 32-byte args, Data1 and pinned code.
    let mut script = [0; 85];
    for (i, value) in [85u32, 16, 48, 49].iter().enumerate() {
        script[i * 4..i * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    script[16..48].copy_from_slice(&s.token_code_hash);
    script[48] = 2;
    script[49..53].copy_from_slice(&32u32.to_le_bytes());
    script[53..].copy_from_slice(&s.token_owner);
    Ok(blake2b_256(script))
}
fn shape(
    index: usize,
    source: Source,
    lock: [u8; 32],
    type_: Option<[u8; 32]>,
    backing: u64,
) -> Result<u64> {
    if hash_script(index, source, CellField::Lock)? != Some(lock)
        || hash_script(index, source, CellField::Type)? != type_
    {
        return Err(CELL);
    }
    let capacity = hl::load_cell_capacity(index, source).map_err(syscall)?;
    if backing < hl::load_cell_occupied_capacity(index, source).map_err(syscall)? {
        return Err(CELL);
    }
    Ok(capacity)
}
fn balances(
    s: StateData,
    si: usize,
    xi: usize,
    yi: usize,
    source: Source,
    hashes: &[[u8; 32]; 5],
) -> Result<State> {
    if si == xi || si == yi || xi == yi {
        return Err(LINEAGE);
    }
    let token = token_hash(s, hashes)?;
    if shape(si, source, hashes[1], Some(hashes[0]), s.backing_state)? != s.backing_state {
        return Err(CELL);
    }
    let xc = shape(xi, source, hashes[2], None, s.backing_ckb)?;
    data::<0>(xi, source)?;
    if shape(yi, source, hashes[3], Some(token), s.backing_token)? != s.backing_token {
        return Err(CELL);
    }
    let y = u128::from_le_bytes(data::<16>(yi, source)?);
    let x = xc.checked_sub(s.backing_ckb).ok_or(CELL)?;
    s.accounting(x, y).map_err(|e| e as i8)
}
fn action(index: usize, phase: Phase) -> Result<Action> {
    let mut buffer = [0; wire::WITNESS_MAX_LEN];
    let n = syscalls::load_witness(&mut buffer, 0, index, Source::Input).map_err(syscall)?;
    wire::decode_witness(&buffer[..n], phase).map_err(|e| e as i8)
}
fn sibling_inputs(si: usize, s: StateData, count: usize) -> Result<(usize, usize)> {
    let point = hl::load_input_out_point(si, Source::Input).map_err(syscall)?;
    let raw = point.as_slice();
    let own = u32::from_le_bytes(raw[32..36].try_into().map_err(|_| LINEAGE)?);
    if own >= wire::CELL_COUNT_MAX || own == s.rx || own == s.ry {
        return Err(LINEAGE);
    }
    let mut x = None;
    let mut y = None;
    for i in 0..count {
        let candidate = hl::load_input_out_point(i, Source::Input).map_err(syscall)?;
        let c = candidate.as_slice();
        if c[..32] != raw[..32] {
            continue;
        }
        let index = u32::from_le_bytes(c[32..36].try_into().map_err(|_| LINEAGE)?);
        if index == s.rx && x.replace(i).is_some() {
            return Err(LINEAGE);
        }
        if index == s.ry && y.replace(i).is_some() {
            return Err(LINEAGE);
        }
    }
    Ok((x.ok_or(LINEAGE)?, y.ok_or(LINEAGE)?))
}
fn check_supply(
    input: &Scan,
    output: &Scan,
    before: Option<State>,
    after: State,
    r: Outcome,
) -> Result<()> {
    let circulating = |s: State| s.shares - s.parameters.locked;
    if input.lp > before.map(circulating).unwrap_or_default() || output.lp > circulating(after) {
        return Err(SUPPLY);
    }
    let available = input.lp.checked_add(r.flows.minted).ok_or(SUPPLY)?;
    if available.checked_sub(r.flows.burned) != Some(output.lp) {
        return Err(SUPPLY);
    }
    Ok(())
}
pub fn validate() -> Result<()> {
    let mut running = [0; wire::SCRIPT_MAX_LEN];
    let n = syscalls::load_script(&mut running, 0).map_err(syscall)?;
    let (code, args) = wire::decode_pool_script(&running[..n]).map_err(|e| e as i8)?;
    let roles = [
        Role::StateType,
        Role::StateLock,
        Role::CkbLock,
        Role::TokenLock,
        Role::LpType,
    ];
    let hashes = roles.map(|role| {
        blake2b_256(wire::encode_pool_script(
            code,
            Args {
                role,
                pool_id: args.pool_id,
            },
        ))
    });
    let input = scan(Source::Input, &hashes)?;
    let output = scan(Source::Output, &hashes)?;
    if input.state.is_none() && output.state.is_none() {
        if args.role != Role::LpType || input.lp != output.lp {
            return Err(SUPPLY);
        }
        return Ok(());
    }
    let oi = output.state.ok_or(LINEAGE)?;
    let after_data = state_data(oi, Source::Output)?;
    if after_data.rx as usize >= output.count || after_data.ry as usize >= output.count {
        return Err(LINEAGE);
    }
    let after = balances(
        after_data,
        oi,
        after_data.rx as usize,
        after_data.ry as usize,
        Source::Output,
        &hashes,
    )?;
    let (before, result) = if let Some(ii) = input.state {
        if input.locks != [1, 1, 1] {
            return Err(LINEAGE);
        }
        let before_data = state_data(ii, Source::Input)?;
        let mut immutable = after_data;
        immutable.shares = before_data.shares;
        immutable.rx = before_data.rx;
        immutable.ry = before_data.ry;
        if immutable != before_data {
            return Err(IMMUTABLE);
        }
        let (xi, yi) = sibling_inputs(ii, before_data, input.count)?;
        let before = balances(before_data, ii, xi, yi, Source::Input, &hashes)?;
        let operation = action(ii, Phase::Transition)?
            .operation()
            .map_err(|e| e as i8)?;
        (
            Some(before),
            transition(before, operation).map_err(|e| e as i8)?,
        )
    } else {
        if input.locks != [0, 0, 0] || !input.lp.is_zero() || input.count == 0 {
            return Err(GENESIS);
        }
        let mut first = [0; 44];
        if syscalls::load_input(&mut first, 0, 0, Source::Input).map_err(syscall)? != 44 {
            return Err(GENESIS);
        }
        let mut hasher = new_blake2b();
        hasher.update(&first);
        hasher.update(&(oi as u64).to_le_bytes());
        let mut id = [0; 32];
        hasher.finalize(&mut id);
        if id != args.pool_id {
            return Err(GENESIS);
        }
        let Action::Create { minimum } = action(oi, Phase::Genesis)? else {
            return Err(GENESIS);
        };
        (
            None,
            create(after.parameters, after.x, after.y, U256::from(minimum)).map_err(|e| e as i8)?,
        )
    };
    if result.next != after {
        return Err(TRANSITION);
    }
    check_supply(&input, &output, before, after, result)
}
