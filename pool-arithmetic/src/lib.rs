//! Isolated draft accounting. No CKB syscalls, custody, signing or allocation.
#![no_std]

pub mod wire;

// Upstream macro uses a manual ceil division internally; keep the allowance
// limited to generated dependency code, not our accounting implementation.
#[allow(clippy::manual_div_ceil)]
mod wide {
    uint::construct_uint! { pub struct U256(4); }
}
pub use wide::U256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Error {
    Range = 21,
    Overflow = 22,
    State = 24,
    ZeroOutput = 25,
    Slippage = 26,
    Shares = 27,
}
type Result<T> = core::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Parameters {
    pub fee: U256,
    pub locked: U256,
    pub backing_state: U256,
    pub backing_ckb: U256,
    pub backing_token: U256,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct State {
    pub parameters: Parameters,
    pub x: U256,
    pub y: U256,
    pub shares: U256,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Flows {
    pub paid_x: U256,
    pub paid_y: U256,
    pub received_x: U256,
    pub received_y: U256,
    pub minted: U256,
    pub burned: U256,
    pub unused_x: U256,
    pub unused_y: U256,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub next: State,
    pub flows: Flows,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Swap {
        x_to_y: bool,
        amount: U256,
        minimum: U256,
    },
    Deposit {
        max_x: U256,
        max_y: U256,
        minimum: U256,
    },
    Withdraw {
        shares: U256,
        min_x: U256,
        min_y: U256,
    },
}
fn max(bits: usize) -> U256 {
    (U256::one() << bits) - U256::one()
}
fn range(n: U256, lo: U256, hi: U256) -> Result<()> {
    if n < lo || n > hi {
        Err(Error::Range)
    } else {
        Ok(())
    }
}
fn positive(n: U256, hi: U256) -> Result<()> {
    range(n, U256::one(), hi)
}
fn add(a: U256, b: U256) -> Result<U256> {
    a.checked_add(b).ok_or(Error::Overflow)
}
fn mul(a: U256, b: U256) -> Result<U256> {
    a.checked_mul(b).ok_or(Error::Overflow)
}
fn ceil(a: U256, b: U256) -> U256 {
    a / b + U256::from(u8::from(!(a % b).is_zero()))
}
impl Parameters {
    pub fn validate(self) -> Result<()> {
        range(self.fee, U256::zero(), U256::from(9999))?;
        positive(self.locked, max(128))?;
        positive(self.backing_state, max(64))?;
        positive(self.backing_ckb, max(64) - U256::one())?;
        positive(self.backing_token, max(64))
    }
    fn max_x(self) -> U256 {
        max(64) - self.backing_ckb
    }
}
impl State {
    pub fn validate(self) -> Result<()> {
        self.parameters.validate()?;
        positive(self.x, self.parameters.max_x())?;
        positive(self.y, max(112))?;
        range(self.shares, self.parameters.locked, max(128))?;
        if mul(self.shares, self.shares)? > mul(self.x, self.y)? {
            return Err(Error::State);
        }
        Ok(())
    }
}
/// Binary search with division; never squares an overflowing candidate.
pub fn sqrt_floor(n: U256) -> U256 {
    let mut lo = U256::zero();
    let mut hi = U256::one() << 128;
    while hi - lo > U256::one() {
        let mid = lo + (hi - lo) / U256::from(2);
        if mid <= n / mid {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}
fn finish(next: State, flows: Flows) -> Result<Outcome> {
    next.validate()?;
    Ok(Outcome { next, flows })
}
pub fn create(p: Parameters, x: U256, y: U256, minimum: U256) -> Result<Outcome> {
    p.validate()?;
    positive(x, p.max_x())?;
    positive(y, max(112))?;
    positive(minimum, max(128))?;
    let shares = sqrt_floor(mul(x, y)?);
    if shares <= p.locked {
        return Err(Error::Shares);
    }
    let minted = shares - p.locked;
    if minted < minimum {
        return Err(Error::Slippage);
    }
    finish(
        State {
            parameters: p,
            x,
            y,
            shares,
        },
        Flows {
            paid_x: x,
            paid_y: y,
            minted,
            ..Flows::default()
        },
    )
}
pub fn transition(s: State, op: Operation) -> Result<Outcome> {
    s.validate()?;
    let mut next = s;
    let mut flows = Flows::default();
    match op {
        Operation::Swap {
            x_to_y,
            amount,
            minimum,
        } => {
            let (input, output, input_max, output_max) = if x_to_y {
                (s.x, s.y, s.parameters.max_x(), max(112))
            } else {
                (s.y, s.x, max(112), s.parameters.max_x())
            };
            positive(amount, input_max)?;
            positive(minimum, output_max)?;
            let updated = add(input, amount)?;
            positive(updated, input_max)?;
            let effective = mul(amount, U256::from(10000) - s.parameters.fee)?;
            let out = mul(effective, output)? / add(mul(input, U256::from(10000))?, effective)?;
            if out.is_zero() || out >= output {
                return Err(Error::ZeroOutput);
            }
            if out < minimum {
                return Err(Error::Slippage);
            }
            if x_to_y {
                next.x = updated;
                next.y -= out;
                flows.paid_x = amount;
                flows.received_y = out;
            } else {
                next.y = updated;
                next.x -= out;
                flows.paid_y = amount;
                flows.received_x = out;
            }
        }
        Operation::Deposit {
            max_x,
            max_y,
            minimum,
        } => {
            positive(max_x, s.parameters.max_x())?;
            positive(max_y, max(112))?;
            positive(minimum, max(128))?;
            let minted = core::cmp::min(mul(max_x, s.shares)? / s.x, mul(max_y, s.shares)? / s.y);
            if minted.is_zero() {
                return Err(Error::Shares);
            }
            if minted < minimum {
                return Err(Error::Slippage);
            }
            let paid_x = ceil(mul(minted, s.x)?, s.shares);
            let paid_y = ceil(mul(minted, s.y)?, s.shares);
            if paid_x > max_x || paid_y > max_y {
                return Err(Error::State);
            }
            next.x = add(s.x, paid_x)?;
            next.y = add(s.y, paid_y)?;
            next.shares = add(s.shares, minted)?;
            flows = Flows {
                paid_x,
                paid_y,
                minted,
                unused_x: max_x - paid_x,
                unused_y: max_y - paid_y,
                ..flows
            };
        }
        Operation::Withdraw {
            shares,
            min_x,
            min_y,
        } => {
            positive(shares, max(128))?;
            positive(min_x, s.parameters.max_x())?;
            positive(min_y, max(112))?;
            if shares > s.shares - s.parameters.locked {
                return Err(Error::Shares);
            }
            let received_x = mul(shares, s.x)? / s.shares;
            let received_y = mul(shares, s.y)? / s.shares;
            if received_x.is_zero() || received_y.is_zero() {
                return Err(Error::ZeroOutput);
            }
            if received_x < min_x || received_y < min_y {
                return Err(Error::Slippage);
            }
            next.x -= received_x;
            next.y -= received_y;
            next.shares -= shares;
            flows = Flows {
                received_x,
                received_y,
                burned: shares,
                ..flows
            };
        }
    }
    finish(next, flows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wide_boundaries() {
        assert_eq!(add(U256::MAX, U256::one()), Err(Error::Overflow));
        assert_eq!(
            mul(U256::one() << 128, U256::one() << 128),
            Err(Error::Overflow)
        );
        for n in [
            U256::zero(),
            U256::one(),
            U256::from(2),
            U256::from(16),
            U256::MAX,
        ] {
            let r = sqrt_floor(n);
            assert!(r * r <= n);
            let above = r + U256::one();
            assert!(above > n / above);
        }
    }
}
