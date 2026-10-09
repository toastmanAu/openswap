//! All-real-wallet compositions. This is a test composer, not an SDK API.
use super::*;
use ckb_testtool::ckb_types::core::{Capacity, TransactionBuilder};
use std::collections::HashSet;

const CELL_LIMIT: usize = 256;

struct Owner {
    key: Privkey,
    lock: Script,
}

fn owner(template: &Script, index: usize) -> Owner {
    // Public fixture keys only. These bytes are never read from wallet files.
    let key = Privkey::from_slice(&[index as u8 + 1; 32]);
    let lock = template
        .clone()
        .as_builder()
        .args(Bytes::from(blake2b_256(key.pubkey().unwrap().serialize())[..20].to_vec()).pack())
        .build();
    Owner { key, lock }
}

fn transition(fixture: &mut SdkFixture, owner: &Owner) -> TransactionView {
    let context = &mut fixture.context;
    let mut request = fixture.request.clone();
    request["lock"] = json!(hex(owner.lock.as_slice()));
    let point = context.create_cell(
        cell(&owner.lock, Some(&fixture.token_script), FUNDING),
        amount(TOKENS),
    );
    request["funding"] = json!([describe(context, &point)]);
    let (genesis, first) = build(&request);
    let genesis = sign(&genesis, &owner.key, first);
    context.verify_tx(&genesis, 6_000_000).unwrap();
    let points = register(context, &genesis);
    request["previous"] = json!(
        points[..3]
            .iter()
            .map(|p| describe(context, p))
            .collect::<Vec<_>>()
    );
    request["funding"] = json!(
        points[3..]
            .iter()
            .map(|p| describe(context, p))
            .collect::<Vec<_>>()
    );
    request["action"] = json!("deposit");
    let (tx, first) = build(&request);
    assert_eq!(first, 3);
    for (input, point) in tx.inputs().into_iter().zip(&points) {
        assert_eq!(input.previous_output(), *point);
        assert_eq!(point.tx_hash(), genesis.hash());
    }
    assert_eq!(tx.inputs().len(), points.len());
    tx
}

fn capacity_in(context: &Context, tx: &TransactionView) -> u64 {
    tx.inputs()
        .into_iter()
        .map(|input| {
            let capacity: u64 = context
                .get_cell(&input.previous_output())
                .unwrap()
                .0
                .capacity()
                .unpack();
            capacity
        })
        .sum()
}

fn capacity_out(tx: &TransactionView) -> u64 {
    tx.outputs()
        .into_iter()
        .map(|output| {
            let capacity: u64 = output.capacity().unpack();
            capacity
        })
        .sum()
}

fn compose(
    context: &Context,
    transitions: &[TransactionView],
    owners: &[Owner],
) -> (TransactionView, Vec<usize>) {
    let mut inputs = Vec::new();
    let mut outputs = Vec::new();
    let mut data = Vec::new();
    let mut witnesses = Vec::new();
    let mut consumed = HashSet::new();
    let mut identities = HashSet::new();
    let deps = transitions[0].cell_deps();
    for tx in transitions {
        assert_eq!(
            tx.cell_deps().as_slice(),
            deps.as_slice(),
            "explicit identical dependencies"
        );
        assert!(identities.insert(tx.outputs().get(0).unwrap().type_().to_opt().unwrap()));
        let offset = outputs.len() as u32;
        for input in tx.inputs() {
            assert!(
                consumed.insert(input.previous_output()),
                "duplicate composed input"
            );
            inputs.push(input);
        }
        outputs.extend(tx.outputs());
        let mut local: Vec<_> = tx.outputs_data().into_iter().collect();
        let mut state = StateData::decode(&local[0].raw_data()).unwrap();
        state.rx += offset;
        state.ry += offset;
        local[0] = Bytes::from(state.encode().unwrap().to_vec()).pack();
        data.extend(local);
        // Preserve the action at its absolute state input position; signature
        // placeholders are inserted once per actual lock group below.
        witnesses.push(tx.witnesses().get(0).unwrap());
        witnesses.extend((1..tx.inputs().len()).map(|_| Bytes::new().pack()));
    }
    assert!(inputs.len() <= CELL_LIMIT && outputs.len() <= CELL_LIMIT);
    let mut firsts = Vec::new();
    for owner in owners {
        let first = inputs
            .iter()
            .position(|input| {
                context.get_cell(&input.previous_output()).unwrap().0.lock() == owner.lock
            })
            .unwrap();
        witnesses[first] = WitnessArgs::new_builder()
            .lock(Some(Bytes::from(vec![0; 65])).pack())
            .build()
            .as_bytes()
            .pack();
        firsts.push(first);
    }
    assert_eq!(firsts.iter().collect::<HashSet<_>>().len(), owners.len());
    let unsigned = TransactionBuilder::default()
        .inputs(inputs)
        .outputs(outputs)
        .outputs_data(data)
        .cell_deps(deps)
        .witnesses(witnesses)
        .build();
    let fee = unsigned.data().as_slice().len() as u64 + 4;
    // Reprice the complete transaction, allowing individual SDK fees to be
    // refunded as well as increased. Only ordinary final wallet change moves.
    let mut outputs: Vec<_> = unsigned.outputs().into_iter().collect();
    let change = outputs.last_mut().unwrap();
    assert!(change.type_().to_opt().is_none());
    let old: u64 = change.capacity().unpack();
    let available = old
        .checked_add(capacity_in(context, &unsigned) - capacity_out(&unsigned))
        .unwrap();
    *change = change
        .clone()
        .as_builder()
        .capacity(available.checked_sub(fee).unwrap())
        .build();
    let unsigned = unsigned.as_advanced_builder().set_outputs(outputs).build();
    for (output, data) in unsigned.outputs_with_data_iter() {
        let capacity: u64 = output.capacity().unpack();
        assert!(
            capacity
                >= output
                    .occupied_capacity(Capacity::bytes(data.len()).unwrap())
                    .unwrap()
                    .as_u64()
        );
    }
    assert_eq!(
        capacity_in(context, &unsigned) - capacity_out(&unsigned),
        fee
    );
    (unsigned, firsts)
}

fn replace_witness(tx: &TransactionView, index: usize, witness: Bytes) -> TransactionView {
    let mut witnesses: Vec<_> = tx.witnesses().into_iter().collect();
    witnesses[index] = witness.pack();
    tx.as_advanced_builder().set_witnesses(witnesses).build()
}

fn rejects_owner(context: &Context, tx: &TransactionView, first: usize, ceiling: u64, label: &str) {
    let error = context.verify_tx(tx, ceiling).unwrap_err().to_string();
    // Do not accept resource exhaustion or a different pool/type failure as
    // proof of signature enforcement. Attribute failure to this lock group.
    assert!(
        error.contains(&format!("Inputs[{first}].Lock")),
        "{label}: {error}"
    );
    assert!(error.contains("ValidationFailure"), "{label}: {error}");
}

pub(super) fn run(fixture: &mut SdkFixture) {
    let first_owner = owner(&fixture.creator_lock, 0);
    let first_tx = transition(fixture, &first_owner);
    let (per_input, per_output) = (first_tx.inputs().len(), first_tx.outputs().len());
    let max_pools = (CELL_LIMIT / per_input).min(CELL_LIMIT / per_output);
    assert_eq!(
        (per_input, per_output, max_pools),
        (6, 7, 36),
        "review layout/budget changes"
    );
    assert!((max_pools + 1) * per_input > CELL_LIMIT || (max_pools + 1) * per_output > CELL_LIMIT);
    let mut owners = vec![first_owner];
    let mut transitions = vec![first_tx];
    for index in 1..max_pools {
        let next = owner(&fixture.creator_lock, index);
        transitions.push(transition(fixture, &next));
        owners.push(next);
    }
    // Two owners each span two pools, separated by a different owner's inputs.
    let interleaved = vec![
        transitions[0].clone(),
        transitions[1].clone(),
        transition(fixture, &owners[0]),
        transition(fixture, &owners[1]),
    ];
    // Rounded >=125% of measured cycle peaks; byte caps bound these fixed
    // compact layouts, not arbitrary witness/script sizes or relay policy.
    for (txs, keys, ceiling, byte_ceiling) in [
        (interleaved.as_slice(), &owners[..2], 33_000_000, 9_000),
        (&transitions[..8], &owners[..8], 120_000_000, 17_000),
        (&transitions[..16], &owners[..16], 415_000_000, 34_000),
        (
            transitions.as_slice(),
            owners.as_slice(),
            1_920_000_000,
            75_000,
        ),
    ] {
        let context = &fixture.context;
        let (unsigned, firsts) = compose(context, txs, keys);
        let mut signed = unsigned.clone();
        for key in keys {
            signed = resource::sign_group(context, &signed, &key.key, &key.lock);
        }
        let cycles = context.verify_tx(&signed, ceiling).unwrap();
        let size = signed.data().as_slice().len();
        let fee = capacity_in(context, &signed) - capacity_out(&signed);
        assert_eq!(fee, size as u64 + 4);
        assert!(size <= byte_ceiling);
        println!(
            "COMPOSITION pools={} owners={} inputs={} outputs={} tx_bytes={size} fee={fee} cycles={cycles} ceiling={ceiling} byte_ceiling={byte_ceiling}",
            txs.len(),
            keys.len(),
            signed.inputs().len(),
            signed.outputs().len()
        );
        for (index, first) in firsts.iter().copied().enumerate() {
            let missing = replace_witness(
                &signed,
                first,
                unsigned.witnesses().get(first).unwrap().raw_data(),
            );
            rejects_owner(context, &missing, first, ceiling, "missing signature");
            // Exhaust all groups in the interleaved fixture; also test the last
            // distinct owner at every larger measured size.
            if txs.len() == 4 || index + 1 == keys.len() {
                let wrong = resource::sign_group(
                    context,
                    &signed,
                    &keys[(index + 1) % keys.len()].key,
                    &keys[index].lock,
                );
                rejects_owner(context, &wrong, first, ceiling, "wrong owner");
                let args =
                    WitnessArgs::from_slice(&signed.witnesses().get(first).unwrap().raw_data())
                        .unwrap();
                let mut signature = args.lock().to_opt().unwrap().raw_data().to_vec();
                signature[0] ^= 1;
                let tampered = replace_witness(
                    &signed,
                    first,
                    args.as_builder()
                        .lock(Some(Bytes::from(signature)).pack())
                        .build()
                        .as_bytes(),
                );
                rejects_owner(context, &tampered, first, ceiling, "tampered signature");
                // A later group witness is covered even when another owner's
                // pool/wallet inputs intervene. Raw transaction stays unchanged.
                let later = signed
                    .inputs()
                    .into_iter()
                    .enumerate()
                    .filter(|(_, input)| {
                        context.get_cell(&input.previous_output()).unwrap().0.lock()
                            == keys[index].lock
                    })
                    .last()
                    .unwrap()
                    .0;
                assert!(later > first);
                if txs.len() == 4 {
                    assert!(
                        later > first + per_input,
                        "must cross the other owner's pool"
                    );
                }
                let altered = replace_witness(&signed, later, Bytes::from(vec![1]));
                assert_eq!(altered.hash(), signed.hash());
                rejects_owner(
                    context,
                    &altered,
                    first,
                    ceiling,
                    "later group witness mutation",
                );
            }
        }
        println!(
            "COMPOSITION_AUTH pools={} missing_checks={} wrong_tampered_later_checks={}",
            txs.len(),
            keys.len(),
            if txs.len() == 4 { 6 } else { 3 }
        );
    }
}
