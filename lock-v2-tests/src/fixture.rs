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

pub const CKB: u64 = 100_000_000;
pub const MAX_CYCLES: u64 = 100_000_000;

pub struct Terms {
    pub refund: u64,
    pub expiry: u64,
    pub ask: Option<Script>,
    pub ask_amount: u128,
    pub offer_amount: u128,
    pub min_fill: u128,
    pub nonce: u8,
}

/// Independent Rust encoder of the v2 tail (WIRE_FORMAT.md, version 2).
pub fn args(owner: &Script, t: &Terms) -> Vec<u8> {
    let mut bytes = owner.as_slice().to_vec();
    bytes.extend([2, 0, 0, 0]);
    bytes.extend([t.nonce; 16]);
    bytes.extend(t.refund.to_le_bytes());
    bytes.extend(t.expiry.to_le_bytes());
    let ask = t
        .ask
        .as_ref()
        .map(|s| s.as_slice().to_vec())
        .unwrap_or_default();
    bytes.extend((ask.len() as u32).to_le_bytes());
    bytes.extend(ask);
    bytes.extend(t.ask_amount.to_le_bytes());
    bytes.extend(t.offer_amount.to_le_bytes());
    bytes.extend(t.min_fill.to_le_bytes());
    bytes
}

pub fn cell(lock: &Script, type_: Option<&Script>, capacity: u64) -> CellOutput {
    CellOutput::new_builder()
        .lock(lock.clone())
        .type_(type_.cloned().pack())
        .capacity(capacity)
        .build()
}

pub struct Env {
    pub context: Context,
    pub code: OutPoint,
    pub owner: Script,
    pub a: Script,
    pub b: Script,
    pub other: Script,
}

impl Env {
    pub fn new() -> Self {
        let mut context = Context::new_with_deterministic_rng();
        let code = context.deploy_cell(
            std::fs::read(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../target/riscv64imac-unknown-none-elf/release/openswap-lock-v2"
            ))
            .expect("run make lock-v2-build first")
            .into(),
        );
        let always = context.deploy_cell(ALWAYS_SUCCESS.clone());
        let mut script = |tag| {
            context
                .build_script_with_hash_type(&always, ScriptHashType::Data1, Bytes::from(vec![tag]))
                .unwrap()
        };
        let (owner, a, b, other) = (script(0), script(1), script(2), script(3));
        Self {
            context,
            code,
            owner,
            a,
            b,
            other,
        }
    }

    pub fn lock(&mut self, args: Vec<u8>) -> Script {
        self.context
            .build_script_with_hash_type(&self.code, ScriptHashType::Data1, args.into())
            .unwrap()
    }

    pub fn input(&mut self, cell: CellOutput, data: Bytes, since: u64) -> CellInput {
        CellInput::new_builder()
            .previous_output(self.context.create_cell(cell, data))
            .since(since)
            .build()
    }

    pub fn tx(
        &mut self,
        inputs: Vec<CellInput>,
        outputs: Vec<(CellOutput, Bytes)>,
    ) -> TransactionView {
        let tx = TransactionBuilder::default()
            .inputs(inputs)
            .outputs(outputs.iter().map(|(c, _)| c.clone()).collect::<Vec<_>>())
            .outputs_data(outputs.iter().map(|(_, d)| d.pack()).collect::<Vec<_>>())
            .build();
        self.context.complete_tx(tx)
    }

    /// 0 = must verify; otherwise the lock must fail with this code.
    pub fn expect(&self, tx: &TransactionView, code: i8, label: &str) -> u64 {
        let result = self.context.verify_tx(tx, MAX_CYCLES);
        if code == 0 {
            result.unwrap_or_else(|e| panic!("{label}: expected success, got {e:?}"))
        } else {
            let error = result.expect_err(label);
            assert!(
                error
                    .to_string()
                    .contains(&format!("error code {code} on page")),
                "{label}: expected {code}, got {error:?}"
            );
            0
        }
    }
}
