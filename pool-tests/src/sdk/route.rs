//! Two-pool routes: token A -> CKB -> token B through two pools in one
//! transaction. The real pool validator (once per pool), xUDT for both tokens and
//! secp all execute on bytes from the production TypeScript route builder.
use super::*;

fn token(context: &mut Context, code: &OutPoint, owner: u8) -> Script {
    context
        .build_script_with_hash_type(code, ScriptHashType::Data1, Bytes::from(vec![owner; 32]))
        .unwrap()
}

fn resign(tx: &TransactionView, key: &Privkey, first: usize) -> TransactionView {
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

fn shift_tokens(tx: &TransactionView, from: usize, to: usize) -> TransactionView {
    let mut data: Vec<Vec<u8>> = tx
        .outputs_data()
        .into_iter()
        .map(|d| d.raw_data().to_vec())
        .collect();
    let mut add = |i: usize, delta: i128| {
        let v = u128::from_le_bytes(data[i][..16].try_into().unwrap()) as i128 + delta;
        data[i][..16].copy_from_slice(&(v as u128).to_le_bytes());
    };
    add(from, -1);
    add(to, 1);
    tx.as_advanced_builder()
        .set_outputs_data(data.into_iter().map(|d| Bytes::from(d).pack()).collect())
        .build()
}

fn shift_capacity(tx: &TransactionView, from: usize, to: usize) -> TransactionView {
    let mut outputs: Vec<CellOutput> = tx.outputs().into_iter().collect();
    let take = |o: &CellOutput, delta: i64| {
        let c: u64 = o.capacity().unpack();
        o.clone()
            .as_builder()
            .capacity((c as i64 + delta) as u64)
            .build()
    };
    outputs[from] = take(&outputs[from], -100_000_000);
    outputs[to] = take(&outputs[to], 100_000_000);
    tx.as_advanced_builder().set_outputs(outputs).build()
}

pub(super) fn run(fixture: &mut SdkFixture) {
    let token_a = fixture.token_script.clone();
    let code = fixture.token.clone();
    let token_b = token(&mut fixture.context, &code, 0x22);
    let creator = fixture.creator.clone();
    let lock = fixture.creator_lock.clone();
    let context = &mut fixture.context;

    // Pool A pairs CKB with token A (owner 0x11), pool B with token B (0x22).
    let mut request = fixture.request.clone();
    let (genesis, first) = build(&request);
    let genesis = sign(&genesis, &creator, first);
    context.verify_tx(&genesis, CYCLES).unwrap();
    let mut pool_a: Vec<OutPoint> = register(context, &genesis)[..3].to_vec();

    let funding_b = context.create_cell(cell(&lock, Some(&token_b), FUNDING), amount(TOKENS));
    request["funding"] = json!([describe(context, &funding_b)]);
    request["tokenOwner"] = json!(hex(&[0x22; 32]));
    request["initial"] =
        json!({"fee":"30","locked":"1000","x":"2000000000000","y":"1000000000000"});
    let (genesis, first) = build(&request);
    let genesis = sign(&genesis, &creator, first);
    context.verify_tx(&genesis, CYCLES).unwrap();
    let mut pool_b: Vec<OutPoint> = register(context, &genesis)[..3].to_vec();

    // Second round spends both pools' outputs of the first route, which share
    // one transaction hash: each pool must still find only its own reserves.
    for (round, (pay, receive, amount_in)) in [
        (&token_a, &token_b, 40_000_000_000_u128),
        (&token_b, &token_a, 5_000_000_000_u128),
        (&token_a, &token_b, 1_u128 << 40),
    ]
    .into_iter()
    .enumerate()
    {
        let forward = pay == &token_a;
        let (from, to) = if forward {
            (&pool_a, &pool_b)
        } else {
            (&pool_b, &pool_a)
        };
        let funding = context.create_cell(cell(&lock, Some(pay), FUNDING), amount(TOKENS));
        let plain = context.create_cell(cell(&lock, None, FUNDING), Bytes::new());
        let mut route = request.clone();
        route["funding"] = json!([describe(context, &funding), describe(context, &plain)]);
        route["route"] = json!({
            "pools":[from.iter().map(|p|describe(context,p)).collect::<Vec<_>>(),to.iter().map(|p|describe(context,p)).collect::<Vec<_>>()],
            "amountIn":amount_in.to_string(),"minOut":"1"});
        let reply = bridge(&route);
        let tx = Transaction::from_slice(&unhex(reply["transaction"].as_str().unwrap()))
            .unwrap()
            .into_view();
        let first = reply["walletWitnessIndex"].as_u64().unwrap() as usize;
        assert_eq!(first, 6, "round {round}: wallet witness follows both pools");
        for (i, point) in from.iter().chain(to.iter()).enumerate() {
            assert_eq!(tx.inputs().get(i).unwrap().previous_output(), *point);
        }
        for (state_at, rx) in [(0, 1), (3, 4)] {
            let state =
                StateData::decode(&tx.outputs_data().get(state_at).unwrap().raw_data()).unwrap();
            assert_eq!((state.rx, state.ry), (rx, rx + 1), "round {round}");
        }
        // Token B receipt at 6 pays the wallet the second leg's exact output.
        let receipt = tx.outputs().get(6).unwrap();
        assert_eq!(receipt.lock(), lock);
        assert_eq!(receipt.type_().to_opt().unwrap(), *receive);
        let out = u128::from_le_bytes(
            tx.outputs_data().get(6).unwrap().raw_data()[..16]
                .try_into()
                .unwrap(),
        );
        assert_eq!(
            out.to_string(),
            reply["hops"][1]["out"].as_str().unwrap(),
            "round {round}"
        );
        assert_eq!(reply["hops"][0]["out"], reply["hops"][1]["amountIn"]);

        let signed = sign(&tx, &creator, first);
        let cycles = context
            .verify_tx(&signed, CYCLES)
            .unwrap_or_else(|e| panic!("round {round}: route rejected: {e}"));
        println!(
            "ROUTE round={round} cycles={cycles} bytes={} hop={}",
            signed.data().serialized_size_in_block(),
            reply["hops"][0]["out"]
        );
        context
            .verify_tx(&resign(&tx, &creator, first), CYCLES)
            .expect("re-signed unmodified route");

        // Each tamper is re-signed, so only a pool validator can reject it.
        let mut witnesses: Vec<_> = tx.witnesses().into_iter().collect();
        witnesses.swap(0, 3);
        let moved = tx.as_advanced_builder().set_witnesses(witnesses).build();
        let taken_from_b = shift_tokens(&tx, 5, 6);
        let ckb_from_a = shift_capacity(&tx, 1, tx.outputs().len() - 1);
        let ckb_from_b = shift_capacity(&tx, 4, tx.outputs().len() - 1);
        for (name, bad) in [
            ("swapped pool actions", moved),
            ("token taken from the second pool", taken_from_b),
            ("CKB taken from the first pool", ckb_from_a),
            ("CKB taken from the second pool", ckb_from_b),
        ] {
            assert!(
                context
                    .verify_tx(&resign(&bad, &creator, first), CYCLES)
                    .is_err(),
                "round {round}: accepted {name}"
            );
        }

        let points = register(context, &signed);
        let (next_from, next_to) = (points[0..3].to_vec(), points[3..6].to_vec());
        if forward {
            pool_a = next_from;
            pool_b = next_to;
        } else {
            pool_b = next_from;
            pool_a = next_to;
        }
    }
}
