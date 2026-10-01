//! Execute the actual TypeScript builder output, without complete_tx repairing deps.
use crate::fixture::{CYCLES, FUNDING, TOKENS, amount, cell};
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
    context::Context,
};
use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn hex(bytes: &[u8]) -> String {
    let mut s = String::from("0x");
    for b in bytes {
        use std::fmt::Write;
        write!(&mut s, "{b:02x}").unwrap();
    }
    s
}
fn unhex(s: &str) -> Vec<u8> {
    s.as_bytes()[2..]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect()
}
fn describe(context: &Context, point: &OutPoint) -> Value {
    let (output, data) = context.get_cell(point).unwrap();
    json!({"point":hex(point.as_slice()),"output":hex(output.as_slice()),"data":hex(&data)})
}
fn build(request: &Value) -> (TransactionView, usize) {
    let mut child = Command::new("node")
        .args([
            "node_modules/tsx/dist/cli.mjs",
            "pool-sdk/test/vm-bridge.ts",
        ])
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/.."))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("npm ci and Node are required for pool SDK VM tests");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    (
        Transaction::from_slice(&unhex(response["transaction"].as_str().unwrap()))
            .unwrap()
            .into_view(),
        response["walletWitnessIndex"].as_u64().unwrap() as usize,
    )
}
fn sign(tx: &TransactionView, key: &Privkey, first: usize) -> TransactionView {
    // Builders put all same-wallet funding inputs contiguously after pool inputs.
    let mut witnesses: Vec<Bytes> = tx.witnesses().into_iter().map(|w| w.raw_data()).collect();
    let args = WitnessArgs::from_slice(&witnesses[first])
        .unwrap()
        .as_builder()
        .lock(Some(Bytes::from(vec![0; 65])).pack())
        .build();
    witnesses[first] = args.as_bytes();
    let mut digest = new_blake2b();
    digest.update(tx.hash().as_slice());
    // Includes the first placeholder, all remaining wallet-group inputs, then all extra witnesses.
    for w in &witnesses[first..] {
        digest.update(&(w.len() as u64).to_le_bytes());
        digest.update(w);
    }
    let mut message = [0; 32];
    digest.finalize(&mut message);
    let signature = key
        .sign_recoverable(&H256::from(message))
        .unwrap()
        .serialize();
    witnesses[first] = args
        .as_builder()
        .lock(Some(Bytes::from(signature)).pack())
        .build()
        .as_bytes();
    tx.as_advanced_builder()
        .set_witnesses(witnesses.into_iter().map(|w| w.pack()).collect())
        .build()
}
fn register(context: &mut Context, tx: &TransactionView) -> Vec<OutPoint> {
    tx.outputs_with_data_iter()
        .enumerate()
        .map(|(i, (out, data))| {
            let point = OutPoint::new_builder()
                .tx_hash(tx.hash())
                .index(i as u32)
                .build();
            context.create_cell_with_out_point(point.clone(), out, data);
            point
        })
        .collect()
}

#[test]
fn sdk_transactions_real_secp_and_xudt() {
    let mut context = Context::new_with_deterministic_rng();
    let pool = context.deploy_cell(
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../target/riscv64imac-unknown-none-elf/release/openswap-pool"
        ))
        .unwrap()
        .into(),
    );
    let token = context.deploy_cell(Bytes::from_static(include_bytes!(
        "../../tests/fixtures/xudt"
    )));
    let secp = context.deploy_cell(
        BUNDLED_CELL
            .get("specs/cells/secp256k1_blake160_sighash_all")
            .unwrap()
            .to_vec()
            .into(),
    );
    let data = context.deploy_cell(
        BUNDLED_CELL
            .get("specs/cells/secp256k1_data")
            .unwrap()
            .to_vec()
            .into(),
    );
    // Public fixture keys ONLY; no wallet files or user secrets.
    let creator = Privkey::from_slice(&[42; 32]);
    let holder = Privkey::from_slice(&[43; 32]);
    let mut lock = |key: &Privkey| {
        context
            .build_script_with_hash_type(
                &secp,
                ScriptHashType::Data1,
                blake2b_256(key.pubkey().unwrap().serialize())[..20]
                    .to_vec()
                    .into(),
            )
            .unwrap()
    };
    let creator_lock = lock(&creator);
    let holder_lock = lock(&holder);
    let token_script = context
        .build_script_with_hash_type(&token, ScriptHashType::Data1, Bytes::from(vec![0x11; 32]))
        .unwrap();
    let pool_script = context
        .build_script_with_hash_type(&pool, ScriptHashType::Data1, Bytes::new())
        .unwrap();
    let funding = context.create_cell(
        cell(&creator_lock, Some(&token_script), FUNDING),
        amount(TOKENS),
    );
    let mut request = json!({"codeHash":hex(pool_script.code_hash().as_slice()),"poolDep":hex(pool.as_slice()),"tokenDep":hex(token.as_slice()),
        "lock":hex(creator_lock.as_slice()),"lockDeps":[hex(secp.as_slice()),hex(data.as_slice())],"funding":[describe(&context,&funding)]});
    let (genesis, first) = build(&request);
    assert!(context.verify_tx(&genesis, CYCLES).is_err());
    let signed = sign(&genesis, &creator, first);
    println!(
        "SDK create cycles={}",
        context.verify_tx(&signed, CYCLES).unwrap()
    );
    assert!(
        context
            .verify_tx(&sign(&genesis, &holder, first), CYCLES)
            .is_err()
    );
    let points = register(&mut context, &signed);
    request["previous"] = json!(
        points[..3]
            .iter()
            .map(|p| describe(&context, p))
            .collect::<Vec<_>>()
    );
    request["funding"] = json!(
        points[3..]
            .iter()
            .map(|p| describe(&context, p))
            .collect::<Vec<_>>()
    );
    for action in ["xToY", "yToX", "deposit", "withdraw"] {
        request["action"] = json!(action);
        let (tx, first) = build(&request);
        assert_eq!(first, 3);
        assert!(context.verify_tx(&tx, CYCLES).is_err());
        let signed = sign(&tx, &creator, first);
        println!(
            "SDK {action} cycles={}",
            context.verify_tx(&signed, CYCLES).unwrap()
        );
        let mut outputs: Vec<_> = signed.outputs().into_iter().collect();
        outputs[3] = outputs[3]
            .clone()
            .as_builder()
            .lock(holder_lock.clone())
            .build();
        let tampered = signed.as_advanced_builder().set_outputs(outputs).build();
        assert!(
            context.verify_tx(&tampered, CYCLES).is_err(),
            "recipient tamper accepted"
        );
        let mut witnesses: Vec<_> = signed.witnesses().into_iter().collect();
        let args = WitnessArgs::from_slice(&witnesses[0].raw_data()).unwrap();
        let mut action_bytes = args.input_type().to_opt().unwrap().raw_data().to_vec();
        // Halve the effective amount/budget/shares. A +1 deposit budget can be
        // nonbinding (the other asset limits the mint), so it is not a valid
        // rejection assertion. Wallet signatures commit outputs, not this group.
        let value = u128::from_le_bytes(action_bytes[8..24].try_into().unwrap());
        action_bytes[8..24].copy_from_slice(&(value / 2).to_le_bytes());
        witnesses[0] = args
            .as_builder()
            .input_type(Some(Bytes::from(action_bytes)).pack())
            .build()
            .as_bytes()
            .pack();
        assert!(
            context
                .verify_tx(
                    &signed
                        .as_advanced_builder()
                        .set_witnesses(witnesses)
                        .build(),
                    CYCLES
                )
                .is_err(),
            "action amount tamper accepted"
        );
        let mut deps: Vec<_> = signed.cell_deps().into_iter().collect();
        deps.retain(|d| d.out_point() != token);
        assert!(
            context
                .verify_tx(
                    &signed.as_advanced_builder().set_cell_deps(deps).build(),
                    CYCLES
                )
                .is_err()
        );
    }
    // Reproducible mixed operations spend the preceding SDK transaction's real
    // output OutPoints, not a reconstructed independent snapshot on each step.
    let mut covered = std::collections::BTreeSet::new();
    for seed in [0xc0ffee_u32, 0xdeadbeef_u32] {
        let mut random = seed;
        let mut current = points.clone();
        for step in 0..16 {
            random = random.wrapping_mul(1664525).wrapping_add(1013904223);
            let action = ["xToY", "yToX", "deposit", "withdraw"][(random >> 16) as usize % 4];
            covered.insert(action);
            request["previous"] = json!(
                current[..3]
                    .iter()
                    .map(|p| describe(&context, p))
                    .collect::<Vec<_>>()
            );
            request["funding"] = json!(
                current[3..]
                    .iter()
                    .map(|p| describe(&context, p))
                    .collect::<Vec<_>>()
            );
            request["action"] = json!(action);
            request["random"] = json!(random);
            let (tx, first) = build(&request);
            let tx = sign(&tx, &creator, first);
            let verified = context.verify_tx(&tx, CYCLES);
            assert!(
                verified.is_ok(),
                "seed={seed:#x} step={step} action={action}: {verified:?}"
            );
            current = register(&mut context, &tx);
        }
    }
    assert_eq!(covered.len(), 4);
    request.as_object_mut().unwrap().remove("random");
    // A different LP recipient can withdraw without a creator/operator input or signature.
    request.as_object_mut().unwrap().remove("previous");
    request["funding"] = json!([describe(&context, &funding)]);
    request["lpRecipient"] = json!(hex(holder_lock.as_slice()));
    let (genesis, first) = build(&request);
    let genesis = sign(&genesis, &creator, first);
    context.verify_tx(&genesis, CYCLES).unwrap();
    let points = register(&mut context, &genesis);
    let gas = context.create_cell(cell(&holder_lock, None, 100_000_000_000), Bytes::new());
    request["previous"] = json!(
        points[..3]
            .iter()
            .map(|p| describe(&context, p))
            .collect::<Vec<_>>()
    );
    request["funding"] = json!([describe(&context, &points[3]), describe(&context, &gas)]);
    request["lock"] = json!(hex(holder_lock.as_slice()));
    request["action"] = json!("withdraw");
    let (tx, first) = build(&request);
    context
        .verify_tx(&sign(&tx, &holder, first), CYCLES)
        .unwrap();
    assert!(
        context
            .verify_tx(&sign(&tx, &creator, first), CYCLES)
            .is_err()
    );
}
