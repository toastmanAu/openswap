use crate::fixture::*;
use ckb_testtool::ckb_types::{bytes::Bytes, prelude::*};

#[test]
fn udt_to_udt() {
    Fixture::new().check(None);
}
#[test]
fn udt_to_ckb() {
    let mut f = Fixture::new();
    f.ckb_ask();
    f.check(None);
}
#[test]
fn ckb_to_udt() {
    let mut f = Fixture::new();
    f.ckb_offer();
    f.check(None);
}
#[test]
fn overpay_tokens() {
    let mut f = Fixture::new();
    f.payments[0].1 = 101_u128.to_le_bytes().to_vec().into();
    f.check(None);
}
#[test]
fn max_u128_payment() {
    let mut f = Fixture::new();
    f.args = terms(&f.owner, Some(&f.b), CAP, u128::MAX, 1);
    f.payments[0].1 = u128::MAX.to_le_bytes().to_vec().into();
    f.check(None);
}
#[test]
fn surplus_and_funding() {
    let mut f = Fixture::new();
    f.after.push((cell(&f.owner, None, CAP), Bytes::new()));
    f.payments.push((
        cell(&f.owner, Some(&f.a), CAP),
        100_u128.to_le_bytes().to_vec().into(),
    ));
    f.check(None);
}
#[test]
fn absolute_index() {
    let mut f = Fixture::new();
    f.before.push((cell(&f.owner, None, CAP), Bytes::new()));
    f.payments
        .insert(0, (cell(&f.owner, None, CAP), Bytes::new()));
    f.check(None);
}
#[test]
fn wrong_index() {
    let mut f = Fixture::new();
    f.before.push((cell(&f.owner, None, CAP), Bytes::new()));
    f.check(Some(51));
}

macro_rules! tail_case {
    ($name:ident, $offset:expr, $value:expr, $code:expr) => {
        #[test]
        fn $name() {
            let mut f = Fixture::new();
            let o = f.owner.as_slice().len();
            f.args[o + $offset] = $value;
            f.check(Some($code));
        }
    };
}
tail_case!(version, 0, 2, 27);
tail_case!(flags, 1, 1, 28);
tail_case!(reserved_low, 2, 1, 29);
tail_case!(reserved_high, 3, 1, 29);
#[test]
fn zero_nonce() {
    let mut f = Fixture::new();
    let o = f.owner.as_slice().len();
    f.args[o + 4..o + 20].fill(0);
    f.check(Some(30));
}
#[test]
fn zero_ask() {
    let mut f = Fixture::new();
    let n = f.args.len();
    f.args[n - 16..].fill(0);
    f.check(Some(31));
}
#[test]
fn trailing_bytes() {
    let mut f = Fixture::new();
    f.args.push(0);
    f.check(Some(26));
}
#[test]
fn short_args() {
    let mut f = Fixture::new();
    f.args.truncate(3);
    f.check(Some(21));
}
#[test]
fn short_tail() {
    let mut f = Fixture::new();
    f.args.truncate(f.owner.as_slice().len() + 47);
    f.check(Some(21));
}
#[test]
fn invalid_owner() {
    let mut f = Fixture::new();
    f.args[4] = 15;
    f.check(Some(23));
}
#[test]
fn oversized_owner() {
    let mut f = Fixture::new();
    f.args[..4].copy_from_slice(&1025_u32.to_le_bytes());
    f.check(Some(22));
}
#[test]
fn invalid_ask() {
    let mut f = Fixture::new();
    let o = f.owner.as_slice().len();
    f.args[o + 36] = 15;
    f.check(Some(25));
}
#[test]
fn oversized_ask() {
    let mut f = Fixture::new();
    let o = f.owner.as_slice().len();
    f.args[o + 28..o + 32].copy_from_slice(&1025_u32.to_le_bytes());
    f.check(Some(24));
}
#[test]
fn mismatched_ask_size() {
    let mut f = Fixture::new();
    let o = f.owner.as_slice().len();
    f.args[o + 28..o + 32].copy_from_slice(&0_u32.to_le_bytes());
    f.check(Some(26));
}
#[test]
fn oversized_running_script() {
    let mut f = Fixture::new();
    f.args.resize(65536, 0);
    f.check(Some(20));
}
#[test]
fn duplicate_group() {
    let mut f = Fixture::new();
    f.duplicate = true;
    f.payments.push(f.payments[0].clone());
    f.check(Some(33));
}
#[test]
fn duplicate_group_cancel() {
    let mut f = Fixture::new();
    f.recovery();
    f.duplicate = true;
    f.payments.push(f.payments[0].clone());
    f.proof(1);
    f.check(Some(33));
}
#[test]
fn ckb_with_data() {
    let mut f = Fixture::new();
    f.ckb_offer();
    f.offer_data = vec![1];
    f.check(Some(40));
}
#[test]
fn malformed_offer_lengths() {
    for n in [0, 1, 15, 17, 65536] {
        let mut f = Fixture::new();
        f.offer_data = vec![1; n];
        f.check(Some(40));
    }
}
#[test]
fn zero_offer() {
    let mut f = Fixture::new();
    f.offer_data = vec![0; 16];
    f.check(Some(41));
}
#[test]
fn udt_refund_mismatch() {
    let mut f = Fixture::new();
    f.offer_capacity += 1;
    f.check(Some(42));
}
#[test]
fn ckb_refund_equal() {
    let mut f = Fixture::new();
    f.ckb_offer();
    f.offer_capacity = CAP;
    f.check(Some(42));
}
#[test]
fn ckb_refund_below_occupied() {
    let mut f = Fixture::new();
    f.ckb_offer();
    f.args = terms(&f.owner, Some(&f.b), 1, ASK, 1);
    f.check(Some(42));
}
#[test]
fn same_udt() {
    let mut f = Fixture::new();
    f.args = terms(&f.owner, Some(&f.a), CAP, ASK, 1);
    f.check(Some(43));
}
#[test]
fn same_ckb() {
    let mut f = Fixture::new();
    f.ckb_offer();
    f.ckb_ask();
    f.check(Some(43));
}
#[test]
fn payment_missing() {
    let mut f = Fixture::new();
    f.payments.clear();
    f.check(Some(51));
}
#[test]
fn wrong_owner() {
    let mut f = Fixture::new();
    f.payments[0].0 = cell(&f.a, Some(&f.b), CAP);
    f.check(Some(52));
}
#[test]
fn wrong_asset() {
    let mut f = Fixture::new();
    f.payments[0].0 = cell(&f.owner, Some(&f.a), CAP);
    f.check(Some(53));
}
#[test]
fn underpaid_token() {
    let mut f = Fixture::new();
    f.payments[0].1 = (ASK - 1).to_le_bytes().to_vec().into();
    f.check(Some(55));
}
#[test]
fn malformed_payment_lengths() {
    for n in [0, 1, 15, 17, 65536] {
        let mut f = Fixture::new();
        f.payments[0].1 = vec![1; n].into();
        f.check(Some(54));
    }
}
#[test]
fn token_payment_capacity() {
    for capacity in [CAP - 1, CAP + 1] {
        let mut f = Fixture::new();
        f.payments[0].0 = cell(&f.owner, Some(&f.b), capacity);
        f.check(Some(56));
    }
}
#[test]
fn ckb_payment_with_type() {
    let mut f = Fixture::new();
    f.ckb_ask();
    f.payments[0].0 = cell(&f.owner, Some(&f.b), CAP + 100);
    f.check(Some(53));
}
#[test]
fn ckb_payment_with_data() {
    let mut f = Fixture::new();
    f.ckb_ask();
    f.payments[0].1 = vec![0].into();
    f.check(Some(54));
}
#[test]
fn ckb_short_one() {
    let mut f = Fixture::new();
    f.ckb_ask();
    f.payments[0].0 = cell(&f.owner, None, CAP + 99);
    f.check(Some(56));
}
#[test]
fn ckb_unrepresentable() {
    for ask in [u64::MAX as u128, u128::MAX] {
        let mut f = Fixture::new();
        f.ckb_ask();
        f.args = terms(&f.owner, None, CAP, ask, 1);
        f.check(Some(57));
    }
}
#[test]
fn recreated_order() {
    let mut f = Fixture::new();
    let lock = f.lock();
    f.payments
        .push((cell(&lock, Some(&f.a), CAP), f.offer_data.clone().into()));
    f.check(Some(50));
}
#[test]
fn cancel_udt() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(1);
    f.check(None);
}
#[test]
fn cancel_ckb() {
    let mut f = Fixture::new();
    f.ckb_offer();
    f.recovery();
    f.proof(1);
    f.check(None);
}
#[test]
fn rescue_malformed_tail() {
    let mut f = Fixture::new();
    f.args.truncate(f.owner.as_slice().len());
    f.recovery();
    f.proof(1);
    f.check(None);
}
#[test]
fn rescue_hostile_data() {
    let mut f = Fixture::new();
    f.offer_data = vec![7; 65536];
    f.recovery();
    f.proof(1);
    f.check(None);
}
#[test]
fn cancel_no_proof() {
    let mut f = Fixture::new();
    f.recovery();
    f.check(Some(61));
}
#[test]
fn cancel_equal_proof() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(0);
    f.check(Some(61));
}
#[test]
fn acp_increase_regression() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(0);
    f.payments[1].0 = cell(&f.owner, None, CAP + 1);
    f.check(Some(61));
}
#[test]
fn proof_output_missing() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(1);
    f.payments.pop();
    f.check(Some(61));
}
#[test]
fn proof_wrong_owner() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(1);
    f.after[0].0 = cell(&f.a, None, CAP);
    f.check(Some(61));
}
#[test]
fn proof_output_wrong_owner() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(1);
    f.payments[1].0 = cell(&f.a, None, CAP - 1);
    f.check(Some(61));
}
#[test]
fn proof_type_present() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(1);
    f.after[0].0 = cell(&f.owner, Some(&f.a), CAP);
    f.check(Some(61));
}
#[test]
fn proof_output_type_present() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(1);
    f.payments[1].0 = cell(&f.owner, Some(&f.a), CAP - 1);
    f.check(Some(61));
}
#[test]
fn proof_data_present() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(1);
    f.after[0].1 = vec![1].into();
    f.check(Some(61));
}
#[test]
fn proof_output_data_present() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(1);
    f.payments[1].1 = vec![1].into();
    f.check(Some(61));
}
#[test]
fn recovery_wrong_lock() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(1);
    f.payments[0].0 = cell(&f.a, Some(&f.a), CAP);
    f.check(Some(52));
}
#[test]
fn recovery_wrong_type() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(1);
    f.payments[0].0 = cell(&f.owner, None, CAP);
    f.check(Some(53));
}
#[test]
fn recovery_changed_data() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(1);
    f.payments[0].1 = 201_u128.to_le_bytes().to_vec().into();
    f.check(Some(53));
}
#[test]
fn recovery_reduced_capacity() {
    let mut f = Fixture::new();
    f.recovery();
    f.proof(1);
    f.payments[0].0 = cell(&f.owner, Some(&f.a), CAP - 1);
    f.check(Some(53));
}

fn batch(count: usize, cancel: bool, ring: bool, underpay: bool) {
    let mut f = Fixture::new();
    f.payments.clear();
    let c =
        f.b.clone()
            .as_builder()
            .args(Bytes::from(vec![3]).pack())
            .build();
    let assets = [f.a.clone(), f.b.clone(), c];
    for i in 0..count {
        let offer = &assets[i % if ring { 3 } else { 2 }];
        let ask = &assets[(i + 1) % if ring { 3 } else { 2 }];
        f.args = terms(&f.owner, Some(ask), CAP, 100, (i + 1) as u8);
        let lock = f.lock();
        let data: Bytes = 100_u128.to_le_bytes().to_vec().into();
        f.before.push((cell(&lock, Some(offer), CAP), data.clone()));
        f.payments.push((
            cell(&f.owner, Some(if cancel { offer } else { ask }), CAP),
            data,
        ));
    }
    // Fixture appends a last order after the prefix.
    let (last, data) = f.before.pop().unwrap();
    f.offer_type = last.type_().to_opt();
    f.offer_data = data.to_vec();
    if cancel {
        f.proof(1);
    }
    if underpay {
        f.payments[count - 1].1 = 99_u128.to_le_bytes().to_vec().into();
    }
    f.check(if underpay { Some(55) } else { None });
}
#[test]
fn reciprocal_two() {
    batch(2, false, false, false);
}
#[test]
fn ten_lots() {
    batch(10, false, false, false);
}
#[test]
fn twenty_lots() {
    batch(20, false, false, false);
}
#[test]
fn three_asset_ring() {
    batch(3, false, true, false);
}
#[test]
fn batch_single_proof_cancel() {
    batch(10, true, false, false);
}
#[test]
fn same_owner_cannot_reuse_payment() {
    batch(2, false, false, true);
}

#[test]
fn truncation_matrix_never_panics() {
    let original = Fixture::new().args;
    for n in 0..original.len() {
        let mut f = Fixture::new();
        f.args = original[..n].to_vec();
        let expected = if n < 4 {
            21
        } else if n < f.owner.as_slice().len() {
            23
        } else if n < f.owner.as_slice().len() + 48 {
            21
        } else {
            26
        };
        f.check(Some(expected));
    }
}
#[test]
fn oversized_tail_still_rescuable_within_running_limit() {
    let mut f = Fixture::new();
    f.args.resize(3500, 0xff);
    f.recovery();
    f.proof(1);
    f.check(None);
}
#[test]
fn ckb_occupied_capacity_boundary() {
    let mut f = Fixture::new();
    f.ckb_offer();
    let lock = f.lock();
    let occupied = cell(&lock, None, f.offer_capacity)
        .occupied_capacity(ckb_testtool::ckb_types::core::Capacity::bytes(0).unwrap())
        .unwrap()
        .as_u64();
    f.args = terms(&f.owner, Some(&f.b), occupied, ASK, 1);
    f.payments[0].0 = cell(&f.owner, Some(&f.b), occupied);
    f.check(None);
}
#[test]
fn maximum_owner_and_ask_scripts() {
    let mut f = Fixture::new();
    // Script serialization is 53 fixed bytes plus its args.
    f.owner = f
        .owner
        .as_builder()
        .args(Bytes::from(vec![0; 971]).pack())
        .build();
    f.b =
        f.b.as_builder()
            .args(Bytes::from(vec![1; 971]).pack())
            .build();
    f.args = terms(&f.owner, Some(&f.b), CAP, ASK, 1);
    f.payments[0].0 = cell(&f.owner, Some(&f.b), CAP);
    f.check(None);
}
#[test]
fn ckb_maximum_representable_ask() {
    let mut f = Fixture::new();
    f.ckb_ask();
    f.args = terms(&f.owner, None, CAP, (u64::MAX - CAP) as u128, 1);
    f.payments[0].0 = cell(&f.owner, None, u64::MAX);
    f.check(None);
}
#[test]
fn ckb_overpayment() {
    let mut f = Fixture::new();
    f.ckb_ask();
    f.payments[0].0 = cell(&f.owner, None, CAP + 101);
    f.check(None);
}
