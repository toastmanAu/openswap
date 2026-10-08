//! Composed resource fixtures, not a production batching builder.
use super::*;
use ckb_testtool::{builtin::ALWAYS_SUCCESS, ckb_types::core::TransactionBuilder};

fn sign_group(
    context: &Context,
    tx: &TransactionView,
    key: &Privkey,
    owner: &Script,
) -> TransactionView {
    let indexes: Vec<_> = tx
        .inputs()
        .into_iter()
        .enumerate()
        .filter_map(|(i, input)| {
            (context.get_cell(&input.previous_output()).unwrap().0.lock() == *owner).then_some(i)
        })
        .collect();
    let first = indexes[0];
    let mut witnesses: Vec<_> = tx.witnesses().into_iter().map(|w| w.raw_data()).collect();
    let args = WitnessArgs::new_builder()
        .lock(Some(Bytes::from(vec![0; 65])).pack())
        .build();
    witnesses[first] = args.as_bytes();
    let mut digest = new_blake2b();
    digest.update(tx.hash().as_slice());
    for i in indexes
        .into_iter()
        .chain(tx.inputs().len()..witnesses.len())
    {
        digest.update(&(witnesses[i].len() as u64).to_le_bytes());
        digest.update(&witnesses[i]);
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

pub(super) fn run(
    context: &mut Context,
    base: &Value,
    key: &Privkey,
    owner: &Script,
    token: &Script,
) {
    // Wide padding uses a synthetic ALWAYS_SUCCESS lock. All economically
    // relevant wallet cells still execute real secp; padding is not a wallet claim.
    let padding_code = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let wide = context
        .build_script_with_hash_type(
            &padding_code,
            ScriptHashType::Data1,
            Bytes::from(vec![0; 459]),
        )
        .unwrap();
    assert_eq!(wide.as_slice().len(), 512);
    let mut transitions = Vec::new();
    for _ in 0..4 {
        let mut request = base.clone();
        request.as_object_mut().unwrap().remove("previous");
        request.as_object_mut().unwrap().remove("random");
        let funding = context.create_cell(cell(owner, Some(token), FUNDING), amount(TOKENS));
        request["funding"] = json!([describe(context, &funding)]);
        let (tx, first) = build(&request);
        let tx = sign(&tx, key, first);
        context.verify_tx(&tx, CYCLES).unwrap();
        let points = register(context, &tx);
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
        transitions.push(build(&request).0);
    }
    for pools in [1, 2, 4] {
        let mut inputs = Vec::new();
        let mut outputs = Vec::new();
        let mut data = Vec::new();
        let mut witnesses = Vec::new();
        let mut states = Vec::new();
        for tx in &transitions[..pools] {
            let offset = outputs.len() as u32;
            states.push(inputs.len());
            inputs.extend(tx.inputs());
            outputs.extend(tx.outputs());
            let mut local: Vec<_> = tx.outputs_data().into_iter().collect();
            let mut metadata = StateData::decode(&local[0].raw_data()).unwrap();
            metadata.rx += offset;
            metadata.ry += offset;
            local[0] = Bytes::from(metadata.encode().unwrap().to_vec()).pack();
            data.extend(local);
            let action =
                WitnessArgs::from_slice(&tx.witnesses().get(0).unwrap().raw_data()).unwrap();
            let empty = action
                .clone()
                .as_builder()
                .lock(Some(Bytes::new()).pack())
                .build();
            let padded = action
                .as_builder()
                .lock(Some(Bytes::from(vec![0; 4096 - empty.as_slice().len()])).pack())
                .build();
            assert_eq!(padded.as_slice().len(), 4096);
            witnesses.push(padded.as_bytes().pack());
            witnesses.extend((1..tx.inputs().len()).map(|_| Bytes::new().pack()));
        }
        let change = outputs.len() - 1;
        let extra_inputs = 256 - inputs.len();
        let extra_outputs = 256 - outputs.len();
        const PAD: u64 = 100_000_000_000;
        for _ in 0..extra_inputs {
            let point = context.create_cell(cell(&wide, None, PAD), Bytes::new());
            inputs.push(CellInput::new_builder().previous_output(point).build());
            witnesses.push(Bytes::new().pack());
        }
        for _ in 0..extra_outputs {
            outputs.push(cell(&wide, None, PAD));
            data.push(Bytes::new().pack());
        }
        let capacity: u64 = outputs[change].capacity().unpack();
        outputs[change] = outputs[change]
            .clone()
            .as_builder()
            .capacity(capacity + (extra_inputs as u64) * PAD - (extra_outputs as u64) * PAD)
            .build();
        let mut deps: Vec<_> = transitions[0].cell_deps().into_iter().collect();
        witnesses[3] = WitnessArgs::new_builder()
            .lock(Some(Bytes::from(vec![0; 65])).pack())
            .build()
            .as_bytes()
            .pack();
        deps.push(
            CellDep::new_builder()
                .out_point(padding_code.clone())
                .build(),
        );
        let unsigned = TransactionBuilder::default()
            .inputs(inputs)
            .outputs(outputs)
            .outputs_data(data)
            .cell_deps(deps)
            .witnesses(witnesses)
            .build();
        let input_capacity: u64 = unsigned
            .inputs()
            .into_iter()
            .map(|input| {
                let value: u64 = context
                    .get_cell(&input.previous_output())
                    .unwrap()
                    .0
                    .capacity()
                    .unpack();
                value
            })
            .sum();
        let output_capacity: u64 = unsigned
            .outputs()
            .into_iter()
            .map(|out| {
                let value: u64 = out.capacity().unpack();
                value
            })
            .sum();
        // Reprice the composed fixture at 1000 shannons/1000 bytes, including
        // the serialized-size prefix, rather than retaining individual fees.
        let fee = unsigned.data().as_slice().len() as u64 + 4;
        let delta = fee.checked_sub(input_capacity - output_capacity).unwrap();
        let mut outputs: Vec<_> = unsigned.outputs().into_iter().collect();
        let capacity: u64 = outputs[change].capacity().unpack();
        outputs[change] = outputs[change]
            .clone()
            .as_builder()
            .capacity(capacity - delta)
            .build();
        let unsigned = unsigned.as_advanced_builder().set_outputs(outputs).build();
        let signed = sign_group(context, &unsigned, key, owner);
        assert_eq!(signed.inputs().len(), 256);
        assert_eq!(signed.outputs().len(), 256);
        assert_eq!(signed.data().as_slice().len() as u64 + 4, fee);
        // Rounded ceilings retain at least ~25% over the observed cycle peaks.
        let (ceiling, byte_ceiling) = match pools {
            1 => (80_000_000, 160_000),
            2 => (155_000_000, 165_000),
            4 => (305_000_000, 170_000),
            _ => unreachable!(),
        };
        assert!(signed.data().as_slice().len() <= byte_ceiling);
        let cycles = context.verify_tx(&signed, ceiling).unwrap();
        println!(
            "ENVELOPE pools={pools} inputs=256 outputs=256 script_bytes=512 action_witness_bytes=4096 tx_bytes={} fee={fee} cycles={cycles} ceiling={ceiling} byte_ceiling={byte_ceiling}",
            signed.data().as_slice().len()
        );
        assert!(context.verify_tx(&unsigned, ceiling).is_err());
        if pools == 2 {
            let mut ws: Vec<_> = unsigned.witnesses().into_iter().collect();
            let args = WitnessArgs::from_slice(&ws[states[0]].raw_data()).unwrap();
            let mut padding = args.lock().to_opt().unwrap().raw_data().to_vec();
            padding.push(0);
            ws[states[0]] = args
                .as_builder()
                .lock(Some(Bytes::from(padding)).pack())
                .build()
                .as_bytes()
                .pack();
            let too_wide = unsigned.as_advanced_builder().set_witnesses(ws).build();
            rejects_bound(
                context,
                &sign_group(context, &too_wide, key, owner),
                "witness",
            );
            let extra = context.create_cell(cell(&wide, None, PAD), Bytes::new());
            let too_many = unsigned
                .as_advanced_builder()
                .input(CellInput::new_builder().previous_output(extra).build())
                .witness(Bytes::new().pack())
                .build();
            rejects_bound(
                context,
                &sign_group(context, &too_many, key, owner),
                "input count",
            );
            let mut out: Vec<_> = unsigned.outputs().into_iter().collect();
            let bad_lock = wide
                .clone()
                .as_builder()
                .args(Bytes::from(vec![0; 460]).pack())
                .build();
            out[255] = out[255].clone().as_builder().lock(bad_lock).build();
            let too_wide = unsigned.as_advanced_builder().set_outputs(out).build();
            rejects_bound(
                context,
                &sign_group(context, &too_wide, key, owner),
                "script",
            );
            // Split padding so capacity still balances at 257 outputs.
            let mut out: Vec<_> = unsigned.outputs().into_iter().collect();
            out[255] = cell(owner, None, PAD / 2);
            out.push(cell(owner, None, PAD / 2));
            let too_many = unsigned
                .as_advanced_builder()
                .set_outputs(out)
                .output_data(Bytes::new().pack())
                .build();
            rejects_bound(
                context,
                &sign_group(context, &too_many, key, owner),
                "output count",
            );
        }
    }
}
fn rejects_bound(context: &Context, tx: &TransactionView, label: &str) {
    let error = context.verify_tx(tx, 155_000_000).unwrap_err().to_string();
    assert!(error.contains("error code 2"), "{label}: {error}");
}
