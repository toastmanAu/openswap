//! Host-only bridge for independently encoded TypeScript wire vectors.
use openswap_pool_arithmetic::wire::*;
use serde_json::{Value, json};
use std::io::{self, BufRead};

fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2));
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn args(a: Args) -> Value {
    json!({"role":a.role as u8,"poolId":hex(&a.pool_id)})
}
fn action(a: Action) -> Value {
    let (tag, values) = match a {
        Action::Create { minimum } => (0, vec![minimum]),
        Action::Swap {
            x_to_y,
            amount,
            minimum,
        } => (if x_to_y { 1 } else { 2 }, vec![amount, minimum]),
        Action::Deposit {
            max_x,
            max_y,
            minimum,
        } => (3, vec![max_x, max_y, minimum]),
        Action::Withdraw {
            shares,
            min_x,
            min_y,
        } => (4, vec![shares, min_x, min_y]),
    };
    json!({"tag":tag,"values":values.iter().map(u128::to_string).collect::<Vec<_>>()})
}
fn check(kind: &str, data: &[u8]) -> Result<Value, Error> {
    Ok(match kind {
        "args" => {
            let a = Args::decode(data)?;
            assert_eq!(a.encode(), data);
            args(a)
        }
        "state" => {
            let s = StateData::decode(data)?;
            assert_eq!(s.encode()?, data);
            json!({"fee":s.fee.to_string(),"locked":s.locked.to_string(),"shares":s.shares.to_string(),
                "backingState":s.backing_state.to_string(),"backingCkb":s.backing_ckb.to_string(),"backingToken":s.backing_token.to_string(),
                "rx":s.rx.to_string(),"ry":s.ry.to_string(),"tokenCodeHash":hex(&s.token_code_hash),"tokenOwner":hex(&s.token_owner)})
        }
        "action" => {
            let a = Action::decode(data)?;
            let mut encoded = [0; ACTION_MAX_LEN];
            let len = a.encode(&mut encoded)?;
            assert_eq!(&encoded[..len], data);
            action(a)
        }
        "script" => {
            let (h, a) = decode_pool_script(data)?;
            assert_eq!(encode_pool_script(h, a), data);
            json!({"codeHash":hex(&h),"args":args(a)})
        }
        "genesisWitness" => action(decode_witness(data, Phase::Genesis)?),
        "transitionWitness" => action(decode_witness(data, Phase::Transition)?),
        _ => panic!("unknown wire kind"),
    })
}
fn main() {
    let mut count = 0;
    for line in io::stdin().lock().lines() {
        let v: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let got = match check(
            v["kind"].as_str().unwrap(),
            &unhex(v["hex"].as_str().unwrap()),
        ) {
            Ok(value) => json!({"ok":value}),
            Err(error) => json!({"error":error as u8}),
        };
        assert_eq!(got, v["expected"], "wire vector {count}: {v}");
        count += 1;
    }
    assert!(count > 0, "empty vector stream");
    println!("Matched {count} TypeScript/Rust wire vectors");
}
