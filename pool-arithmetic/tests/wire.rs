use openswap_pool_arithmetic::wire::*;
#[path = "../../tests/src/campaign.rs"]
mod campaign;

fn state() -> StateData {
    StateData {
        fee: 9999,
        locked: 1,
        shares: (1u128 << 100) + 7,
        backing_state: 34_000_000_000,
        backing_ckb: 7_900_000_000,
        backing_token: 16_000_000_000,
        rx: 254,
        ry: 255,
        token_code_hash: [0x19; 32],
        token_owner: [0xa7; 32],
    }
}
fn actions() -> [Action; 5] {
    [
        Action::Create { minimum: u128::MAX },
        Action::Swap {
            x_to_y: true,
            amount: 1,
            minimum: (1 << 112) - 1,
        },
        Action::Swap {
            x_to_y: false,
            amount: (1 << 112) - 1,
            minimum: (u64::MAX - 1) as u128,
        },
        Action::Deposit {
            max_x: (u64::MAX - 1) as u128,
            max_y: (1 << 112) - 1,
            minimum: u128::MAX,
        },
        Action::Withdraw {
            shares: u128::MAX,
            min_x: 1,
            min_y: 1,
        },
    ]
}
fn action_bytes(a: Action) -> Vec<u8> {
    let mut out = [0; ACTION_MAX_LEN];
    let len = a.encode(&mut out).unwrap();
    out[..len].to_vec()
}
fn bytes(value: &[u8]) -> Vec<u8> {
    let mut out = (value.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(value);
    out
}
fn table(fields: [&[u8]; 3]) -> Vec<u8> {
    let mut pos = 16u32;
    let mut out = (16 + fields.iter().map(|f| f.len()).sum::<usize>() as u32)
        .to_le_bytes()
        .to_vec();
    for f in fields {
        out.extend_from_slice(&pos.to_le_bytes());
        pos += f.len() as u32;
    }
    for f in fields {
        out.extend_from_slice(f);
    }
    out
}

#[test]
fn all_roles_and_actions_round_trip_with_endian_sentinels() {
    for role in 0..5 {
        let args = Args {
            role: Role::try_from(role).unwrap(),
            pool_id: core::array::from_fn(|i| i as u8),
        };
        assert_eq!(Args::decode(&args.encode()), Ok(args));
        let script = encode_pool_script([0xff; 32], args);
        assert_eq!(decode_pool_script(&script), Ok(([0xff; 32], args)));
        assert_eq!(
            &script[..16],
            &[91, 0, 0, 0, 16, 0, 0, 0, 48, 0, 0, 0, 49, 0, 0, 0]
        );
    }
    let value = state();
    let encoded = value.encode().unwrap();
    assert_eq!(StateData::decode(&encoded), Ok(value));
    assert_eq!(&encoded[6..8], &[0x0f, 0x27]);
    assert_eq!(encoded[24], 7);
    assert_eq!(encoded[36], 0x10);
    assert_eq!(&encoded[64..72], &[254, 0, 0, 0, 255, 0, 0, 0]);
    for action in actions() {
        assert_eq!(Action::decode(&action_bytes(action)), Ok(action));
    }
    assert_eq!(actions()[0].operation(), Err(Error::Unsupported));
    for action in &actions()[1..] {
        assert!(action.operation().is_ok());
    }
}

#[test]
fn every_truncation_and_tail_is_rejected() {
    let args = Args {
        role: Role::StateType,
        pool_id: [0; 32],
    }
    .encode();
    for end in 0..args.len() {
        assert_eq!(Args::decode(&args[..end]), Err(Error::Malformed));
    }
    let mut extra = args.to_vec();
    extra.push(0);
    assert_eq!(Args::decode(&extra), Err(Error::Bound));
    let state = state().encode().unwrap();
    for end in 0..state.len() {
        assert_eq!(StateData::decode(&state[..end]), Err(Error::Malformed));
    }
    let mut extra = state.to_vec();
    extra.push(0);
    assert_eq!(StateData::decode(&extra), Err(Error::Bound));
    for action in actions() {
        let encoded = action_bytes(action);
        for end in 0..encoded.len() {
            assert!(Action::decode(&encoded[..end]).is_err());
        }
        let mut extra = encoded.clone();
        extra.push(0);
        assert!(Action::decode(&extra).is_err());
    }
}

#[test]
fn unknown_tags_reserved_bytes_and_profile_reject_stably() {
    let mut args = Args {
        role: Role::StateType,
        pool_id: [0; 32],
    }
    .encode();
    for tag in 5..=255 {
        args[5] = tag;
        assert_eq!(Args::decode(&args), Err(Error::Unsupported));
    }
    args[5] = 0;
    for version in 0..=255 {
        if version != 1 {
            args[4] = version;
            assert_eq!(Args::decode(&args), Err(Error::Unsupported));
        }
    }
    let canonical = state().encode().unwrap();
    for index in 138..STATE_LEN {
        let mut v = canonical;
        v[index] = 1;
        assert_eq!(StateData::decode(&v), Err(Error::Malformed));
    }
    for index in [4, 5, 104] {
        let mut v = canonical;
        v[index] = 0xff;
        assert_eq!(StateData::decode(&v), Err(Error::Unsupported));
    }
    let mut v = canonical;
    v[105] = 31;
    assert_eq!(StateData::decode(&v), Err(Error::Malformed));
    for tag in 5..=255 {
        let mut v = action_bytes(actions()[0]);
        v[5] = tag;
        assert_eq!(Action::decode(&v), Err(Error::Unsupported));
    }
    for action in actions() {
        for index in [6, 7] {
            let mut v = action_bytes(action);
            v[index] = 1;
            assert_eq!(Action::decode(&v), Err(Error::Malformed));
        }
    }
}

#[test]
fn state_local_domains_and_index_limits_are_enforced_on_both_paths() {
    let valid = state();
    for invalid in [
        StateData {
            fee: 10000,
            ..valid
        },
        StateData { locked: 0, ..valid },
        StateData { shares: 0, ..valid },
        StateData {
            backing_state: 0,
            ..valid
        },
        StateData {
            backing_ckb: 0,
            ..valid
        },
        StateData {
            backing_ckb: u64::MAX,
            ..valid
        },
        StateData {
            backing_token: 0,
            ..valid
        },
    ] {
        assert_eq!(invalid.encode(), Err(Error::Range));
    }
    assert_eq!(StateData { rx: 256, ..valid }.encode(), Err(Error::Bound));
    assert_eq!(StateData { ry: 256, ..valid }.encode(), Err(Error::Bound));
    assert_eq!(
        StateData {
            rx: valid.ry,
            ..valid
        }
        .encode(),
        Err(Error::Lineage)
    );
    let encoded = valid.encode().unwrap();
    for (offset, len) in [(8, 16), (24, 16), (40, 8), (48, 8), (56, 8)] {
        let mut v = encoded;
        v[offset..offset + len].fill(0);
        assert_eq!(StateData::decode(&v), Err(Error::Range));
    }
    let mut v = encoded;
    v[64..68].copy_from_slice(&256u32.to_le_bytes());
    assert_eq!(StateData::decode(&v), Err(Error::Bound));
    let mut v = encoded;
    v[68..72].copy_from_slice(&valid.rx.to_le_bytes());
    assert_eq!(StateData::decode(&v), Err(Error::Lineage));
    // Parsed metadata alone cannot prove L² <= x*y.
    assert_eq!(
        valid.accounting(1, 1),
        Err(openswap_pool_arithmetic::Error::State)
    );
}

#[test]
fn action_zero_and_global_amount_bounds_reject() {
    for action in actions() {
        let encoded = action_bytes(action);
        for offset in (8..encoded.len()).step_by(16) {
            let mut v = encoded.clone();
            v[offset..offset + 16].fill(0);
            assert_eq!(Action::decode(&v), Err(Error::Range));
        }
    }
    for invalid in [
        Action::Create { minimum: 0 },
        Action::Swap {
            x_to_y: true,
            amount: u64::MAX as u128,
            minimum: 1,
        },
        Action::Swap {
            x_to_y: true,
            amount: 1,
            minimum: 1 << 112,
        },
        Action::Swap {
            x_to_y: false,
            amount: 1 << 112,
            minimum: 1,
        },
        Action::Swap {
            x_to_y: false,
            amount: 1,
            minimum: u64::MAX as u128,
        },
        Action::Deposit {
            max_x: 1,
            max_y: 1 << 112,
            minimum: 1,
        },
        Action::Withdraw {
            shares: 1,
            min_x: 1,
            min_y: 1 << 112,
        },
    ] {
        assert_eq!(invalid.encode(&mut [0; ACTION_MAX_LEN]), Err(Error::Range));
        assert_eq!(invalid.operation(), Err(Error::Range));
    }
}

#[test]
fn script_container_checks_full_lengths_offsets_and_data1() {
    let canonical = encode_pool_script(
        [7; 32],
        Args {
            role: Role::LpType,
            pool_id: [8; 32],
        },
    );
    for end in 0..canonical.len() {
        assert!(decode_pool_script(&canonical[..end]).is_err());
    }
    for offset in [0, 4, 8, 12, 49] {
        for value in [0, 1, 15, 17, 48, 49, 90, 92, u32::MAX] {
            let mut v = canonical;
            v[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            if v != canonical {
                assert_eq!(decode_pool_script(&v), Err(Error::Malformed));
            }
        }
    }
    for hash_type in [0, 1, 3, 4, 255] {
        let mut v = canonical;
        v[48] = hash_type;
        assert_eq!(decode_pool_script(&v), Err(Error::Identity));
    }
    assert_eq!(
        decode_pool_script(&[0; SCRIPT_MAX_LEN + 1]),
        Err(Error::Bound)
    );
}

#[test]
fn witnesses_select_phase_and_validate_unselected_fields() {
    let create = bytes(&action_bytes(actions()[0]));
    let swap = bytes(&action_bytes(actions()[1]));
    let both = table([&[], &swap, &create]);
    assert_eq!(decode_witness(&both, Phase::Genesis), Ok(actions()[0]));
    assert_eq!(decode_witness(&both, Phase::Transition), Ok(actions()[1]));
    for end in 0..both.len() {
        assert!(decode_witness(&both[..end], Phase::Genesis).is_err());
    }
    for phase in [Phase::Genesis, Phase::Transition] {
        assert_eq!(
            decode_witness(&table([&[], &[], &[]]), phase),
            Err(Error::Malformed)
        );
        assert_eq!(
            decode_witness(&table([&bytes(&[]), &bytes(&[]), &bytes(&[])]), phase),
            Err(Error::Malformed)
        );
        // Malformed lock BytesOpt must reject despite a valid selected action.
        assert_eq!(
            decode_witness(&table([&[1], &swap, &create]), phase),
            Err(Error::Malformed)
        );
        assert_eq!(
            decode_witness(&table([&[], &create, &swap]), phase),
            Err(Error::Unsupported)
        );
        assert_eq!(
            decode_witness(&[0; WITNESS_MAX_LEN + 1], phase),
            Err(Error::Bound)
        );
    }
    // Exactly 4096 bytes is permitted, including an uninterpreted lock payload.
    let lock = bytes(&vec![
        0;
        WITNESS_MAX_LEN - 16 - swap.len() - create.len() - 4
    ]);
    let at_limit = table([&lock, &swap, &create]);
    assert_eq!(at_limit.len(), WITNESS_MAX_LEN);
    assert_eq!(decode_witness(&at_limit, Phase::Genesis), Ok(actions()[0]));
    let mut broken = both.clone();
    broken[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(
        decode_witness(&broken, Phase::Genesis),
        Err(Error::Malformed)
    );
}

#[test]
fn all_single_byte_mutations_are_rejected_or_canonical() {
    let original = state().encode().unwrap();
    for index in 0..original.len() {
        for byte in 0..=255 {
            let mut v = original;
            v[index] = byte;
            if let Ok(decoded) = StateData::decode(&v) {
                assert_eq!(decoded.encode().unwrap(), v);
            }
        }
    }
    for action in actions() {
        let original = action_bytes(action);
        for index in 0..original.len() {
            for byte in 0..=255 {
                let mut v = original.clone();
                v[index] = byte;
                if let Ok(decoded) = Action::decode(&v) {
                    assert_eq!(action_bytes(decoded), v);
                }
            }
        }
    }
}

#[test]
fn seeded_arbitrary_bytes_never_panic() {
    let campaign = campaign::Campaign::from_env("pool-wire", 20000);
    let mut seed = campaign.state(0x746f617374u64);
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut data = [0; WITNESS_MAX_LEN + 1];
    campaign.run(|_| {
        let len = (next() as usize) % data.len();
        for byte in &mut data[..len] {
            *byte = next() as u8;
        }
        let v = &data[..len];
        let _ = Args::decode(v);
        let _ = StateData::decode(v);
        let _ = Action::decode(v);
        let _ = decode_pool_script(v);
        let _ = decode_witness(v, Phase::Genesis);
        let _ = decode_witness(v, Phase::Transition);
    });
}
