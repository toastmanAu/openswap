//! Host-only harness. JSON never enters the no_std library or a contract.
use openswap_pool_arithmetic::{
    Error, Operation, Parameters, State, U256, create, sqrt_floor, transition,
};
use serde_json::{Value, json};
use std::io::{self, BufRead};

fn number(v: &Value) -> U256 {
    U256::from_dec_str(v.as_str().expect("decimal string")).expect("U256")
}
fn parameters(v: &Value) -> Parameters {
    Parameters {
        fee: number(&v["feeBps"]),
        locked: number(&v["lockedShares"]),
        backing_state: number(&v["backing"]["state"]),
        backing_ckb: number(&v["backing"]["ckb"]),
        backing_token: number(&v["backing"]["token"]),
    }
}
fn error(e: Error) -> &'static str {
    match e {
        Error::Range => "RANGE",
        Error::Overflow => "OVERFLOW",
        Error::State => "STATE",
        Error::ZeroOutput => "ZERO_OUTPUT",
        Error::Slippage => "SLIPPAGE",
        Error::Shares => "SHARES",
    }
}
fn check(v: &Value) -> Value {
    if v["kind"] == "sqrt" {
        return json!({"sqrt":sqrt_floor(number(&v["n"])).to_string()});
    }
    let s = &v["state"];
    let p = parameters(s);
    let a = &v["args"];
    let result = if v["kind"] == "create" {
        create(p, number(&a[0]), number(&a[1]), number(&a[2]))
    } else {
        let state = State {
            parameters: p,
            x: number(&s["x"]),
            y: number(&s["y"]),
            shares: number(&s["totalShares"]),
        };
        let op = match v["kind"].as_str().unwrap() {
            "xToY" | "yToX" => Operation::Swap {
                x_to_y: v["kind"] == "xToY",
                amount: number(&a[0]),
                minimum: number(&a[1]),
            },
            "deposit" => Operation::Deposit {
                max_x: number(&a[0]),
                max_y: number(&a[1]),
                minimum: number(&a[2]),
            },
            "withdraw" => Operation::Withdraw {
                shares: number(&a[0]),
                min_x: number(&a[1]),
                min_y: number(&a[2]),
            },
            _ => panic!("unknown vector operation"),
        };
        transition(state, op)
    };
    match result {
        Err(e) => json!({"error":error(e)}),
        Ok(r) => {
            let f = r.flows;
            let p = r.next.parameters;
            json!({"next":{"feeBps":p.fee.to_string(),"lockedShares":p.locked.to_string(),
                "backing":{"state":p.backing_state.to_string(),"ckb":p.backing_ckb.to_string(),"token":p.backing_token.to_string()},
                "x":r.next.x.to_string(),"y":r.next.y.to_string(),"totalShares":r.next.shares.to_string()},
                "flows":{"paidX":f.paid_x.to_string(),"paidY":f.paid_y.to_string(),"receivedX":f.received_x.to_string(),"receivedY":f.received_y.to_string(),
                "mintedShares":f.minted.to_string(),"burnedShares":f.burned.to_string(),"unusedX":f.unused_x.to_string(),"unusedY":f.unused_y.to_string()}})
        }
    }
}
fn main() {
    let mut count = 0;
    for line in io::stdin().lock().lines() {
        let v: Value = serde_json::from_str(&line.unwrap()).unwrap();
        assert_eq!(check(&v), v["expected"], "vector {}: {}", count, v);
        count += 1;
    }
    assert!(count > 0, "empty vector stream");
    println!("Matched {count} TypeScript/Rust vectors");
}
