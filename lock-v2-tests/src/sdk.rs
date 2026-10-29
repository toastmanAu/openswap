//! Replay SDK-planned v2 order chains on the real binary.
use crate::fixture::*;
use ckb_testtool::ckb_types::{bytes::Bytes, packed::*, prelude::*};
use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .fold(String::from("0x"), |s, b| s + &format!("{b:02x}"))
}
fn unhex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap();
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn cell_of(v: &Value) -> (CellOutput, Bytes) {
    (
        CellOutput::from_slice(&unhex(v["output"].as_str().unwrap())).unwrap(),
        unhex(v["data"].as_str().unwrap()).into(),
    )
}
fn bridge(request: &Value) -> Value {
    let mut child = Command::new("node")
        .args(["node_modules/tsx/dist/cli.mjs", "sdk/test/v2-vm-bridge.ts"])
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/.."))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("npm ci and Node are required for SDK VM tests");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn sdk_planned_order_chains_verify_on_the_binary() {
    let mut env = Env::new();
    let code_hash = {
        let probe = env.lock(vec![]);
        hex(probe.code_hash().as_slice())
    };
    let campaign = crate::campaign::Campaign::from_env("lock-v2-sdk", 1);
    let mut seed = campaign.state(0x7632_5f73_646b_0001);
    let mut total = (0, 0, 0);
    campaign.run(|_| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let reply = bridge(&json!({
            "codeHash": code_hash,
            "owner": hex(env.owner.as_slice()),
            "a": hex(env.a.as_slice()),
            "b": hex(env.b.as_slice()),
            "seed": (seed >> 1).to_string(),
            "count": 30,
        }));
        for scenario in reply["scenarios"].as_array().unwrap() {
            let (order, data) = cell_of(&scenario["order"]);
            let mut current = (order, data);
            let steps = scenario["steps"].as_array().unwrap();
            for (k, step) in steps.iter().enumerate() {
                let other = env.other.clone();
                let input = env.input(current.0.clone(), current.1.clone(), 0);
                let funding = env.input(cell(&other, None, 100_000 * CKB), Bytes::new(), 0);
                let mut outputs = vec![cell_of(&step["payment"])];
                let remainder = step.get("remainder").filter(|r| !r.is_null()).map(cell_of);
                if let Some(r) = &remainder {
                    outputs.push(r.clone());
                }
                let tx = env.tx(vec![input, funding], outputs);
                let label = format!("{} step {k}", scenario["shape"]);
                env.expect(&tx, 0, &label);
                match remainder {
                    Some(r) => {
                        assert_eq!(r.0.lock(), current.0.lock(), "{label}: lock kept");
                        current = r;
                        total.1 += 1;
                    }
                    None => assert_eq!(k, steps.len() - 1, "{label}: final is last"),
                }
            }
            total.0 += 1;
            total.2 += steps.len();
        }
    });
    println!(
        "scenarios={} partial_fills={} transactions={}",
        total.0, total.1, total.2
    );
    assert!(total.1 > 20, "campaign must exercise partial fills");
}

#[test]
fn solver_matched_pairs_verify_on_the_binary() {
    let mut env = Env::new();
    let code_hash = hex(env.lock(vec![]).code_hash().as_slice());
    let reply = bridge(&json!({
        "codeHash": code_hash,
        "owner": hex(env.owner.as_slice()),
        "a": hex(env.a.as_slice()),
        "b": hex(env.b.as_slice()),
        "seed": "12345",
        "count": 0,
        "pairs": 60,
    }));
    let pairs = reply["pairs"].as_array().unwrap();
    let mut partial = 0;
    for (i, pair) in pairs.iter().enumerate() {
        let mut inputs = vec![];
        for order in pair["orders"].as_array().unwrap() {
            let (c, d) = cell_of(order);
            inputs.push(env.input(c, d, 0));
        }
        let other = env.other.clone();
        inputs.push(env.input(cell(&other, None, 100_000 * CKB), Bytes::new(), 0));
        let mut outputs: Vec<_> = pair["payments"]
            .as_array()
            .unwrap()
            .iter()
            .map(cell_of)
            .collect();
        outputs.extend(pair["remainders"].as_array().unwrap().iter().map(cell_of));
        let tx = env.tx(inputs, outputs);
        env.expect(&tx, 0, &format!("pair {i}"));
        partial += pair["partial"].as_bool().unwrap() as usize;
    }
    println!("pairs={} partial={partial}", pairs.len());
    assert!(pairs.len() >= 30 && partial >= 10);
}

/// Matcher-built multi-order settlements (several orders per side, one possibly partial)
/// verify on the binary, and conserve every asset without the solver adding any: token
/// amounts and CKB capacity paid out never exceed what the orders held.
#[test]
fn solver_matched_books_verify_on_the_binary() {
    let mut env = Env::new();
    let code_hash = hex(env.lock(vec![]).code_hash().as_slice());
    let reply = bridge(&json!({
        "codeHash": code_hash,
        "owner": hex(env.owner.as_slice()),
        "a": hex(env.a.as_slice()),
        "b": hex(env.b.as_slice()),
        "seed": "424242",
        "count": 0,
        "books": 60,
    }));
    let books = reply["books"].as_array().unwrap();
    let (mut partial, mut legs, mut widest) = (0, 0, 0);
    let amount = |d: &Bytes| -> u128 { u128::from_le_bytes(d[..16].try_into().unwrap()) };
    for (i, book) in books.iter().enumerate() {
        let orders: Vec<_> = book["orders"]
            .as_array()
            .unwrap()
            .iter()
            .map(cell_of)
            .collect();
        let mut outputs: Vec<_> = book["payments"]
            .as_array()
            .unwrap()
            .iter()
            .map(cell_of)
            .collect();
        outputs.extend(book["remainders"].as_array().unwrap().iter().map(cell_of));
        // Conservation, from the cells alone: per type script and for capacity.
        let total = |cells: &[(CellOutput, Bytes)], t: &Script| -> u128 {
            cells
                .iter()
                .filter(|(o, _)| o.type_().to_opt().as_ref() == Some(t))
                .map(|(_, d)| amount(d))
                .sum()
        };
        let capacity = |cells: &[(CellOutput, Bytes)]| -> u64 {
            cells
                .iter()
                .map(|(o, _)| Unpack::<u64>::unpack(&o.capacity()))
                .sum()
        };
        for t in [&env.a, &env.b] {
            assert!(
                total(&orders, t) >= total(&outputs, t),
                "book {i}: token paid out exceeds what the orders held"
            );
        }
        assert!(
            capacity(&orders) >= capacity(&outputs),
            "book {i}: capacity paid out exceeds what the orders held"
        );
        let mut inputs: Vec<_> = orders
            .into_iter()
            .map(|(c, d)| env.input(c, d, 0))
            .collect();
        let other = env.other.clone();
        inputs.push(env.input(cell(&other, None, 100_000 * CKB), Bytes::new(), 0));
        let tx = env.tx(inputs, outputs);
        env.expect(&tx, 0, &format!("book {i}"));
        partial += book["partial"].as_bool().unwrap() as usize;
        let n = book["legs"].as_u64().unwrap() as usize;
        legs += n;
        widest = widest.max(n);
    }
    println!(
        "books={} legs={legs} widest={widest} partial={partial}",
        books.len()
    );
    assert!(books.len() >= 30 && partial >= 10 && widest >= 5);
}

/// Matcher-built three-asset rings (a -> b -> CKB -> a and the reverse cycle) verify on the
/// binary and conserve every asset without the solver adding any, checked from the cells.
#[test]
fn solver_matched_rings_verify_on_the_binary() {
    let mut env = Env::new();
    let code_hash = hex(env.lock(vec![]).code_hash().as_slice());
    let reply = bridge(&json!({
        "codeHash": code_hash,
        "owner": hex(env.owner.as_slice()),
        "a": hex(env.a.as_slice()),
        "b": hex(env.b.as_slice()),
        "seed": "31337",
        "count": 0,
        "rings": 60,
    }));
    let rings = reply["rings"].as_array().unwrap();
    let (mut partial, mut orientations) = (0, [0usize; 2]);
    let amount = |d: &Bytes| -> u128 { u128::from_le_bytes(d[..16].try_into().unwrap()) };
    for (i, ring) in rings.iter().enumerate() {
        let orders: Vec<_> = ring["orders"]
            .as_array()
            .unwrap()
            .iter()
            .map(cell_of)
            .collect();
        let mut outputs: Vec<_> = ring["payments"]
            .as_array()
            .unwrap()
            .iter()
            .map(cell_of)
            .collect();
        outputs.extend(ring["remainders"].as_array().unwrap().iter().map(cell_of));
        let total = |cells: &[(CellOutput, Bytes)], t: &Script| -> u128 {
            cells
                .iter()
                .filter(|(o, _)| o.type_().to_opt().as_ref() == Some(t))
                .map(|(_, d)| amount(d))
                .sum()
        };
        let capacity = |cells: &[(CellOutput, Bytes)]| -> u64 {
            cells
                .iter()
                .map(|(o, _)| Unpack::<u64>::unpack(&o.capacity()))
                .sum()
        };
        for t in [&env.a, &env.b] {
            assert!(
                total(&orders, t) >= total(&outputs, t),
                "ring {i}: token paid out exceeds what the orders held"
            );
        }
        assert!(
            capacity(&orders) >= capacity(&outputs),
            "ring {i}: capacity paid out exceeds what the orders held"
        );
        let mut inputs: Vec<_> = orders
            .into_iter()
            .map(|(c, d)| env.input(c, d, 0))
            .collect();
        let other = env.other.clone();
        inputs.push(env.input(cell(&other, None, 100_000 * CKB), Bytes::new(), 0));
        let tx = env.tx(inputs, outputs);
        env.expect(&tx, 0, &format!("ring {i}"));
        partial += ring["partial"].as_bool().unwrap() as usize;
        orientations[ring["ckbFirst"].as_bool().unwrap() as usize] += 1;
    }
    println!(
        "rings={} partial={partial} orientations={orientations:?}",
        rings.len()
    );
    assert!(rings.len() >= 30 && partial >= 10 && orientations.iter().all(|&n| n >= 10));
}
