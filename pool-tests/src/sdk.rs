//! Execute the actual TypeScript builder output, without complete_tx repairing deps.
mod composition;
mod resource;
mod split;
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
use openswap_pool_arithmetic::wire::StateData;
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
    build_or_skip(request).unwrap_or_else(|skip| panic!("unexpected builder skip {skip}"))
}
/// `Err(code)` only when the request sets `allowSkip` and the builder refused.
fn build_or_skip(request: &Value) -> Result<(TransactionView, usize), String> {
    let response = bridge(request);
    if let Some(skip) = response["skip"].as_str() {
        return Err(skip.to_string());
    }
    Ok((
        Transaction::from_slice(&unhex(response["transaction"].as_str().unwrap()))
            .unwrap()
            .into_view(),
        response["walletWitnessIndex"].as_u64().unwrap() as usize,
    ))
}
/// Runs the TypeScript bridge on one JSON request and returns its JSON reply.
fn bridge(request: &Value) -> Value {
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
    serde_json::from_slice(&output.stdout).unwrap()
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

fn regime_sequences(
    context: &mut Context,
    base: &Value,
    key: &Privkey,
    lock: &Script,
    token: &Script,
) {
    // Fixed seeds control operations and budgets. Public fixture signatures may
    // vary in bytes/cost, so ceilings are regression budgets, not exact promises.
    for (seed, fee, locked, x, y) in [
        (
            7_u32,
            0_u16,
            1_u128,
            1_000_000_000_000_u64,
            4_000_000_000_000_u128,
        ),
        (29, 30, 1000, 10_000_000_000, 1_000_000_000_000_000_000),
        (101, 9999, 1_000_000, 1_000_000_000_000, 4_000_000_000_000),
        (
            999,
            100,
            1_000_000_000_000,
            10_000_000_000_000_000,
            1_u128 << 110,
        ),
    ] {
        let mut request = base.clone();
        request.as_object_mut().unwrap().remove("previous");
        request.as_object_mut().unwrap().remove("random");
        let funding = context.create_cell(cell(lock, Some(token), x * 50), amount(y * 50));
        request["funding"] = json!([describe(context, &funding)]);
        request["initial"] = json!({"fee":fee.to_string(),"locked":locked.to_string(),"x":x.to_string(),"y":y.to_string()});
        let (genesis, first) = build(&request);
        let genesis = sign(&genesis, key, first);
        let mut peak = context.verify_tx(&genesis, 6_000_000).unwrap();
        let mut max_bytes = genesis.data().as_slice().len();
        let mut current = register(context, &genesis);
        let mut random = seed;
        let mut consumed = std::collections::HashSet::new();
        for step in 0..14 {
            random = random.wrapping_mul(1664525).wrapping_add(1013904223);
            let action = if step == 12 {
                "withdraw"
            } else if step == 13 {
                "deposit"
            } else {
                ["xToY", "yToX", "deposit", "withdraw"][(step + seed as usize) % 4]
            };
            request["previous"] = json!(
                current[..3]
                    .iter()
                    .map(|p| describe(context, p))
                    .collect::<Vec<_>>()
            );
            request["funding"] = json!(
                current[3..]
                    .iter()
                    .map(|p| describe(context, p))
                    .collect::<Vec<_>>()
            );
            request["action"] = json!(action);
            request["relativeRandom"] = json!(random);
            request["fullWithdraw"] = json!(step == 12);
            if step == 13 {
                request["reenter"] = json!({"x":(x/10).to_string(),"y":(y/10).to_string()});
            }
            let (tx, first) = build(&request);
            for (i, input) in tx.inputs().into_iter().enumerate() {
                assert_eq!(
                    input.previous_output(),
                    current[i],
                    "seed={seed} step={step} predecessor"
                );
                assert!(
                    consumed.insert(input.previous_output()),
                    "reused spent fixture input"
                );
            }
            let tx = sign(&tx, key, first);
            let cycles = context
                .verify_tx(&tx, 6_000_000)
                .unwrap_or_else(|e| panic!("seed={seed} step={step} action={action}: {e}"));
            peak = peak.max(cycles);
            max_bytes = max_bytes.max(tx.data().as_slice().len());
            assert!(max_bytes <= 3000, "seed={seed}: sequence byte regression");
            let state = StateData::decode(&tx.outputs_data().get(0).unwrap().raw_data()).unwrap();
            if step == 12 {
                assert_eq!(state.shares, locked);
            }
            if step == 13 {
                assert!(state.shares > locked);
            }
            current = register(context, &tx);
        }
        println!(
            "REGIME seed={seed} fee={fee} locked={locked} x={x} y={y} transitions=14 peak_cycles={peak} max_bytes={max_bytes} ceiling=6000000 byte_ceiling=3000"
        );
    }
}

#[test]
fn sdk_seeded_vm_endurance() {
    // Campaign target `pool-vm`: one long seeded walk of real SDK transitions,
    // each spending the previous transaction's outputs. CI runs a short default.
    // Every 8th step also signs a one-byte state mutation that must be rejected.
    let campaign = crate::campaign::Campaign::from_env("pool-vm", 6);
    let SdkFixture {
        mut context,
        creator,
        mut request,
        ..
    } = setup();
    let (genesis, first) = build(&request);
    let genesis = sign(&genesis, &creator, first);
    context.verify_tx(&genesis, CYCLES).unwrap();
    let mut current = register(&mut context, &genesis);
    let mut random = campaign.state(0x0e4d_u64) as u32;
    let (mut peak, mut max_bytes, mut tampered) = (0, 0, 0);
    let mut skips = std::collections::BTreeMap::<String, u64>::new();
    let mut applied = std::collections::BTreeMap::<&str, u64>::new();
    let mut consumed = std::collections::HashSet::new();
    request["allowSkip"] = json!(true);
    campaign.run(|step| {
        random = random.wrapping_mul(1664525).wrapping_add(1013904223);
        let action = ["xToY", "yToX", "deposit", "withdraw"][(random >> 16) as usize % 4];
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
        request["relativeRandom"] = json!(random);
        let (tx, first) = match build_or_skip(&request) {
            Ok(built) => built,
            Err(code) => {
                *skips.entry(format!("{action}:{code}")).or_default() += 1;
                return;
            }
        };
        for (i, input) in tx.inputs().into_iter().enumerate() {
            assert_eq!(
                input.previous_output(),
                current[i],
                "step={step} predecessor"
            );
            assert!(
                consumed.insert(input.previous_output()),
                "step={step} reused input"
            );
        }
        let signed = sign(&tx, &creator, first);
        let cycles = context
            .verify_tx(&signed, CYCLES)
            .unwrap_or_else(|e| panic!("step={step} action={action}: {e}"));
        peak = peak.max(cycles);
        max_bytes = max_bytes.max(signed.data().as_slice().len());
        assert!(max_bytes <= 3000, "step={step}: byte regression");
        let data = signed.outputs_data().get(0).unwrap().raw_data();
        assert!(StateData::decode(&data).is_ok(), "step={step} state");
        if step % 8 == 0 {
            let mut bytes = data.to_vec();
            let index = (random as usize >> 3) % bytes.len();
            bytes[index] ^= 1 << (random % 8);
            let mut outputs: Vec<_> = tx.outputs_data().into_iter().collect();
            outputs[0] = Bytes::from(bytes).pack();
            let mutated = tx.as_advanced_builder().set_outputs_data(outputs).build();
            assert!(
                context
                    .verify_tx(&sign(&mutated, &creator, first), CYCLES)
                    .is_err(),
                "step={step} accepted a mutated state byte {index}"
            );
            tampered += 1;
        }
        *applied.entry(action).or_default() += 1;
        current = register(&mut context, &signed);
    });
    println!(
        "VM_ENDURANCE applied={applied:?} skipped={skips:?} tampered_rejected={tampered} peak_cycles={peak} max_bytes={max_bytes}"
    );
}

struct SdkFixture {
    context: Context,
    creator: Privkey,
    holder: Privkey,
    creator_lock: Script,
    holder_lock: Script,
    token_script: Script,
    token: OutPoint,
    funding: OutPoint,
    request: Value,
}
fn setup() -> SdkFixture {
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
    let request = json!({"codeHash":hex(pool_script.code_hash().as_slice()),"poolDep":hex(pool.as_slice()),"tokenDep":hex(token.as_slice()),
        "lock":hex(creator_lock.as_slice()),"lockDeps":[hex(secp.as_slice()),hex(data.as_slice())],"funding":[describe(&context,&funding)]});
    SdkFixture {
        context,
        creator,
        holder,
        creator_lock,
        holder_lock,
        token_script,
        token,
        funding,
        request,
    }
}

#[test]
fn sdk_joyid_layout_with_secp_authorization() {
    // Proves the alternate SDK layout against the unchanged pool and real xUDT.
    // The wallet lock remains real secp with public fixture keys: this is NOT
    // a test of JoyID/WebAuthn authentication or a genuine CoTA subkey proof.
    for subkey in [false, true] {
        let mut fixture = setup();
        fixture.request["walletWitness"] = if subkey {
            json!({"kind":"joyid", "outputType":"0x123456"})
        } else {
            json!({"kind":"joyid"})
        };
        let (genesis, first) = build(&fixture.request);
        assert_eq!(first, 0);
        assert_eq!(genesis.inputs().len(), 1);
        assert_eq!(genesis.witnesses().len(), 2);
        let state = StateData::decode(&genesis.outputs_data().get(1).unwrap().raw_data()).unwrap();
        assert_eq!((state.rx, state.ry), (2, 3));
        let genesis = sign(&genesis, &fixture.creator, first);
        fixture.context.verify_tx(&genesis, 6_000_000).unwrap();
        let mut points = register(&mut fixture.context, &genesis);
        let mut state_index = 1;
        for action in ["xToY", "yToX", "deposit", "withdraw", "deposit"] {
            let pool_range = state_index..state_index + 3;
            let funding: Vec<_> = points
                .iter()
                .enumerate()
                .filter(|(index, _)| !pool_range.contains(index))
                .map(|(_, point)| point.clone())
                .collect();
            fixture.request["previous"] = json!(
                points[pool_range.clone()]
                    .iter()
                    .map(|point| describe(&fixture.context, point))
                    .collect::<Vec<_>>()
            );
            fixture.request["funding"] = json!(
                funding
                    .iter()
                    .map(|point| describe(&fixture.context, point))
                    .collect::<Vec<_>>()
            );
            fixture.request["action"] = json!(action);
            let (tx, first) = build(&fixture.request);
            assert_eq!(first, 3);
            let expected: Vec<_> = points[pool_range].iter().chain(&funding).collect();
            assert_eq!(tx.inputs().len(), expected.len());
            for (input, point) in tx.inputs().into_iter().zip(expected) {
                assert_eq!(input.previous_output(), *point);
            }
            let tx = sign(&tx, &fixture.creator, first);
            fixture.context.verify_tx(&tx, 6_000_000).unwrap();
            let state = StateData::decode(&tx.outputs_data().get(0).unwrap().raw_data()).unwrap();
            if action == "withdraw" {
                assert_eq!(state.shares, state.locked);
            }
            if action == "deposit" {
                assert!(state.shares > state.locked);
            }
            points = register(&mut fixture.context, &tx);
            state_index = 0;
        }
    }
}

#[test]
fn sdk_distinct_owner_compositions() {
    let mut fixture = setup();
    composition::run(&mut fixture);
}

#[test]
fn sdk_split_route_orders_and_pool() {
    let mut fixture = setup();
    split::run(&mut fixture);
}

#[test]
fn sdk_combined_resource_envelope() {
    let SdkFixture {
        mut context,
        creator,
        creator_lock,
        token_script,
        request,
        ..
    } = setup();
    resource::run(
        &mut context,
        &request,
        &creator,
        &creator_lock,
        &token_script,
    );
}

#[test]
fn sdk_transactions_real_secp_and_xudt() {
    let SdkFixture {
        mut context,
        creator,
        holder,
        creator_lock,
        holder_lock,
        token_script,
        token,
        funding,
        mut request,
    } = setup();
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
            let verified = context.verify_tx(&tx, 6_000_000);
            assert!(tx.data().as_slice().len() <= 3000);
            assert!(
                verified.is_ok(),
                "seed={seed:#x} step={step} action={action}: {verified:?}"
            );
            current = register(&mut context, &tx);
        }
    }
    assert_eq!(covered.len(), 4);
    request.as_object_mut().unwrap().remove("random");
    regime_sequences(
        &mut context,
        &request,
        &creator,
        &creator_lock,
        &token_script,
    );
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
