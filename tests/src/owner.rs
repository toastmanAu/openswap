//! Real owner locks: the OpenSwap input is never in the owner's signing group.
use crate::fixture::*;
use ckb_system_scripts::BUNDLED_CELL;
use ckb_testtool::{
    ckb_crypto::secp::Privkey,
    ckb_hash::{blake2b_256, new_blake2b},
    ckb_types::{
        H256,
        bytes::Bytes,
        core::{ScriptHashType, TransactionView},
        packed::*,
        prelude::*,
    },
};

fn setup(acp: bool) -> (Fixture, Privkey, CellDep) {
    let mut f = Fixture::new();
    // Public deterministic fixture key, never a funded wallet.
    let key = Privkey::from_slice(&[42; 32]);
    let pubkey = key.pubkey().unwrap().serialize();
    let code = if acp {
        Bytes::from_static(include_bytes!("../fixtures/anyone_can_pay"))
    } else {
        BUNDLED_CELL
            .get("specs/cells/secp256k1_blake160_sighash_all")
            .unwrap()
            .to_vec()
            .into()
    };
    let point = f.context.deploy_cell(code);
    let data = f.context.deploy_cell(
        BUNDLED_CELL
            .get("specs/cells/secp256k1_data")
            .unwrap()
            .to_vec()
            .into(),
    );
    f.owner = f
        .context
        .build_script_with_hash_type(
            &point,
            ScriptHashType::Data1,
            blake2b_256(pubkey)[..20].to_vec().into(),
        )
        .unwrap();
    f.args = terms(&f.owner, Some(&f.b), CAP, ASK, 1);
    f.recovery();
    f.proof(1);
    (f, key, CellDep::new_builder().out_point(data).build())
}

fn sign(tx: TransactionView, key: &Privkey) -> TransactionView {
    // Only input 1 belongs to this signing group; input 0 uses OpenSwap.
    let placeholder = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(vec![0; 65])).pack())
        .build();
    let mut digest = new_blake2b();
    digest.update(tx.hash().as_slice());
    digest.update(&(placeholder.as_slice().len() as u64).to_le_bytes());
    digest.update(placeholder.as_slice());
    let mut message = [0; 32];
    digest.finalize(&mut message);
    let signature = key
        .sign_recoverable(&H256::from(message))
        .unwrap()
        .serialize();
    let witness = placeholder
        .as_builder()
        .lock(Some(Bytes::from(signature)).pack())
        .build();
    tx.as_advanced_builder()
        .set_witnesses(vec![Bytes::new().pack(), witness.as_bytes().pack()])
        .build()
}

#[test]
fn secp_cancel_signed() {
    let (mut f, key, dep) = setup(false);
    let tx = f.tx().as_advanced_builder().cell_dep(dep).build();
    let signed = sign(tx, &key);
    let cycles = f.context.verify_tx(&signed, MAX_CYCLES).unwrap();
    println!("secp cancel cycles={cycles}");
}
#[test]
fn secp_cancel_unsigned_rejected() {
    let (mut f, _, dep) = setup(false);
    let tx = f.tx().as_advanced_builder().cell_dep(dep).build();
    assert!(f.context.verify_tx(&tx, MAX_CYCLES).is_err());
}
#[test]
fn secp_wrong_signature_rejected() {
    let (mut f, _, dep) = setup(false);
    let tx = f.tx().as_advanced_builder().cell_dep(dep).build();
    let signed = sign(tx, &Privkey::from_slice(&[43; 32]));
    assert!(f.context.verify_tx(&signed, MAX_CYCLES).is_err());
}
#[test]
fn acp_owner_signed_decrease() {
    let (mut f, key, dep) = setup(true);
    let tx = f.tx().as_advanced_builder().cell_dep(dep).build();
    f.context.verify_tx(&sign(tx, &key), MAX_CYCLES).unwrap();
}
#[test]
fn acp_unsigned_decrease_rejected() {
    let (mut f, _, dep) = setup(true);
    let tx = f.tx().as_advanced_builder().cell_dep(dep).build();
    assert!(f.context.verify_tx(&tx, MAX_CYCLES).is_err());
}
#[test]
fn acp_permissionless_deposit_cannot_cancel() {
    let (mut f, _, dep) = setup(true);
    f.payments[1].0 = cell(&f.owner, None, CAP + 1);
    // Give ACP a matching input for the recovered token output, so ACP itself
    // accepts both deposit increases. Only OpenSwap should reject cancellation.
    f.after.push((
        cell(&f.owner, Some(&f.a), CAP),
        1_u128.to_le_bytes().to_vec().into(),
    ));
    let tx = f.tx().as_advanced_builder().cell_dep(dep).build();
    let error = f
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .unwrap_err()
        .to_string();
    assert!(error.contains("error code 61"), "{error}");
}
