use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_types::{
        bytes::Bytes,
        core::{ScriptHashType, TransactionBuilder, TransactionView},
        packed::*,
        prelude::*,
    },
    context::Context,
};
use openswap_pool_arithmetic::{
    Outcome, State, create, transition,
    wire::{ACTION_MAX_LEN, Action, Args, Role, StateData},
};

pub const FUNDING: u64 = 100_000_000_000_000;
pub const TOKENS: u128 = 1_000_000_000_000_000;
pub const CYCLES: u64 = 100_000_000;
pub fn cell(lock: &Script, type_: Option<&Script>, capacity: u64) -> CellOutput {
    CellOutput::new_builder()
        .lock(lock.clone())
        .type_(type_.cloned().pack())
        .capacity(capacity)
        .build()
}
pub fn amount(n: u128) -> Bytes {
    Bytes::from(n.to_le_bytes().to_vec())
}
pub fn witness(a: Action, genesis: bool) -> Bytes {
    let mut buffer = [0; ACTION_MAX_LEN];
    let n = a.encode(&mut buffer).unwrap();
    let data = Bytes::copy_from_slice(&buffer[..n]);
    if genesis {
        WitnessArgs::new_builder()
            .output_type(Some(data).pack())
            .build()
            .as_bytes()
    } else {
        WitnessArgs::new_builder()
            .input_type(Some(data).pack())
            .build()
            .as_bytes()
    }
}
pub struct Fixture {
    pub context: Context,
    pub code: OutPoint,
    pub owner: Script,
    pub token: Script,
    pub roles: [Script; 5],
    pub metadata: StateData,
    pub initial: State,
    pub genesis: TransactionView,
}
impl Fixture {
    pub fn new() -> Self {
        let mut context = Context::new_with_deterministic_rng();
        let code = context.deploy_cell(
            std::fs::read(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../target/riscv64imac-unknown-none-elf/release/openswap-pool"
            ))
            .expect("build pool first")
            .into(),
        );
        let always = context.deploy_cell(ALWAYS_SUCCESS.clone());
        let owner = context
            .build_script_with_hash_type(&always, ScriptHashType::Data1, Bytes::new())
            .unwrap();
        let xudt_code = context.deploy_cell(Bytes::from_static(include_bytes!(
            "../../tests/fixtures/xudt"
        )));
        let token = context
            .build_script_with_hash_type(
                &xudt_code,
                ScriptHashType::Data1,
                Bytes::from(vec![0x11; 32]),
            )
            .unwrap();
        let funding = context.create_cell(cell(&owner, Some(&token), FUNDING), amount(TOKENS));
        let input = CellInput::new_builder().previous_output(funding).build();
        let mut hasher = ckb_hash::new_blake2b();
        hasher.update(input.as_slice());
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
            context
                .build_script_with_hash_type(
                    &code,
                    ScriptHashType::Data1,
                    Bytes::from(Args { role, pool_id }.encode().to_vec()),
                )
                .unwrap()
        });
        let metadata = StateData {
            fee: 30,
            locked: 1000,
            shares: 2_000_000_000_000,
            backing_state: 34_000_000_000,
            backing_ckb: 8_000_000_000,
            backing_token: 16_000_000_000,
            rx: 1,
            ry: 2,
            token_code_hash: token.code_hash().unpack(),
            token_owner: [0x11; 32],
        };
        let initial = metadata
            .accounting(1_000_000_000_000, 4_000_000_000_000)
            .unwrap();
        let result = create(initial.parameters, initial.x, initial.y, 1.into()).unwrap();
        let mut f = Self {
            context,
            code,
            owner,
            token,
            roles,
            metadata,
            initial,
            genesis: TransactionBuilder::default().build(),
        };
        let (outputs, data) = f.outputs(result);
        f.genesis = f.context.complete_tx(
            TransactionBuilder::default()
                .input(input)
                .outputs(outputs)
                .outputs_data(data)
                .witness(witness(Action::Create { minimum: 1 }, true).pack())
                .build(),
        );
        f
    }
    pub fn outputs(
        &self,
        r: Outcome,
    ) -> (Vec<CellOutput>, Vec<ckb_testtool::ckb_types::packed::Bytes>) {
        let mut metadata = self.metadata;
        metadata.shares = r.next.shares.low_u128();
        let pool_cap = metadata.backing_state
            + metadata.backing_ckb
            + metadata.backing_token
            + r.next.x.low_u64();
        let outputs = vec![
            cell(&self.roles[1], Some(&self.roles[0]), metadata.backing_state),
            cell(
                &self.roles[2],
                None,
                metadata.backing_ckb + r.next.x.low_u64(),
            ),
            cell(&self.roles[3], Some(&self.token), metadata.backing_token),
            cell(&self.owner, Some(&self.roles[4]), 20_000_000_000),
            cell(&self.owner, Some(&self.token), 20_000_000_000),
            cell(&self.owner, None, FUNDING - pool_cap - 40_000_000_000),
        ];
        let data = vec![
            Bytes::from(metadata.encode().unwrap().to_vec()).pack(),
            Bytes::new().pack(),
            amount(r.next.y.low_u128()).pack(),
            amount(r.next.shares.low_u128() - metadata.locked).pack(),
            amount(TOKENS - r.next.y.low_u128()).pack(),
            Bytes::new().pack(),
        ];
        (outputs, data)
    }
    pub fn transition(&mut self, a: Action) -> TransactionView {
        let result = transition(self.initial, a.operation().unwrap()).unwrap();
        let mut inputs = Vec::new();
        for (i, (cell, data)) in self.genesis.outputs_with_data_iter().enumerate() {
            let point = OutPoint::new_builder()
                .tx_hash(self.genesis.hash())
                .index(i as u32)
                .build();
            self.context
                .create_cell_with_out_point(point.clone(), cell, data);
            inputs.push(CellInput::new_builder().previous_output(point).build());
        }
        let (outputs, data) = self.outputs(result);
        self.context.complete_tx(
            TransactionBuilder::default()
                .inputs(inputs)
                .outputs(outputs)
                .outputs_data(data)
                .witness(witness(a, false).pack())
                .build(),
        )
    }
    pub fn check(&self, tx: &TransactionView, code: Option<i8>) -> u64 {
        match (self.context.verify_tx(tx, CYCLES), code) {
            (Ok(cycles), None) => {
                println!("cycles={cycles}");
                cycles
            }
            (Err(e), Some(code)) => {
                assert!(
                    e.to_string().contains(&format!("error code {code}")),
                    "expected {code}: {e:?}"
                );
                0
            }
            (result, expected) => panic!("expected {expected:?}, got {result:?}"),
        }
    }
}
