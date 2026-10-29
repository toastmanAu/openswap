use crate::fixture::*;
use ckb_std::ckb_types::{bytes::Bytes, packed::Script, prelude::*};
use serde_json::Value;

fn hex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap();
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn num<T: std::str::FromStr>(v: &Value) -> T
where
    T::Err: std::fmt::Debug,
{
    v.as_str().unwrap().parse().unwrap()
}

#[test]
fn shared_wire_vectors() {
    let vectors: Value = serde_json::from_str(include_str!("../vectors/wire.json")).unwrap();
    for v in vectors.as_array().unwrap() {
        let bytes = hex(v["argsHex"].as_str().unwrap());
        let parsed = crate::wire_parser::owner_prefix(&bytes)
            .and_then(|owner| crate::wire_parser::terms(&bytes, &owner));
        if let Some(code) = v["errorCode"].as_i64() {
            assert_eq!(parsed.err().map(|e| e as i64), Some(code), "{}", v["name"]);
            continue;
        }
        let terms = parsed.unwrap_or_else(|e| panic!("{}: {e:?}", v["name"]));
        let t = &v["terms"];
        let owner = Script::from_slice(&hex(t["ownerScriptHex"].as_str().unwrap())).unwrap();
        let ask = t["askScriptHex"]
            .as_str()
            .map(|h| Script::from_slice(&hex(h)).unwrap());
        assert_eq!(terms.capacity_refund, num::<u64>(&t["capacityRefund"]));
        assert_eq!(terms.expiry, num::<u64>(&t["expiry"]));
        assert_eq!(terms.ask_amount, num::<u128>(&t["askAmount"]));
        assert_eq!(terms.offer_amount, num::<u128>(&t["offerAmount"]));
        assert_eq!(terms.min_fill, num::<u128>(&t["minFill"]));
        let nonce = hex(t["nonceHex"].as_str().unwrap());
        assert!(nonce.iter().all(|n| *n == nonce[0]));
        // The Rust encoder independently rebuilds identical bytes.
        let rebuilt = args(
            &owner,
            &Terms {
                refund: terms.capacity_refund,
                expiry: terms.expiry,
                ask,
                ask_amount: terms.ask_amount,
                offer_amount: terms.offer_amount,
                min_fill: terms.min_fill,
                nonce: nonce[0],
            },
        );
        assert_eq!(rebuilt, bytes, "{}", v["name"]);
    }
}

/// Every model verdict (accept or exact error code) holds on the real binary.
#[test]
fn shared_fill_vectors_match_the_model() {
    let vectors: Value = serde_json::from_str(include_str!("../vectors/fill.json")).unwrap();
    let mut env = Env::new();
    let (mut accepted, mut max_cycles) = (0, 0);
    for v in vectors.as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let t = &v["terms"];
        let pick = |env: &Env, label: &Value| match label.as_str() {
            None => None,
            Some("a") => Some(env.a.clone()),
            Some("b") => Some(env.b.clone()),
            Some(other) => panic!("type {other}"),
        };
        let terms = |nonce| Terms {
            refund: num(&t["capacityRefund"]),
            expiry: 0,
            ask: pick(&env, &t["ask"]),
            ask_amount: num(&t["askAmount"]),
            offer_amount: num(&t["offerAmount"]),
            min_fill: num(&t["minFill"]),
            nonce,
        };
        let (order_args, twin_args) = (args(&env.owner, &terms(1)), args(&env.owner, &terms(2)));
        let order_lock = env.lock(order_args);
        let twin = env.lock(twin_args);
        let index = v["index"].as_u64().unwrap() as usize;
        let mut inputs = vec![];
        for _ in 0..index {
            let filler = cell(&env.other.clone(), None, 61 * CKB);
            inputs.push(env.input(filler, Bytes::new(), 0));
        }
        let o = &v["order"];
        let order = cell(
            &order_lock,
            pick(&env, &o["type"]).as_ref(),
            num(&o["capacity"]),
        );
        inputs.push(env.input(order, hex(o["data"].as_str().unwrap()).into(), 0));
        let outputs = v["outputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|out| {
                let lock = match out["lock"].as_str().unwrap() {
                    "owner" => env.owner.clone(),
                    "order" => order_lock.clone(),
                    "twin" => twin.clone(),
                    _ => env.other.clone(),
                };
                let type_ = pick(&env, &out["type"]);
                (
                    cell(&lock, type_.as_ref(), num(&out["capacity"])),
                    Bytes::from(hex(out["data"].as_str().unwrap())),
                )
            })
            .collect();
        let tx = env.tx(inputs, outputs);
        let code = v["expected"].as_i64().unwrap() as i8;
        let cycles = env.expect(&tx, code, name);
        if code == 0 {
            accepted += 1;
            max_cycles = max_cycles.max(cycles);
        }
    }
    println!("accepted={accepted} max_cycles={max_cycles}");
    assert!(accepted > 300);
}
