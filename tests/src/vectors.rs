use ckb_std::ckb_types::prelude::*;
fn hex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap();
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
#[test]
fn shared_wire_vectors() {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../vectors/wire.json")).unwrap();
    for v in vectors.as_array().unwrap() {
        let bytes = hex(v["expectedArgsHex"].as_str().unwrap());
        let parsed = crate::wire_parser::owner_prefix(&bytes)
            .and_then(|owner| crate::wire_parser::terms(&bytes, &owner));
        if let Some(code) = v["errorCode"].as_i64() {
            assert_eq!(parsed.err().map(|e| e as i64), Some(code), "{}", v["name"]);
        } else {
            let terms = parsed.unwrap();
            let owner = crate::wire_parser::owner_prefix(&bytes).unwrap();
            assert_eq!(
                owner.script.as_slice(),
                hex(v["ownerScriptHex"].as_str().unwrap())
            );
            assert_eq!(
                terms.capacity_refund.to_string(),
                v["capacityRefund"].as_str().unwrap()
            );
            assert_eq!(
                terms.ask_amount.to_string(),
                v["askAmount"].as_str().unwrap()
            );
            // Rust encoder independently reconstructs the tail for cross-language equality.
            let ask = v["askScriptHex"].as_str().map(hex).unwrap_or_default();
            let mut encoded = owner.script.as_slice().to_vec();
            encoded.extend([1, 0, 0, 0]);
            encoded.extend(hex(v["nonceHex"].as_str().unwrap()));
            encoded.extend(terms.capacity_refund.to_le_bytes());
            encoded.extend((ask.len() as u32).to_le_bytes());
            encoded.extend(ask);
            encoded.extend(terms.ask_amount.to_le_bytes());
            assert_eq!(encoded, bytes, "{}", v["name"]);
        }
    }
}

#[test]
fn seeded_malformed_wire_corpus_never_panics() {
    // Fixed seed and bounded buffers make failures reproducible without a fuzzer runtime.
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../vectors/wire.json")).unwrap();
    let seeds: Vec<Vec<u8>> = vectors
        .as_array()
        .unwrap()
        .iter()
        .map(|v| hex(v["expectedArgsHex"].as_str().unwrap()))
        .collect();
    let mut state = 0x746f_6173_7464_6578_u64;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for case in 0..20_000 {
        let mut bytes = if case % 2 == 0 {
            seeds[next() as usize % seeds.len()].clone()
        } else {
            vec![0; next() as usize % 4097]
        };
        for _ in 0..1 + next() % 16 {
            if bytes.is_empty() {
                break;
            }
            let index = next() as usize % bytes.len();
            bytes[index] = next() as u8;
        }
        if case % 5 == 0 {
            bytes.truncate(next() as usize % (bytes.len() + 1));
        }
        if let Ok(owner) = crate::wire_parser::owner_prefix(&bytes) {
            assert!(owner.end <= crate::wire_parser::MAX_OWNER_SCRIPT_BYTES);
            assert!(owner.end <= bytes.len());
            if let Ok(terms) = crate::wire_parser::terms(&bytes, &owner) {
                assert!(terms.ask_amount > 0);
                assert!(bytes.len() <= owner.end + 48 + crate::wire_parser::MAX_ASK_SCRIPT_BYTES);
            }
        }
    }
}
