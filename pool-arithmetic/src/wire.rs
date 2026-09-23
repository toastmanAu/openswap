//! Bounded draft ABI codecs. Decoding is not transaction authentication.
use crate::{Operation, Parameters, State, U256};

pub const ARGS_LEN: usize = 38;
pub const STATE_LEN: usize = 190;
pub const ACTION_MAX_LEN: usize = 56;
pub const SCRIPT_MAX_LEN: usize = 512;
pub const WITNESS_MAX_LEN: usize = 4096;
pub const CELL_COUNT_MAX: u32 = 256;
const Y_MAX: u128 = (1 << 112) - 1;
const X_MAX: u128 = (u64::MAX - 1) as u128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Error {
    Bound = 2,
    Malformed = 3,
    Unsupported = 4,
    Identity = 5,
    Lineage = 7,
    Range = 21,
}
type Result<T> = core::result::Result<T, Error>;

fn exact(data: &[u8], size: usize) -> Result<()> {
    if data.len() > size {
        Err(Error::Bound)
    } else if data.len() != size {
        Err(Error::Malformed)
    } else {
        Ok(())
    }
}
fn header(data: &[u8], magic: &[u8; 4]) -> Result<()> {
    if data.len() < 6 || &data[..4] != magic {
        return Err(Error::Malformed);
    }
    if data[4] != 1 {
        return Err(Error::Unsupported);
    }
    Ok(())
}
// All offsets are fixed constants or validated table boundaries. get() keeps
// truncated callers safe even if a later edit moves a read ahead of its guard.
fn read<const N: usize>(data: &[u8], offset: usize) -> Result<[u8; N]> {
    let end = offset.checked_add(N).ok_or(Error::Malformed)?;
    data.get(offset..end)
        .ok_or(Error::Malformed)?
        .try_into()
        .map_err(|_| Error::Malformed)
}
fn u32_at(data: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(read(data, offset)?))
}
fn u128_at(data: &[u8], offset: usize) -> Result<u128> {
    Ok(u128::from_le_bytes(read(data, offset)?))
}
fn positive(value: u128, max: u128) -> Result<()> {
    if value == 0 || value > max {
        Err(Error::Range)
    } else {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Role {
    StateType = 0,
    StateLock = 1,
    CkbLock = 2,
    TokenLock = 3,
    LpType = 4,
}
impl TryFrom<u8> for Role {
    type Error = Error;
    fn try_from(value: u8) -> Result<Self> {
        match value {
            0 => Ok(Self::StateType),
            1 => Ok(Self::StateLock),
            2 => Ok(Self::CkbLock),
            3 => Ok(Self::TokenLock),
            4 => Ok(Self::LpType),
            _ => Err(Error::Unsupported),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Args {
    pub role: Role,
    pub pool_id: [u8; 32],
}
impl Args {
    pub fn decode(data: &[u8]) -> Result<Self> {
        exact(data, ARGS_LEN)?;
        header(data, b"TPL1")?;
        Ok(Self {
            role: Role::try_from(data[5])?,
            pool_id: read(data, 6)?,
        })
    }
    pub fn encode(self) -> [u8; ARGS_LEN] {
        let mut out = [0; ARGS_LEN];
        out[..4].copy_from_slice(b"TPL1");
        out[4] = 1;
        out[5] = self.role as u8;
        out[6..].copy_from_slice(&self.pool_id);
        out
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StateData {
    pub fee: u16,
    pub locked: u128,
    pub shares: u128,
    pub backing_state: u64,
    pub backing_ckb: u64,
    pub backing_token: u64,
    pub rx: u32,
    pub ry: u32,
    pub token_code_hash: [u8; 32],
    pub token_owner: [u8; 32],
}
impl StateData {
    /// Local domains only: does not prove occupied capacity, token support or lineage.
    pub fn validate(self) -> Result<()> {
        if self.fee >= 10000
            || self.locked == 0
            || self.shares < self.locked
            || self.backing_state == 0
            || self.backing_ckb == 0
            || self.backing_ckb == u64::MAX
            || self.backing_token == 0
        {
            return Err(Error::Range);
        }
        if self.rx >= CELL_COUNT_MAX || self.ry >= CELL_COUNT_MAX {
            return Err(Error::Bound);
        }
        if self.rx == self.ry {
            return Err(Error::Lineage);
        }
        Ok(())
    }
    pub fn decode(data: &[u8]) -> Result<Self> {
        exact(data, STATE_LEN)?;
        header(data, b"TPS1")?;
        if data[5] != 0 || data[104] != 2 {
            return Err(Error::Unsupported);
        }
        if data[105] != 32 || data[138..].iter().any(|b| *b != 0) {
            return Err(Error::Malformed);
        }
        let result = Self {
            fee: u16::from_le_bytes(read(data, 6)?),
            locked: u128_at(data, 8)?,
            shares: u128_at(data, 24)?,
            backing_state: u64::from_le_bytes(read(data, 40)?),
            backing_ckb: u64::from_le_bytes(read(data, 48)?),
            backing_token: u64::from_le_bytes(read(data, 56)?),
            rx: u32_at(data, 64)?,
            ry: u32_at(data, 68)?,
            token_code_hash: read(data, 72)?,
            token_owner: read(data, 106)?,
        };
        result.validate()?;
        Ok(result)
    }
    pub fn encode(self) -> Result<[u8; STATE_LEN]> {
        self.validate()?;
        let mut out = [0; STATE_LEN];
        out[..4].copy_from_slice(b"TPS1");
        out[4] = 1;
        out[6..8].copy_from_slice(&self.fee.to_le_bytes());
        out[8..24].copy_from_slice(&self.locked.to_le_bytes());
        out[24..40].copy_from_slice(&self.shares.to_le_bytes());
        out[40..48].copy_from_slice(&self.backing_state.to_le_bytes());
        out[48..56].copy_from_slice(&self.backing_ckb.to_le_bytes());
        out[56..64].copy_from_slice(&self.backing_token.to_le_bytes());
        out[64..68].copy_from_slice(&self.rx.to_le_bytes());
        out[68..72].copy_from_slice(&self.ry.to_le_bytes());
        out[72..104].copy_from_slice(&self.token_code_hash);
        out[104] = 2;
        out[105] = 32;
        out[106..138].copy_from_slice(&self.token_owner);
        Ok(out)
    }
    /// Bind decoded metadata to balances supplied by a future authenticated cell reader.
    pub fn accounting(self, x: u64, y: u128) -> core::result::Result<State, crate::Error> {
        let state = State {
            parameters: Parameters {
                fee: U256::from(self.fee),
                locked: U256::from(self.locked),
                backing_state: U256::from(self.backing_state),
                backing_ckb: U256::from(self.backing_ckb),
                backing_token: U256::from(self.backing_token),
            },
            x: U256::from(x),
            y: U256::from(y),
            shares: U256::from(self.shares),
        };
        state.validate()?;
        Ok(state)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Create {
        minimum: u128,
    },
    Swap {
        x_to_y: bool,
        amount: u128,
        minimum: u128,
    },
    Deposit {
        max_x: u128,
        max_y: u128,
        minimum: u128,
    },
    Withdraw {
        shares: u128,
        min_x: u128,
        min_y: u128,
    },
}
impl Action {
    fn fields(self) -> (u8, [u128; 3], usize) {
        match self {
            Self::Create { minimum } => (0, [minimum, 0, 0], 1),
            Self::Swap {
                x_to_y,
                amount,
                minimum,
            } => (if x_to_y { 1 } else { 2 }, [amount, minimum, 0], 2),
            Self::Deposit {
                max_x,
                max_y,
                minimum,
            } => (3, [max_x, max_y, minimum], 3),
            Self::Withdraw {
                shares,
                min_x,
                min_y,
            } => (4, [shares, min_x, min_y], 3),
        }
    }
    /// State-dependent capacity and slippage constraints are checked by arithmetic.
    pub fn validate(self) -> Result<()> {
        match self {
            Self::Create { minimum } => positive(minimum, u128::MAX),
            Self::Swap {
                x_to_y,
                amount,
                minimum,
            } => {
                positive(amount, if x_to_y { X_MAX } else { Y_MAX })?;
                positive(minimum, if x_to_y { Y_MAX } else { X_MAX })
            }
            Self::Deposit {
                max_x,
                max_y,
                minimum,
            } => {
                positive(max_x, X_MAX)?;
                positive(max_y, Y_MAX)?;
                positive(minimum, u128::MAX)
            }
            Self::Withdraw {
                shares,
                min_x,
                min_y,
            } => {
                positive(shares, u128::MAX)?;
                positive(min_x, X_MAX)?;
                positive(min_y, Y_MAX)
            }
        }
    }
    pub fn decode(data: &[u8]) -> Result<Self> {
        if data.len() > ACTION_MAX_LEN {
            return Err(Error::Bound);
        }
        header(data, b"TPA1")?;
        let count = match data[5] {
            0 => 1,
            1 | 2 => 2,
            3 | 4 => 3,
            _ => return Err(Error::Unsupported),
        };
        // A wrong tag-specific length within the global maximum is malformed.
        if data.len() != 8 + 16 * count {
            return Err(Error::Malformed);
        }
        if data[6..8] != [0, 0] {
            return Err(Error::Malformed);
        }
        let a = u128_at(data, 8)?;
        let result = match data[5] {
            0 => Self::Create { minimum: a },
            1 | 2 => Self::Swap {
                x_to_y: data[5] == 1,
                amount: a,
                minimum: u128_at(data, 24)?,
            },
            3 => Self::Deposit {
                max_x: a,
                max_y: u128_at(data, 24)?,
                minimum: u128_at(data, 40)?,
            },
            4 => Self::Withdraw {
                shares: a,
                min_x: u128_at(data, 24)?,
                min_y: u128_at(data, 40)?,
            },
            _ => return Err(Error::Unsupported),
        };
        result.validate()?;
        Ok(result)
    }
    /// Writes only the returned prefix; callers must not serialize the buffer tail.
    pub fn encode(self, out: &mut [u8; ACTION_MAX_LEN]) -> Result<usize> {
        self.validate()?;
        let (tag, fields, count) = self.fields();
        out.fill(0);
        out[..4].copy_from_slice(b"TPA1");
        out[4] = 1;
        out[5] = tag;
        for (i, field) in fields[..count].iter().enumerate() {
            out[8 + 16 * i..24 + 16 * i].copy_from_slice(&field.to_le_bytes());
        }
        Ok(8 + 16 * count)
    }
    /// Create is intentionally not representable as a normal transition operation.
    pub fn operation(self) -> Result<Operation> {
        self.validate()?;
        Ok(match self {
            Self::Create { .. } => return Err(Error::Unsupported),
            Self::Swap {
                x_to_y,
                amount,
                minimum,
            } => Operation::Swap {
                x_to_y,
                amount: amount.into(),
                minimum: minimum.into(),
            },
            Self::Deposit {
                max_x,
                max_y,
                minimum,
            } => Operation::Deposit {
                max_x: max_x.into(),
                max_y: max_y.into(),
                minimum: minimum.into(),
            },
            Self::Withdraw {
                shares,
                min_x,
                min_y,
            } => Operation::Withdraw {
                shares: shares.into(),
                min_x: min_x.into(),
                min_y: min_y.into(),
            },
        })
    }
}

/// Exact Molecule Bytes: count is payload length, not total serialized length.
fn bytes(data: &[u8]) -> Result<&[u8]> {
    if data.len() < 4 || u32_at(data, 0)? as usize != data.len() - 4 {
        return Err(Error::Malformed);
    }
    Ok(&data[4..])
}
fn table3(data: &[u8], max: usize) -> Result<[&[u8]; 3]> {
    if data.len() > max {
        return Err(Error::Bound);
    }
    if data.len() < 16 || u32_at(data, 0)? as usize != data.len() {
        return Err(Error::Malformed);
    }
    let a = u32_at(data, 4)? as usize;
    let b = u32_at(data, 8)? as usize;
    let c = u32_at(data, 12)? as usize;
    if a != 16 || a > b || b > c || c > data.len() {
        return Err(Error::Malformed);
    }
    Ok([&data[a..b], &data[b..c], &data[c..]])
}
/// Parse a pool-owned Script; this does not establish H, execution role or P.
pub fn decode_pool_script(data: &[u8]) -> Result<([u8; 32], Args)> {
    let [hash, hash_type, args] = table3(data, SCRIPT_MAX_LEN)?;
    if hash.len() != 32 || hash_type.len() != 1 {
        return Err(Error::Malformed);
    }
    if hash_type[0] != 2 {
        return Err(Error::Identity);
    }
    Ok((read(hash, 0)?, Args::decode(bytes(args)?)?))
}
pub fn encode_pool_script(code_hash: [u8; 32], args: Args) -> [u8; 53 + ARGS_LEN] {
    let mut out = [0; 53 + ARGS_LEN];
    out[..4].copy_from_slice(&((53 + ARGS_LEN) as u32).to_le_bytes());
    out[4..8].copy_from_slice(&16u32.to_le_bytes());
    out[8..12].copy_from_slice(&48u32.to_le_bytes());
    out[12..16].copy_from_slice(&49u32.to_le_bytes());
    out[16..48].copy_from_slice(&code_hash);
    out[48] = 2;
    out[49..53].copy_from_slice(&(ARGS_LEN as u32).to_le_bytes());
    out[53..].copy_from_slice(&args.encode());
    out
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Genesis,
    Transition,
}
/// Validate every WitnessArgs BytesOpt, then select the phase-specific action.
/// Absolute witness placement and signature coverage remain caller obligations.
pub fn decode_witness(data: &[u8], phase: Phase) -> Result<Action> {
    let fields = table3(data, WITNESS_MAX_LEN)?;
    let mut decoded = [None; 3];
    for (i, field) in fields.iter().enumerate() {
        if !field.is_empty() {
            decoded[i] = Some(bytes(field)?);
        }
    }
    let selected = if phase == Phase::Genesis { 2 } else { 1 };
    let action = Action::decode(decoded[selected].ok_or(Error::Malformed)?)?;
    if (phase == Phase::Genesis) != matches!(action, Action::Create { .. }) {
        return Err(Error::Unsupported);
    }
    Ok(action)
}
