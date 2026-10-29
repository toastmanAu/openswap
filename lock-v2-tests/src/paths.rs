use crate::fixture::*;
use ckb_testtool::ckb_types::{bytes::Bytes, packed::*, prelude::*};
use openswap_pool_arithmetic::U256;

const EXPIRY: u64 = 0x4000_0000_0000_0000 | 1_793_000_000;
const UNIT: u128 = 100;

fn amount(n: u128) -> Bytes {
    n.to_le_bytes().to_vec().into()
}

/// UDT `a` offered for CKB: 1,000 units at 1 CKB each, min fill 100.
struct Order {
    env: Env,
    args: Vec<u8>,
    lock: Script,
}
impl Order {
    fn new(expiry: u64) -> Self {
        let mut env = Env::new();
        let args = args(
            &env.owner,
            &Terms {
                refund: 0,
                expiry,
                ask: None,
                ask_amount: 1000 * CKB as u128,
                offer_amount: 10 * UNIT * 100,
                min_fill: UNIT,
                nonce: 1,
            },
        );
        let lock = env.lock(args.clone());
        Self { env, args, lock }
    }
    fn cell(&self, capacity: u64) -> CellOutput {
        cell(&self.lock, Some(&self.env.a), capacity)
    }
    fn input(&mut self, units: u128, since: u64) -> CellInput {
        let c = self.cell(400 * CKB);
        self.env.input(c, amount(units), since)
    }
    fn recovery(&self, units: u128) -> (CellOutput, Bytes) {
        (
            cell(&self.env.owner, Some(&self.env.a), 400 * CKB),
            amount(units),
        )
    }
    fn proof(&mut self) -> (CellInput, (CellOutput, Bytes)) {
        let owner = self.env.owner.clone();
        let input = self
            .env
            .input(cell(&owner, None, 100 * CKB), Bytes::new(), 0);
        (input, (cell(&owner, None, 99 * CKB), Bytes::new()))
    }
    fn funding(&mut self) -> CellInput {
        let other = self.env.other.clone();
        self.env
            .input(cell(&other, None, 1000 * CKB), Bytes::new(), 0)
    }
}

#[test]
fn owner_cancel_with_proof() {
    let mut o = Order::new(0);
    let order = o.input(1000, 0);
    let (proof, change) = o.proof();
    let tx = o.env.tx(vec![order, proof], vec![o.recovery(1000), change]);
    o.env.expect(&tx, 0, "cancel");
}

#[test]
fn malformed_tail_is_still_cancellable_by_owner_only() {
    let mut o = Order::new(EXPIRY);
    let owner_len = o.env.owner.as_slice().len();
    o.args[owner_len] = 9; // unsupported version
    o.lock = o.env.lock(o.args.clone());
    let order = o.input(1000, 0);
    let (proof, change) = o.proof();
    let tx = o.env.tx(vec![order, proof], vec![o.recovery(1000), change]);
    o.env.expect(&tx, 0, "malformed cancel");
    // Without the owner, the expiry path must parse the tail and refuse.
    let order = o.input(1000, EXPIRY);
    let funding = o.funding();
    let tx = o.env.tx(vec![order, funding], vec![o.recovery(1000)]);
    o.env.expect(&tx, 27, "malformed return");
}

#[test]
fn return_without_proof_needs_expiry() {
    let mut o = Order::new(0);
    let order = o.input(1000, EXPIRY);
    let funding = o.funding();
    let tx = o.env.tx(vec![order, funding], vec![o.recovery(1000)]);
    o.env.expect(&tx, 61, "no expiry");
}

#[test]
fn expiry_return_follows_since_exactly() {
    let relative = 1 << 63;
    let block_metric = EXPIRY & !0x4000_0000_0000_0000;
    for (since, code, label) in [
        (EXPIRY, 0, "at expiry"),
        (EXPIRY + 86_400, 0, "a day later"),
        (EXPIRY - 1, 62, "one second early"),
        (0, 62, "no since"),
        (EXPIRY | relative, 62, "relative since"),
        (block_metric, 62, "block-number metric"),
        (EXPIRY | (1 << 56), 62, "reserved since bits"),
    ] {
        let mut o = Order::new(EXPIRY);
        let order = o.input(1000, since);
        let funding = o.funding();
        let tx = o.env.tx(vec![order, funding], vec![o.recovery(1000)]);
        o.env.expect(&tx, code, label);
    }
}

#[test]
fn expiry_return_must_not_recreate_the_order() {
    let mut o = Order::new(EXPIRY);
    let order = o.input(1000, EXPIRY);
    let funding = o.funding();
    let again = (o.cell(61 * CKB), amount(1));
    let tx = o
        .env
        .tx(vec![order, funding], vec![o.recovery(1000), again]);
    o.env.expect(&tx, 50, "return plus a new order cell");
}

#[test]
fn expiry_return_must_be_unchanged() {
    for (units, capacity, label) in [
        (999, 400 * CKB, "token taken"),
        (1000, 400 * CKB - 1, "capacity taken"),
    ] {
        let mut o = Order::new(EXPIRY);
        let order = o.input(1000, EXPIRY);
        let funding = o.funding();
        let back = (cell(&o.env.owner, Some(&o.env.a), capacity), amount(units));
        let tx = o.env.tx(vec![order, funding], vec![back]);
        // Not a recovery output, so it is judged (and refused) as a fill.
        let result = o.env.context.verify_tx(&tx, MAX_CYCLES);
        assert!(result.is_err(), "{label}");
    }
}

#[test]
fn a_fill_after_expiry_still_verifies_at_the_maker_price() {
    // Truth in labelling: expiry cannot forbid fills (see ORDER_LOCK_V2.md).
    let mut o = Order::new(EXPIRY);
    let order = o.input(1000, EXPIRY + 1);
    let funding = o.funding();
    let payment = (
        cell(&o.env.owner, None, 400 * CKB + 1000 * CKB),
        Bytes::new(),
    );
    let tx = o.env.tx(vec![order, funding], vec![payment]);
    o.env.expect(&tx, 0, "late fill");
}

#[test]
fn partial_fills_chain_until_final() {
    let mut o = Order::new(EXPIRY);
    let (mut units, mut capacity) = (1000u128, 400 * CKB);
    let cell0 = o.cell(capacity);
    let mut point = o.env.context.create_cell(cell0, amount(units));
    let mut total = 0;
    for (take, final_fill) in [(250u128, false), (100, false), (650, true)] {
        let input = CellInput::new_builder()
            .previous_output(point.clone())
            .build();
        let funding = o.funding();
        let paid = take as u64 * CKB;
        let mut outputs = vec![];
        let leaving = if final_fill { capacity } else { 0 };
        outputs.push((cell(&o.env.owner, None, leaving + paid), Bytes::new()));
        if !final_fill {
            outputs.push((o.cell(capacity), amount(units - take)));
        }
        let tx = o.env.tx(vec![input, funding], outputs);
        total += o.env.expect(&tx, 0, "partial chain");
        if !final_fill {
            units -= take;
            point = OutPoint::new(tx.hash(), 1);
            let (c, d) = (
                tx.outputs().get(1).unwrap(),
                tx.outputs_data().get(1).unwrap(),
            );
            o.env
                .context
                .create_cell_with_out_point(point.clone(), c, d.raw_data());
            capacity = 400 * CKB;
        }
    }
    println!("three fills, cycles={total}");
}

#[test]
fn two_partial_orders_in_one_transaction() {
    let mut env = Env::new();
    let mk = |env: &mut Env, nonce| {
        let a = args(
            &env.owner,
            &Terms {
                refund: 0,
                expiry: 0,
                ask: None,
                ask_amount: 100 * CKB as u128, // 10 CKB per unit
                offer_amount: 10,
                min_fill: 1,
                nonce,
            },
        );
        env.lock(a)
    };
    let (l1, l2) = (mk(&mut env, 1), mk(&mut env, 2));
    let a = env.a.clone();
    let i1 = env.input(cell(&l1, Some(&a), 300 * CKB), amount(10), 0);
    let i2 = env.input(cell(&l2, Some(&a), 300 * CKB), amount(10), 0);
    let owner = env.owner.clone();
    let pay = |n: u64| (cell(&owner, None, n * CKB), Bytes::new());
    let outputs = vec![
        pay(40),
        pay(70),
        (cell(&l1, Some(&a), 300 * CKB), amount(6)),
        (cell(&l2, Some(&a), 300 * CKB), amount(3)),
    ];
    let tx = env.tx(vec![i1.clone(), i2.clone()], outputs.clone());
    env.expect(&tx, 0, "two partials");
    // Swapping the remainders' amounts underpays order 1's payment index.
    let mut swapped = outputs;
    swapped[2].1 = amount(3);
    swapped[3].1 = amount(6);
    let i1 = env.input(cell(&l1, Some(&a), 300 * CKB), amount(10), 0);
    let i2 = env.input(cell(&l2, Some(&a), 300 * CKB), amount(10), 0);
    let tx = env.tx(vec![i1, i2], swapped);
    env.expect(&tx, 55, "swapped remainders");
}

#[test]
fn two_inputs_with_one_order_lock_are_refused() {
    let mut o = Order::new(0);
    let (a, b) = (o.input(500, 0), o.input(500, 0));
    let payment = (cell(&o.env.owner, None, 2000 * CKB), Bytes::new());
    let tx = o.env.tx(vec![a, b], vec![payment.clone(), payment]);
    o.env.expect(&tx, 33, "group of two");
}

#[test]
fn wide_product_matches_u256() {
    let mut s = 0x9e37_79b9_7f4a_7c15_u64;
    let mut next = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        let hi = s as u128;
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        let v = (hi << 64) | s as u128;
        match s % 4 {
            0 => v,
            1 => v >> (s % 128),
            2 => u128::MAX - (s as u128 % 3),
            _ => s as u128 % 5,
        }
    };
    for _ in 0..200_000 {
        let (a, b, c, d) = (next(), next(), next(), next());
        let want = U256::from(a) * U256::from(b) >= U256::from(c) * U256::from(d);
        assert_eq!(
            crate::wide::product_at_least(a, b, c, d),
            want,
            "{a} {b} {c} {d}"
        );
        let (x, y) = (next(), next());
        assert!(crate::wide::product_at_least(x, y, y, x));
    }
}
