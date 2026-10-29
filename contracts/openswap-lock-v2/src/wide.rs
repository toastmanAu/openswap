//! a*b >= c*d for u128 operands without a big-integer dependency.

/// Full 256-bit product as (high, low).
fn mul(a: u128, b: u128) -> (u128, u128) {
    const M: u128 = u64::MAX as u128;
    let (a1, a0, b1, b0) = (a >> 64, a & M, b >> 64, b & M);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    // Middle column sum fits in 66 bits after splitting.
    let middle = (p00 >> 64) + (p01 & M) + (p10 & M);
    let low = (p00 & M) | (middle << 64);
    let high = p11 + (p01 >> 64) + (p10 >> 64) + (middle >> 64);
    (high, low)
}

pub fn product_at_least(a: u128, b: u128, c: u128, d: u128) -> bool {
    mul(a, b) >= mul(c, d)
}
