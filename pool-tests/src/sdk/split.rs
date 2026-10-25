//! Split routes: order-book lots and a pool swap settled in one transaction.
//! The real order lock, pool validator, xUDT and secp all execute; lots and
//! the transaction come from the production TypeScript order SDK and builder.
use super::*;

fn order_cells(
    context: &mut Context,
    code_hash: &[u8],
    dep: &OutPoint,
    owner: &Script,
    token: &Script,
    (offer, ask): (&str, &str),
    lots: &[(u128, u128)],
) -> Vec<OutPoint> {
    let reply = bridge(&json!({"makeOrders":{
        "codeHash":hex(code_hash),"dep":hex(dep.as_slice()),"owner":hex(owner.as_slice()),"token":hex(token.as_slice()),
        "offer":offer,"ask":ask,
        "lots":lots.iter().map(|(o,a)|json!({"offer":o.to_string(),"ask":a.to_string()})).collect::<Vec<_>>()}}));
    reply["cells"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let output = CellOutput::from_slice(&unhex(c["output"].as_str().unwrap())).unwrap();
            context.create_cell(output, Bytes::from(unhex(c["data"].as_str().unwrap())))
        })
        .collect()
}

fn resign(tx: &TransactionView, key: &Privkey, first: usize) -> TransactionView {
    // Clear the wallet signature so `sign` recomputes it over the mutated bytes.
    let mut witnesses: Vec<Bytes> = tx.witnesses().into_iter().map(|w| w.raw_data()).collect();
    witnesses[first] = WitnessArgs::from_slice(&witnesses[first])
        .unwrap()
        .as_builder()
        .lock(Some(Bytes::from(vec![0; 65])).pack())
        .build()
        .as_bytes();
    let blank = tx
        .as_advanced_builder()
        .set_witnesses(witnesses.into_iter().map(|w| w.pack()).collect())
        .build();
    sign(&blank, key, first)
}

pub(super) fn run(fixture: &mut SdkFixture) {
    let binary = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../target/riscv64imac-unknown-none-elf/release/openswap-lock"
    ))
    .expect("build the order lock first");
    let code_hash = blake2b_256(&binary);
    let context = &mut fixture.context;
    let order_dep = context.deploy_cell(binary.into());

    let mut request = fixture.request.clone();
    let (genesis, first) = build(&request);
    let genesis = sign(&genesis, &fixture.creator, first);
    context.verify_tx(&genesis, CYCLES).unwrap();
    let mut points = register(context, &genesis);
    let mut state_at = 0;

    // Pool price: 1 CKB = 4 tokens. Each lot is priced better than the pool.
    for (action, offer, ask, lots, amount_in) in [
        (
            "xToY",
            "token",
            "ckb",
            vec![
                (10_000_000_000_u128, 2_000_000_000_u128),
                (20_000_000_000, 4_500_000_000),
            ],
            1_000_000_000_u128,
        ),
        (
            "yToX",
            "ckb",
            "token",
            vec![
                (1_000_000_000, 3_000_000_000),
                (2_000_000_000, 7_000_000_000),
                (500_000_000, 1_500_000_000),
            ],
            4_000_000_000,
        ),
        // One lot: the state lands at output 1, like the JoyID genesis layout.
        (
            "xToY",
            "token",
            "ckb",
            vec![(10_000_000_000, 2_000_000_000)],
            1_000_000_000,
        ),
        (
            "yToX",
            "ckb",
            "token",
            vec![(1_000_000_000, 3_000_000_000)],
            4_000_000_000,
        ),
        // Worst case: the 32-lot maximum plus the pool swap in one transaction.
        (
            "xToY",
            "token",
            "ckb",
            (0..32)
                .map(|i| (1_000_000_000_u128 + i, 200_000_000_u128 + i))
                .collect(),
            1_000_000_000,
        ),
    ] {
        let lots_at = order_cells(
            context,
            &code_hash,
            &order_dep,
            &fixture.holder_lock,
            &fixture.token_script,
            (offer, ask),
            &lots,
        );
        let n = lots_at.len();
        request["previous"] = json!(
            points[state_at..state_at + 3]
                .iter()
                .map(|p| describe(context, p))
                .collect::<Vec<_>>()
        );
        request["funding"] = json!(
            points[state_at + 3..]
                .iter()
                .map(|p| describe(context, p))
                .collect::<Vec<_>>()
        );
        request["action"] = json!(action);
        request["swapAmountIn"] = json!(amount_in.to_string());
        request["orders"] = json!({"codeHash":hex(&code_hash),"dep":hex(order_dep.as_slice()),
            "cells":lots_at.iter().map(|p|describe(context,p)).collect::<Vec<_>>()});
        let (tx, first) = build(&request);
        assert_eq!(
            first,
            n + 3,
            "{action}: wallet witness follows the pool inputs"
        );
        for (i, point) in lots_at.iter().enumerate() {
            assert_eq!(tx.inputs().get(i).unwrap().previous_output(), *point);
            assert_eq!(
                tx.outputs().get(i).unwrap().lock(),
                fixture.holder_lock,
                "{action}: payment {i}"
            );
        }
        assert_eq!(
            tx.inputs().get(n).unwrap().previous_output(),
            points[state_at]
        );
        let state = StateData::decode(&tx.outputs_data().get(n).unwrap().raw_data()).unwrap();
        assert_eq!((state.rx, state.ry), (n as u32 + 1, n as u32 + 2));
        let signed = sign(&tx, &fixture.creator, first);
        let cycles = context
            .verify_tx(&signed, CYCLES)
            .unwrap_or_else(|e| panic!("{action} split route rejected: {e}"));

        // Each mutation is re-signed by the wallet, so only the order lock or
        // the pool validator can be the reason it fails. Re-signing alone passes.
        context
            .verify_tx(&resign(&tx, &fixture.creator, first), CYCLES)
            .expect("re-signed unmodified split route");
        let mut outputs: Vec<_> = tx.outputs().into_iter().collect();
        let mut data: Vec<_> = tx.outputs_data().into_iter().collect();
        outputs.swap(0, 1);
        data.swap(0, 1);
        let swapped = tx
            .as_advanced_builder()
            .set_outputs(outputs)
            .set_outputs_data(data)
            .build();
        assert!(
            context
                .verify_tx(&resign(&swapped, &fixture.creator, first), CYCLES)
                .is_err(),
            "{action}: accepted maker payments in the wrong positions"
        );
        let short = if ask == "ckb" {
            let mut outputs: Vec<_> = tx.outputs().into_iter().collect();
            let paid: u64 = outputs[0].capacity().unpack();
            outputs[0] = outputs[0].clone().as_builder().capacity(paid - 1).build();
            tx.as_advanced_builder().set_outputs(outputs).build()
        } else {
            // Move one token unit from the maker payment to the wallet's token change.
            let mut data: Vec<_> = tx
                .outputs_data()
                .into_iter()
                .map(|d| d.raw_data().to_vec())
                .collect();
            let take = |d: &mut Vec<u8>, delta: i128| {
                let v = u128::from_le_bytes(d[..16].try_into().unwrap()) as i128 + delta;
                d[..16].copy_from_slice(&(v as u128).to_le_bytes());
            };
            take(&mut data[0], -1);
            let change = (n + 3..data.len())
                .find(|&i| tx.outputs().get(i).unwrap().type_().is_some())
                .expect("token change");
            take(&mut data[change], 1);
            tx.as_advanced_builder()
                .set_outputs_data(data.into_iter().map(|d| Bytes::from(d).pack()).collect())
                .build()
        };
        assert!(
            context
                .verify_tx(&resign(&short, &fixture.creator, first), CYCLES)
                .is_err(),
            "{action}: accepted an underpaid maker"
        );
        let mut witnesses: Vec<Bytes> = tx.witnesses().into_iter().map(|w| w.raw_data()).collect();
        witnesses.swap(0, n);
        let moved = tx
            .as_advanced_builder()
            .set_witnesses(witnesses.into_iter().map(|w| w.pack()).collect())
            .build();
        assert!(
            context
                .verify_tx(&resign(&moved, &fixture.creator, first), CYCLES)
                .is_err(),
            "{action}: accepted the pool action outside the state input's witness"
        );
        println!(
            "SPLIT action={action} lots={n} cycles={cycles} bytes={}",
            signed.data().as_slice().len()
        );
        points = register(context, &signed);
        state_at = n;
    }
}

/// Campaign target `split-vm`: a seeded walk of random split routes. Each case
/// places 1..=32 random lots (mostly few, sometimes the maximum), fills them with
/// a random pool swap in one SDK-built transaction, verifies it in CKB-VM and
/// continues from its outputs. Every case also re-signs one tampered copy that
/// the order lock or pool validator must reject.
pub(super) fn campaign(fixture: &mut SdkFixture, campaign: &crate::campaign::Campaign) {
    let binary = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../target/riscv64imac-unknown-none-elf/release/openswap-lock"
    ))
    .expect("build the order lock first");
    let code_hash = blake2b_256(&binary);
    let context = &mut fixture.context;
    let order_dep = context.deploy_cell(binary.into());
    let mut request = fixture.request.clone();
    let (genesis, first) = build(&request);
    let genesis = sign(&genesis, &fixture.creator, first);
    context.verify_tx(&genesis, CYCLES).unwrap();
    let mut points = register(context, &genesis);
    let mut state_at = 0;
    request["allowSkip"] = json!(true);
    let mut random = campaign.state(0x5b1d);
    let mut next = move |bound: u64| {
        random ^= random << 13;
        random ^= random >> 7;
        random ^= random << 17;
        random % bound
    };
    let (mut peak, mut max_bytes, mut max_lots, mut lots_filled) = (0, 0, 0, 0);
    let mut skips = std::collections::BTreeMap::<String, u64>::new();
    let mut applied = std::collections::BTreeMap::<&str, u64>::new();
    let mut rejected = std::collections::BTreeMap::<&str, u64>::new();
    campaign.run(|step| {
        let action = ["xToY", "yToX"][next(2) as usize];
        let (offer, ask) = if action == "xToY" {
            ("token", "ckb")
        } else {
            ("ckb", "token")
        };
        let n = match next(20) {
            0 => 13 + next(20) as usize,
            1..=5 => 5 + next(8) as usize,
            _ => 1 + next(4) as usize,
        };
        // Amounts span one base unit to 1,000 CKB / 10,000 tokens, with special edges.
        let mut amount = |max: u64| -> u128 {
            match next(8) {
                0 => 1,
                1 => max as u128,
                _ => 1 + next(max) as u128,
            }
        };
        let lots: Vec<(u128, u128)> = (0..n)
            .map(|_| {
                let (o, a) = if offer == "ckb" {
                    (amount(100_000_000_000), amount(1_000_000_000_000))
                } else {
                    (amount(1_000_000_000_000), amount(100_000_000_000))
                };
                (o, a)
            })
            .collect();
        let lots_at = order_cells(
            context,
            &code_hash,
            &order_dep,
            &fixture.holder_lock,
            &fixture.token_script,
            (offer, ask),
            &lots,
        );
        request["previous"] = json!(
            points[state_at..state_at + 3]
                .iter()
                .map(|p| describe(context, p))
                .collect::<Vec<_>>()
        );
        request["funding"] = json!(
            points[state_at + 3..]
                .iter()
                .map(|p| describe(context, p))
                .collect::<Vec<_>>()
        );
        request["action"] = json!(action);
        request["swapAmountIn"] = json!(
            (1 + next(if action == "xToY" {
                50_000_000_000
            } else {
                200_000_000_000
            }))
            .to_string()
        );
        request["orders"] = json!({"codeHash":hex(&code_hash),"dep":hex(order_dep.as_slice()),
            "cells":lots_at.iter().map(|p|describe(context,p)).collect::<Vec<_>>()});
        let (tx, first) = match build_or_skip(&request) {
            Ok(built) => built,
            Err(code) => {
                *skips.entry(format!("{action}:{code}")).or_default() += 1;
                return;
            }
        };
        assert_eq!(
            first,
            n + 3,
            "step={step}: wallet witness follows the pool inputs"
        );
        for (i, point) in lots_at.iter().enumerate() {
            assert_eq!(
                tx.inputs().get(i).unwrap().previous_output(),
                *point,
                "step={step}: lot {i}"
            );
            assert_eq!(
                tx.outputs().get(i).unwrap().lock(),
                fixture.holder_lock,
                "step={step}: payment {i}"
            );
        }
        assert_eq!(
            tx.inputs().get(n).unwrap().previous_output(),
            points[state_at],
            "step={step}: state input"
        );
        let state = StateData::decode(&tx.outputs_data().get(n).unwrap().raw_data()).unwrap();
        assert_eq!(
            (state.rx, state.ry),
            (n as u32 + 1, n as u32 + 2),
            "step={step}: reserve indices"
        );
        let signed = sign(&tx, &fixture.creator, first);
        let cycles = context
            .verify_tx(&signed, CYCLES)
            .unwrap_or_else(|e| panic!("step={step} {action} lots={n}: {e}"));
        let bytes = signed.data().as_slice().len();
        (peak, max_bytes) = (peak.max(cycles), max_bytes.max(bytes));
        // 32 lots paid in the token measure about 9.3 KB (each payment carries the type script).
        assert!(bytes <= 12_000, "step={step}: byte regression {bytes}");

        // One tamper per case, rotating; each copy is re-signed by the wallet.
        let k = next(n as u64) as usize;
        let mut outputs: Vec<_> = tx.outputs().into_iter().collect();
        let mut data: Vec<Vec<u8>> = tx
            .outputs_data()
            .into_iter()
            .map(|d| d.raw_data().to_vec())
            .collect();
        let mut witnesses: Vec<Bytes> = tx.witnesses().into_iter().map(|w| w.raw_data()).collect();
        let token_units = |d: &[u8]| u128::from_le_bytes(d[..16].try_into().unwrap());
        let kind = match step % 4 {
            0 if n >= 2
                && (outputs[0].as_slice(), &data[0]) != (outputs[1].as_slice(), &data[1]) =>
            {
                outputs.swap(0, 1);
                data.swap(0, 1);
                "swapped-payments"
            }
            1 => {
                witnesses.swap(0, n);
                "moved-action"
            }
            2 => {
                outputs[k] = outputs[k]
                    .clone()
                    .as_builder()
                    .lock(fixture.creator_lock.clone())
                    .build();
                "redirected-payment"
            }
            _ => {
                if ask == "ckb" {
                    let paid: u64 = outputs[k].capacity().unpack();
                    outputs[k] = outputs[k].clone().as_builder().capacity(paid - 1).build();
                } else {
                    // Move one token unit from maker payment k to a wallet token output.
                    let to = (n + 3..data.len())
                        .find(|&i| {
                            outputs[i].type_().is_some()
                                && outputs[i].lock() == fixture.creator_lock
                        })
                        .expect("wallet token output");
                    let (from, into) = (token_units(&data[k]) - 1, token_units(&data[to]) + 1);
                    data[k][..16].copy_from_slice(&from.to_le_bytes());
                    data[to][..16].copy_from_slice(&into.to_le_bytes());
                }
                "underpaid-maker"
            }
        };
        let tampered = tx
            .as_advanced_builder()
            .set_outputs(outputs)
            .set_outputs_data(data.into_iter().map(|d| Bytes::from(d).pack()).collect())
            .set_witnesses(witnesses.into_iter().map(|w| w.pack()).collect())
            .build();
        assert!(
            context
                .verify_tx(&resign(&tampered, &fixture.creator, first), CYCLES)
                .is_err(),
            "step={step} {action} lots={n}: accepted {kind} (lot {k})"
        );
        *rejected.entry(kind).or_default() += 1;
        *applied.entry(action).or_default() += 1;
        (max_lots, lots_filled) = (max_lots.max(n), lots_filled + n);
        points = register(context, &signed);
        state_at = n;
    });
    println!(
        "VM_ENDURANCE applied={applied:?} skipped={skips:?} lots_filled={lots_filled} max_lots={max_lots} tampered_rejected={rejected:?} peak_cycles={peak} max_bytes={max_bytes}"
    );
}
