//! Real xUDT conservation runs alongside the OpenSwap lock, with no owner-mode minting.
use crate::fixture::*;
use ckb_testtool::ckb_types::{bytes::Bytes, core::ScriptHashType};

fn fixture() -> Fixture {
    let mut f = Fixture::new();
    let bin = include_bytes!("../fixtures/xudt");
    let code = f.context.deploy_cell(Bytes::from_static(bin));
    let mut args = vec![0x11; 32];
    args.extend([0; 4]);
    f.a = f
        .context
        .build_script_with_hash_type(&code, ScriptHashType::Data1, args.clone().into())
        .unwrap();
    args[0] = 0x22;
    f.b = f
        .context
        .build_script_with_hash_type(&code, ScriptHashType::Data1, args.into())
        .unwrap();
    f.offer_type = Some(f.a.clone());
    f.args = terms(&f.owner, Some(&f.b), CAP, ASK, 1);
    f.payments = vec![(
        cell(&f.owner, Some(&f.b), CAP),
        ASK.to_le_bytes().to_vec().into(),
    )];
    f
}

#[test]
fn udt_to_udt() {
    let mut f = fixture();
    f.after.push((
        cell(&f.owner, Some(&f.b), CAP),
        ASK.to_le_bytes().to_vec().into(),
    ));
    f.payments
        .push((cell(&f.owner, Some(&f.a), CAP), f.offer_data.clone().into()));
    f.check(None);
}
#[test]
fn udt_to_ckb() {
    let mut f = fixture();
    f.ckb_ask();
    f.after.push((cell(&f.owner, None, CAP), Bytes::new()));
    f.payments.push((
        cell(&f.owner, Some(&f.a), CAP - 100),
        f.offer_data.clone().into(),
    ));
    f.check(None);
}
#[test]
fn ckb_to_udt() {
    let mut f = fixture();
    f.ckb_offer();
    f.after.push((
        cell(&f.owner, Some(&f.b), CAP),
        ASK.to_le_bytes().to_vec().into(),
    ));
    f.payments
        .push((cell(&f.owner, None, CAP + 1000), Bytes::new()));
    f.check(None);
}
#[test]
fn token_creation_rejected() {
    let mut f = fixture();
    // Maker payment passes OpenSwap, but no input provides the requested B tokens.
    f.payments
        .push((cell(&f.owner, Some(&f.a), CAP), f.offer_data.clone().into()));
    let tx = f.tx();
    let error = f
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("Type"),
        "must fail a real type script: {error}"
    );
}
fn batch(count: usize) {
    let mut f = fixture();
    f.payments.clear();
    for i in 0..count {
        let (offer, ask) = if i % 2 == 0 {
            (f.a.clone(), f.b.clone())
        } else {
            (f.b.clone(), f.a.clone())
        };
        f.args = terms(&f.owner, Some(&ask), CAP, ASK, (i + 1) as u8);
        let lock = f.lock();
        let data: Bytes = ASK.to_le_bytes().to_vec().into();
        f.before
            .push((cell(&lock, Some(&offer), CAP), data.clone()));
        f.payments.push((cell(&f.owner, Some(&ask), CAP), data));
    }
    let (last, data) = f.before.pop().unwrap();
    f.offer_type = last.type_().to_opt();
    f.offer_data = data.to_vec();
    f.check(None);
}
#[test]
fn reciprocal() {
    batch(2);
}
#[test]
fn ten_lots() {
    batch(10);
}
#[test]
fn extended_order_data_rejected() {
    let mut f = fixture();
    f.offer_data.push(0);
    f.check(Some(40));
}
