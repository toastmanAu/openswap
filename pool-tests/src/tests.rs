use crate::fixture::*;
use ckb_testtool::ckb_types::core::TransactionView;
use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_types::{
        bytes::Bytes,
        core::{ScriptHashType, TransactionBuilder},
        packed::*,
        prelude::*,
    },
    context::Context,
};
use openswap_pool_arithmetic::wire::Action;
use openswap_pool_arithmetic::wire::{Args, Role, StateData};

fn swap_tx(f: &mut Fixture) -> TransactionView {
    f.transition(Action::Swap {
        x_to_y: true,
        amount: 10_000_000_000,
        minimum: 1,
    })
}
fn output(tx: &TransactionView, index: usize, value: CellOutput) -> TransactionView {
    let mut outputs: Vec<_> = tx.outputs().into_iter().collect();
    outputs[index] = value;
    tx.as_advanced_builder().set_outputs(outputs).build()
}
fn output_data(tx: &TransactionView, index: usize, value: Bytes) -> TransactionView {
    let mut data: Vec<_> = tx.outputs_data().into_iter().collect();
    data[index] = value.pack();
    tx.as_advanced_builder().set_outputs_data(data).build()
}
fn extra_output(tx: &TransactionView, index: usize) -> TransactionView {
    tx.as_advanced_builder()
        .output(tx.outputs().get(index).unwrap())
        .output_data(tx.outputs_data().get(index).unwrap())
        .build()
}
fn no_input(tx: &TransactionView, index: usize) -> TransactionView {
    let mut inputs: Vec<_> = tx.inputs().into_iter().collect();
    inputs.remove(index);
    tx.as_advanced_builder().set_inputs(inputs).build()
}

#[test]
fn genesis_identity_issuance_and_singleton_are_enforced() {
    let mut f = Fixture::new();
    f.check(&extra_output(&f.genesis, 0), Some(7));
    let mut tx = f.genesis.clone();
    let mut roles = Vec::new();
    for role in [
        Role::StateType,
        Role::StateLock,
        Role::CkbLock,
        Role::TokenLock,
        Role::LpType,
    ] {
        roles.push(
            f.context
                .build_script_with_hash_type(
                    &f.code,
                    ScriptHashType::Data1,
                    Bytes::from(
                        Args {
                            role,
                            pool_id: [0x77; 32],
                        }
                        .encode()
                        .to_vec(),
                    ),
                )
                .unwrap(),
        );
    }
    tx = output(
        &tx,
        0,
        cell(&roles[1], Some(&roles[0]), f.metadata.backing_state),
    );
    tx = output(
        &tx,
        1,
        cell(
            &roles[2],
            None,
            f.metadata.backing_ckb + f.initial.x.low_u64(),
        ),
    );
    tx = output(
        &tx,
        2,
        cell(&roles[3], Some(&f.token), f.metadata.backing_token),
    );
    tx = output(&tx, 3, cell(&f.owner, Some(&roles[4]), 20_000_000_000));
    f.check(&tx, Some(6));
    f.check(
        &output_data(
            &f.genesis,
            3,
            amount(f.metadata.shares - f.metadata.locked + 1),
        ),
        Some(10),
    );
    let without_lp = output_data(
        &output(&f.genesis, 3, cell(&f.owner, None, 20_000_000_000)),
        3,
        Bytes::new(),
    );
    f.check(&without_lp, Some(10));
    let mut metadata = f.metadata;
    metadata.shares -= 1;
    let wrong = output_data(
        &f.genesis,
        0,
        Bytes::from(metadata.encode().unwrap().to_vec()),
    );
    let wrong = output_data(&wrong, 3, amount(metadata.shares - metadata.locked));
    f.check(&wrong, Some(29));
}

#[test]
fn successor_destruction_duplication_and_storage_theft_reject() {
    let mut f = Fixture::new();
    let tx = swap_tx(&mut f);
    f.check(&extra_output(&tx, 0), Some(7));
    let removed = output(&tx, 0, cell(&f.owner, None, f.metadata.backing_state));
    f.check(&removed, Some(7));
    for i in [0, 2] {
        let old = tx.outputs().get(i).unwrap();
        let capacity: u64 = old.capacity().unpack();
        f.check(
            &output(&tx, i, old.as_builder().capacity(capacity - 1).build()),
            Some(9),
        );
    }
    let old = tx.outputs().get(1).unwrap();
    let capacity: u64 = old.capacity().unpack();
    f.check(
        &output(&tx, 1, old.as_builder().capacity(capacity - 1).build()),
        Some(29),
    );
    let mut metadata = StateData::decode(&tx.outputs_data().get(0).unwrap().raw_data()).unwrap();
    metadata.backing_ckb += 1;
    f.check(
        &output_data(&tx, 0, Bytes::from(metadata.encode().unwrap().to_vec())),
        Some(8),
    );
}

#[test]
fn exact_outpoints_required_even_for_identical_lookalike_reserves() {
    for index in [1, 2] {
        let mut f = Fixture::new();
        let tx = swap_tx(&mut f);
        let (cell, data) = f.genesis.outputs_with_data_iter().nth(index).unwrap();
        let fake = f.context.create_cell(cell, data);
        let mut inputs: Vec<_> = tx.inputs().into_iter().collect();
        inputs[index] = CellInput::new_builder().previous_output(fake).build();
        f.check(
            &tx.as_advanced_builder().set_inputs(inputs).build(),
            Some(7),
        );
    }
    let mut f = Fixture::new();
    let tx = swap_tx(&mut f);
    for index in [1, 2] {
        f.check(&no_input(&tx, index), Some(7));
    }
    // Remaining reserve locks cannot use an output state as an input proof.
    f.check(&no_input(&tx, 0), Some(6));
    // Unspent lookalikes are irrelevant. Spending an extra one is prohibited.
    let (cell, data) = f.genesis.outputs_with_data_iter().nth(1).unwrap();
    let fake = f.context.create_cell(cell, data);
    f.check(&tx, None);
    f.check(
        &tx.as_advanced_builder()
            .input(CellInput::new_builder().previous_output(fake).build())
            .build(),
        Some(7),
    );
}

#[test]
fn lp_mint_burn_and_incorrect_data_are_rejected() {
    let mut f = Fixture::new();
    let tx = swap_tx(&mut f);
    let supply = f.metadata.shares - f.metadata.locked;
    for n in [supply - 1, supply + 1] {
        f.check(&output_data(&tx, 3, amount(n)), Some(10));
    }
    for len in [0, 15, 17] {
        f.check(&output_data(&tx, 3, Bytes::from(vec![0; len])), Some(9));
    }
    let mint = Action::Deposit {
        max_x: 1_000_000,
        max_y: 4_000_000,
        minimum: 1,
    };
    let deposit = f.transition(mint);
    f.check(&output_data(&deposit, 3, amount(supply)), Some(10));
    let withdraw = f.transition(Action::Withdraw {
        shares: 1_000_000,
        min_x: 1,
        min_y: 1,
    });
    f.check(&output_data(&withdraw, 3, amount(supply)), Some(10));
}

#[test]
fn standalone_lp_transfers_preserve_supply_without_pool_state() {
    let mut f = Fixture::new();
    let lp_cell = cell(&f.owner, Some(&f.roles[4]), 20_000_000_000);
    let point = f.context.create_cell(lp_cell.clone(), amount(100));
    for n in [99u128, 100, 101] {
        let tx = TransactionBuilder::default()
            .input(
                CellInput::new_builder()
                    .previous_output(point.clone())
                    .build(),
            )
            .output(lp_cell.clone())
            .output_data(amount(n).pack())
            .build();
        let tx = f.context.complete_tx(tx);
        f.check(&tx, if n == 100 { None } else { Some(10) });
    }
    let plain = f
        .context
        .create_cell(cell(&f.owner, None, 20_000_000_000), Bytes::new());
    let forged = f.context.complete_tx(
        TransactionBuilder::default()
            .input(CellInput::new_builder().previous_output(plain).build())
            .output(lp_cell)
            .output_data(amount(1).pack())
            .build(),
    );
    f.check(&forged, Some(10));
}

#[test]
fn immutable_fee_locked_shares_and_token_profile_are_enforced() {
    let mut f = Fixture::new();
    let tx = swap_tx(&mut f);
    let before = StateData::decode(&tx.outputs_data().get(0).unwrap().raw_data()).unwrap();
    for metadata in [
        StateData { fee: 0, ..before },
        StateData {
            locked: before.locked + 1,
            ..before
        },
    ] {
        f.check(
            &output_data(&tx, 0, Bytes::from(metadata.encode().unwrap().to_vec())),
            Some(8),
        );
    }
    let metadata = StateData {
        token_code_hash: [0x77; 32],
        ..before
    };
    f.check(
        &output_data(&tx, 0, Bytes::from(metadata.encode().unwrap().to_vec())),
        Some(5),
    );
    let owner_hash = f.roles[2].calc_script_hash().unpack();
    let metadata = StateData {
        token_owner: owner_hash,
        ..before
    };
    f.check(
        &output_data(&tx, 0, Bytes::from(metadata.encode().unwrap().to_vec())),
        Some(5),
    );
}

#[test]
fn malformed_state_and_witness_fail_inside_vm() {
    let mut f = Fixture::new();
    let tx = swap_tx(&mut f);
    let state = tx.outputs_data().get(0).unwrap().raw_data();
    for len in [0, 189, 191] {
        let mut bad = state.to_vec();
        bad.resize(len, 0);
        f.check(&output_data(&tx, 0, Bytes::from(bad)), Some(9));
    }
    for (index, code) in [(0, 3), (4, 4), (5, 4), (138, 3)] {
        let mut bad = state.to_vec();
        bad[index] = 0xff;
        f.check(&output_data(&tx, 0, Bytes::from(bad)), Some(code));
    }
    let mut bad = tx.witnesses().get(0).unwrap().raw_data().to_vec();
    bad[4..8].copy_from_slice(&17u32.to_le_bytes());
    f.check(
        &tx.as_advanced_builder()
            .set_witnesses(vec![Bytes::from(bad).pack()])
            .build(),
        Some(3),
    );
    f.check(
        &tx.as_advanced_builder()
            .set_witnesses(vec![Bytes::from(vec![0; 4097]).pack()])
            .build(),
        Some(2),
    );
    f.check(
        &tx.as_advanced_builder()
            .set_witnesses(vec![witness(Action::Create { minimum: 1 }, false).pack()])
            .build(),
        Some(4),
    );
}

#[test]
fn forged_roles_wrong_assets_and_type_addressing_reject() {
    let mut f = Fixture::new();
    let tx = swap_tx(&mut f);
    for (index, role) in [
        (0, Role::StateLock),
        (1, Role::CkbLock),
        (2, Role::TokenLock),
    ] {
        // Same args with a different code hash is not a counterpart role.
        let fake = f
            .owner
            .clone()
            .as_builder()
            .args(f.roles[role as usize].args())
            .build();
        let old = tx.outputs().get(index).unwrap();
        f.check(
            &output(&tx, index, old.as_builder().lock(fake).build()),
            Some(9),
        );
    }
    let fake_lp = f.owner.clone().as_builder().args(f.roles[4].args()).build();
    let old = tx.outputs().get(3).unwrap();
    f.check(
        &output(&tx, 3, old.as_builder().type_(Some(fake_lp).pack()).build()),
        Some(10),
    );
    // Authentic code/args in the wrong execution position cannot authorize custody.
    let old = tx.outputs().get(1).unwrap();
    f.check(
        &output(&tx, 1, old.as_builder().lock(f.roles[4].clone()).build()),
        Some(5),
    );
    let old = tx.outputs().get(3).unwrap();
    f.check(
        &output(
            &tx,
            3,
            old.as_builder()
                .type_(Some(f.roles[2].clone()).pack())
                .build(),
        ),
        Some(5),
    );
    // A token with four zero extension-flag bytes is a different asset identity.
    let extended = f
        .token
        .clone()
        .as_builder()
        .args(Bytes::from(vec![0x11; 32].into_iter().chain([0; 4]).collect::<Vec<_>>()).pack())
        .build();
    let old = tx.outputs().get(2).unwrap();
    f.check(
        &output(
            &tx,
            2,
            old.as_builder().type_(Some(extended).pack()).build(),
        ),
        Some(9),
    );
    f.check(&output_data(&tx, 2, Bytes::from(vec![0; 17])), Some(9));
    f.check(&output_data(&tx, 1, Bytes::from(vec![0])), Some(9));
    // The same ELF may not opt into Type-hash upgrade indirection.
    let typed_code_cell = f
        .context
        .cells
        .get(&f.code)
        .unwrap()
        .0
        .clone()
        .as_builder()
        .type_(Some(f.owner.clone()).pack())
        .build();
    let code_data = f.context.cells.get(&f.code).unwrap().1.clone();
    let typed_code = f.context.create_cell(typed_code_cell, code_data);
    let type_script = f
        .context
        .build_script_with_hash_type(
            &typed_code,
            ScriptHashType::Type,
            f.roles[4].args().raw_data(),
        )
        .unwrap();
    let point = f.context.create_cell(
        cell(&f.owner, Some(&type_script), 20_000_000_000),
        amount(100),
    );
    let attempt = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(point).build())
        .output(cell(&f.owner, Some(&type_script), 20_000_000_000))
        .output_data(amount(100).pack())
        .build();
    let attempt = f.context.complete_tx(attempt);
    f.check(&attempt, Some(5));
}

#[test]
fn cell_dep_state_cannot_authorize_reserve_spending() {
    let mut f = Fixture::new();
    let tx = swap_tx(&mut f);
    let state_point = tx.inputs().get(0).unwrap().previous_output();
    let attempt = no_input(&tx, 0)
        .as_advanced_builder()
        .cell_dep(CellDep::new_builder().out_point(state_point).build())
        .build();
    f.check(&attempt, Some(6));
    // With no state on either side, reserve lock execution still rejects.
    let attempt = output(&attempt, 0, cell(&f.owner, None, f.metadata.backing_state));
    assert!(f.context.verify_tx(&attempt, CYCLES).is_err());
}

#[test]
fn zero_supply_reactivation_and_chained_generations() {
    let mut f = Fixture::new();
    f.check(&f.genesis, None);
    let actions = [
        Action::Withdraw {
            shares: f.metadata.shares - f.metadata.locked,
            min_x: 1,
            min_y: 1,
        },
        Action::Deposit {
            max_x: 1_000_000_000,
            max_y: 4_000_000_000,
            minimum: 1,
        },
        Action::Swap {
            x_to_y: true,
            amount: 1_000_000,
            minimum: 1,
        },
        Action::Swap {
            x_to_y: false,
            amount: 1_000_000,
            minimum: 1,
        },
        Action::Withdraw {
            shares: 1000,
            min_x: 1,
            min_y: 1,
        },
    ];
    for action in actions {
        let result =
            openswap_pool_arithmetic::transition(f.initial, action.operation().unwrap()).unwrap();
        let tx = f.transition(action);
        f.check(&tx, None);
        f.metadata = StateData::decode(&tx.outputs_data().get(0).unwrap().raw_data()).unwrap();
        f.initial = result.next;
        f.genesis = tx;
    }
}

#[test]
fn reordered_inputs_and_successor_indexes_are_supported() {
    let mut f = Fixture::new();
    let tx = swap_tx(&mut f);
    let mut inputs: Vec<_> = tx.inputs().into_iter().collect();
    inputs.swap(0, 4);
    let mut outputs: Vec<_> = tx.outputs().into_iter().collect();
    outputs.swap(0, 4);
    outputs.swap(1, 5);
    let mut data: Vec<_> = tx.outputs_data().into_iter().collect();
    data.swap(0, 4);
    data.swap(1, 5);
    let mut metadata = StateData::decode(&data[4].raw_data()).unwrap();
    metadata.rx = 5;
    data[4] = Bytes::from(metadata.encode().unwrap().to_vec()).pack();
    let mut witnesses = vec![Bytes::new().pack(); 5];
    witnesses[4] = tx.witnesses().get(0).unwrap();
    let reordered = tx
        .as_advanced_builder()
        .set_inputs(inputs)
        .set_outputs(outputs)
        .set_outputs_data(data)
        .set_witnesses(witnesses)
        .build();
    f.check(&reordered, None);
    // A sibling may not point to the state itself or outside the output list.
    for (rx, ry, code) in [(4, 2, 7), (5, 5, 7), (6, 2, 7), (256, 2, 2)] {
        let mut raw = reordered.outputs_data().get(4).unwrap().raw_data().to_vec();
        raw[64..68].copy_from_slice(&(rx as u32).to_le_bytes());
        raw[68..72].copy_from_slice(&(ry as u32).to_le_bytes());
        f.check(&output_data(&reordered, 4, Bytes::from(raw)), Some(code));
    }
}

#[test]
fn state_backing_must_cover_actual_occupied_capacity() {
    let f = Fixture::new();
    let mut metadata = f.metadata;
    metadata.backing_state -= 1;
    let tx = output_data(
        &f.genesis,
        0,
        Bytes::from(metadata.encode().unwrap().to_vec()),
    );
    let tx = output(
        &tx,
        0,
        cell(&f.roles[1], Some(&f.roles[0]), metadata.backing_state),
    );
    f.check(&tx, Some(9));
    let mut metadata = f.metadata;
    metadata.backing_ckb = 7_900_000_000 - 1;
    let tx = output_data(
        &f.genesis,
        0,
        Bytes::from(metadata.encode().unwrap().to_vec()),
    );
    let tx = output(
        &tx,
        1,
        cell(
            &f.roles[2],
            None,
            metadata.backing_ckb + f.initial.x.low_u64(),
        ),
    );
    f.check(&tx, Some(9));
}

#[test]
fn lp_aggregate_over_u128_is_rejected() {
    let mut f = Fixture::new();
    let lp = cell(&f.owner, Some(&f.roles[4]), 20_000_000_000);
    let mut inputs = Vec::new();
    for _ in 0..2 {
        inputs.push(
            CellInput::new_builder()
                .previous_output(f.context.create_cell(lp.clone(), amount(u128::MAX)))
                .build(),
        );
    }
    let tx = f.context.complete_tx(
        TransactionBuilder::default()
            .inputs(inputs)
            .output(lp)
            .output_data(amount(0).pack())
            .build(),
    );
    f.check(&tx, Some(10));
}

#[test]
fn global_scan_bounds_and_unrelated_script_sizes_are_enforced() {
    let mut f = Fixture::new();
    let mut tx = f.genesis.clone();
    for _ in 1..256 {
        let point = f
            .context
            .create_cell(cell(&f.owner, None, 10_000_000_000), Bytes::new());
        tx = tx
            .as_advanced_builder()
            .input(CellInput::new_builder().previous_output(point).build())
            .build();
    }
    f.check(&tx, None);
    let point = f
        .context
        .create_cell(cell(&f.owner, None, 10_000_000_000), Bytes::new());
    f.check(
        &tx.as_advanced_builder()
            .input(CellInput::new_builder().previous_output(point).build())
            .build(),
        Some(2),
    );
    let mut tx = f.genesis.clone();
    for _ in 6..256 {
        tx = tx
            .as_advanced_builder()
            .output(cell(&f.owner, None, 10_000_000_000))
            .output_data(Bytes::new().pack())
            .build();
    }
    let change = tx.outputs().get(5).unwrap();
    let capacity: u64 = change.capacity().unpack();
    tx = output(
        &tx,
        5,
        change
            .as_builder()
            .capacity(capacity - 250 * 10_000_000_000)
            .build(),
    );
    f.check(&tx, None);
    f.check(&extra_output(&tx, 5), Some(2));
    for length in [512, 513] {
        let lock = f
            .owner
            .clone()
            .as_builder()
            .args(Bytes::from(vec![0; length - 53]).pack())
            .build();
        assert_eq!(lock.as_slice().len(), length);
        let point = f
            .context
            .create_cell(cell(&lock, None, 100_000_000_000), Bytes::new());
        let tx = f.context.complete_tx(
            f.genesis
                .as_advanced_builder()
                .input(CellInput::new_builder().previous_output(point).build())
                .build(),
        );
        f.check(&tx, if length == 512 { None } else { Some(2) });
    }
}

#[test]
fn two_independent_pools_compose_without_cross_authorization() {
    let mut f = Fixture::new();
    let first = swap_tx(&mut f);
    let mut g = Fixture::new();
    let second = swap_tx(&mut g);
    assert_ne!(f.roles[0], g.roles[0]);
    for (point, (cell, data)) in &g.context.cells {
        f.context
            .create_cell_with_out_point(point.clone(), cell.clone(), data.clone());
    }
    let mut outputs: Vec<_> = first
        .outputs()
        .into_iter()
        .chain(second.outputs())
        .collect();
    let mut data: Vec<_> = first
        .outputs_data()
        .into_iter()
        .chain(second.outputs_data())
        .collect();
    let mut metadata = StateData::decode(&data[6].raw_data()).unwrap();
    metadata.rx += 6;
    metadata.ry += 6;
    data[6] = Bytes::from(metadata.encode().unwrap().to_vec()).pack();
    let mut witnesses = vec![Bytes::new().pack(); 7];
    witnesses[0] = first.witnesses().get(0).unwrap();
    witnesses[6] = second.witnesses().get(0).unwrap();
    let tx = f.context.complete_tx(
        TransactionBuilder::default()
            .inputs(
                first
                    .inputs()
                    .into_iter()
                    .chain(second.inputs())
                    .collect::<Vec<_>>(),
            )
            .outputs(outputs.clone())
            .outputs_data(data)
            .witnesses(witnesses)
            .build(),
    );
    f.check(&tx, None);
    outputs[1] = outputs[7].clone();
    f.check(
        &tx.as_advanced_builder().set_outputs(outputs).build(),
        Some(9),
    );
    let lp = tx
        .outputs()
        .get(3)
        .unwrap()
        .as_builder()
        .type_(Some(g.roles[4].clone()).pack())
        .build();
    f.check(&output(&tx, 3, lp), Some(10));
}

#[test]
fn genesis_binds_full_first_input_and_nonzero_state_output_index() {
    let mut f = Fixture::new();
    let input = f.genesis.inputs().get(0).unwrap();
    let mut hasher = ckb_hash::new_blake2b();
    hasher.update(input.as_slice());
    hasher.update(&4u64.to_le_bytes());
    let mut pool_id = [0; 32];
    hasher.finalize(&mut pool_id);
    let roles = [
        Role::StateType,
        Role::StateLock,
        Role::CkbLock,
        Role::TokenLock,
        Role::LpType,
    ]
    .map(|role| {
        f.context
            .build_script_with_hash_type(
                &f.code,
                ScriptHashType::Data1,
                Bytes::from(Args { role, pool_id }.encode().to_vec()),
            )
            .unwrap()
    });
    let mut outputs: Vec<_> = f.genesis.outputs().into_iter().collect();
    outputs.swap(0, 4);
    outputs[4] = cell(&roles[1], Some(&roles[0]), f.metadata.backing_state);
    outputs[1] = outputs[1]
        .clone()
        .as_builder()
        .lock(roles[2].clone())
        .build();
    outputs[2] = outputs[2]
        .clone()
        .as_builder()
        .lock(roles[3].clone())
        .build();
    outputs[3] = outputs[3]
        .clone()
        .as_builder()
        .type_(Some(roles[4].clone()).pack())
        .build();
    let mut data: Vec<_> = f.genesis.outputs_data().into_iter().collect();
    data.swap(0, 4);
    let mut witnesses = vec![Bytes::new().pack(); 5];
    witnesses[4] = f.genesis.witnesses().get(0).unwrap();
    let tx = f
        .genesis
        .as_advanced_builder()
        .set_outputs(outputs)
        .set_outputs_data(data)
        .set_witnesses(witnesses)
        .build();
    f.check(&tx, None);
    let modified_input = input.as_builder().since(1u64).build();
    f.check(
        &tx.as_advanced_builder()
            .set_inputs(vec![modified_input])
            .build(),
        Some(6),
    );
}

#[test]
fn malformed_running_args_and_slippage_are_checked_in_vm() {
    let mut f = Fixture::new();
    let plain = f
        .context
        .create_cell(cell(&f.owner, None, 100_000_000_000), Bytes::new());
    let canonical = f.roles[4].args().raw_data().to_vec();
    let mut cases = Vec::new();
    cases.push((canonical[..37].to_vec(), 3));
    let mut extra = canonical.clone();
    extra.push(0);
    cases.push((extra, 2));
    for index in [4, 5] {
        let mut invalid = canonical.clone();
        invalid[index] = 255;
        cases.push((invalid, 4));
    }
    cases.push((vec![0; 460], 2));
    for (args, code) in cases {
        let bad = f
            .context
            .build_script_with_hash_type(&f.code, ScriptHashType::Data1, Bytes::from(args))
            .unwrap();
        let tx = f.context.complete_tx(
            TransactionBuilder::default()
                .input(
                    CellInput::new_builder()
                        .previous_output(plain.clone())
                        .build(),
                )
                .output(cell(&f.owner, Some(&bad), 100_000_000_000))
                .output_data(amount(1).pack())
                .build(),
        );
        f.check(&tx, Some(code));
    }
    let tx = swap_tx(&mut f);
    let minimum = Action::Swap {
        x_to_y: true,
        amount: 10_000_000_000,
        minimum: f.initial.y.low_u128(),
    };
    f.check(
        &tx.as_advanced_builder()
            .set_witnesses(vec![witness(minimum, false).pack()])
            .build(),
        Some(26),
    );
    let tiny = f.transition(Action::Deposit {
        max_x: 3,
        max_y: 13,
        minimum: 1,
    });
    f.check(&tiny, None);
    // Increasing the charged token amount beyond exact ceil-backed cost is a donation, not this operation.
    let y = u128::from_le_bytes(
        tiny.outputs_data()
            .get(2)
            .unwrap()
            .raw_data()
            .as_ref()
            .try_into()
            .unwrap(),
    );
    f.check(&output_data(&tiny, 2, amount(y + 1)), Some(29));
}

#[test]
fn genesis_and_another_pool_transition_can_share_a_witness_index() {
    let mut f = Fixture::new();
    let old = swap_tx(&mut f);
    let g = Fixture::new();
    for (point, (cell, data)) in &g.context.cells {
        f.context
            .create_cell_with_out_point(point.clone(), cell.clone(), data.clone());
    }
    let mut hasher = ckb_hash::new_blake2b();
    hasher.update(old.inputs().get(0).unwrap().as_slice());
    hasher.update(&0u64.to_le_bytes());
    let mut pool_id = [0; 32];
    hasher.finalize(&mut pool_id);
    let roles = [
        Role::StateType,
        Role::StateLock,
        Role::CkbLock,
        Role::TokenLock,
        Role::LpType,
    ]
    .map(|role| {
        f.context
            .build_script_with_hash_type(
                &f.code,
                ScriptHashType::Data1,
                Bytes::from(Args { role, pool_id }.encode().to_vec()),
            )
            .unwrap()
    });
    let mut outputs: Vec<_> = g
        .genesis
        .outputs()
        .into_iter()
        .chain(old.outputs())
        .collect();
    outputs[0] = outputs[0]
        .clone()
        .as_builder()
        .lock(roles[1].clone())
        .type_(Some(roles[0].clone()).pack())
        .build();
    outputs[1] = outputs[1]
        .clone()
        .as_builder()
        .lock(roles[2].clone())
        .build();
    outputs[2] = outputs[2]
        .clone()
        .as_builder()
        .lock(roles[3].clone())
        .build();
    outputs[3] = outputs[3]
        .clone()
        .as_builder()
        .type_(Some(roles[4].clone()).pack())
        .build();
    let mut data: Vec<_> = g
        .genesis
        .outputs_data()
        .into_iter()
        .chain(old.outputs_data())
        .collect();
    let mut metadata = StateData::decode(&data[6].raw_data()).unwrap();
    metadata.rx += 6;
    metadata.ry += 6;
    data[6] = Bytes::from(metadata.encode().unwrap().to_vec()).pack();
    let old_witness = WitnessArgs::from_slice(&old.witnesses().get(0).unwrap().raw_data()).unwrap();
    let new_witness =
        WitnessArgs::from_slice(&g.genesis.witnesses().get(0).unwrap().raw_data()).unwrap();
    let both = WitnessArgs::new_builder()
        .input_type(old_witness.input_type())
        .output_type(new_witness.output_type())
        .build();
    let tx = f.context.complete_tx(
        TransactionBuilder::default()
            .inputs(
                old.inputs()
                    .into_iter()
                    .chain(g.genesis.inputs())
                    .collect::<Vec<_>>(),
            )
            .outputs(outputs)
            .outputs_data(data)
            .witness(both.as_bytes().pack())
            .build(),
    );
    f.check(&tx, None);
}

#[test]
fn pool_genesis_and_all_transition_kinds() {
    for action in [
        Action::Swap {
            x_to_y: true,
            amount: 10_000_000_000,
            minimum: 1,
        },
        Action::Swap {
            x_to_y: false,
            amount: 10_000_000_000,
            minimum: 1,
        },
        Action::Deposit {
            max_x: 10_000_000_000,
            max_y: 40_000_000_000,
            minimum: 1,
        },
        Action::Withdraw {
            shares: 10_000_000_000,
            min_x: 1,
            min_y: 1,
        },
        Action::Withdraw {
            shares: 1_999_999_999_000,
            min_x: 1,
            min_y: 1,
        },
    ] {
        let mut f = Fixture::new();
        f.check(&f.genesis, None);
        let tx = f.transition(action);
        f.check(&tx, None);
    }
}

#[test]
fn pinned_xudt_accepts_32_byte_owner_args_and_enforces_conservation() {
    let mut context = Context::new_with_deterministic_rng();
    let xudt = include_bytes!("../../tests/fixtures/xudt");
    assert_eq!(
        ckb_hash::blake2b_256(xudt).to_vec(),
        vec![
            0x50, 0xbd, 0x8d, 0x66, 0x80, 0xb8, 0xb9, 0xcf, 0x98, 0xb7, 0x3f, 0x3c, 0x08, 0xfa,
            0xf8, 0xb2, 0xa2, 0x19, 0x14, 0x31, 0x19, 0x54, 0x11, 0x8a, 0xd6, 0x60, 0x9b, 0xe6,
            0xe7, 0x8a, 0x1b, 0x95
        ]
    );
    let code = context.deploy_cell(Bytes::from_static(xudt));
    let lock_code = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let lock = context
        .build_script_with_hash_type(&lock_code, ScriptHashType::Data1, Bytes::new())
        .unwrap();
    let token = context
        .build_script_with_hash_type(&code, ScriptHashType::Data1, Bytes::from(vec![0x11; 32]))
        .unwrap();
    assert_ne!(
        lock.calc_script_hash().as_slice(),
        token.args().raw_data().as_ref()
    );
    let cell = CellOutput::new_builder()
        .capacity(100_000_000_000u64)
        .lock(lock)
        .type_(Some(token).pack())
        .build();
    let input = context.create_cell(cell.clone(), Bytes::from(100u128.to_le_bytes().to_vec()));
    for amount in [100u128, 101] {
        let tx = TransactionBuilder::default()
            .input(
                CellInput::new_builder()
                    .previous_output(input.clone())
                    .build(),
            )
            .output(cell.clone())
            .output_data(Bytes::from(amount.to_le_bytes().to_vec()).pack())
            .build();
        let tx = context.complete_tx(tx);
        let result = context.verify_tx(&tx, 100_000_000);
        if amount == 100 {
            result.expect("32-byte canonical profile must transfer");
        } else {
            assert!(result.is_err(), "non-owner token creation must fail");
        }
    }
}
