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

pub const CAP: u64 = 100_000_000_000;
pub const ASK: u128 = 100;
pub const MAX_CYCLES: u64 = 100_000_000;

pub fn terms(
    owner: &Script,
    ask: Option<&Script>,
    refund: u64,
    amount: u128,
    nonce: u8,
) -> Vec<u8> {
    let mut bytes = owner.as_slice().to_vec();
    bytes.extend([1, 0, 0, 0]);
    bytes.extend([nonce; 16]);
    bytes.extend(refund.to_le_bytes());
    let ask = ask.map(|s| s.as_slice()).unwrap_or_default();
    bytes.extend((ask.len() as u32).to_le_bytes());
    bytes.extend(ask);
    bytes.extend(amount.to_le_bytes());
    bytes
}

pub fn cell(lock: &Script, type_: Option<&Script>, capacity: u64) -> CellOutput {
    CellOutput::new_builder()
        .lock(lock.clone())
        .type_(type_.cloned().pack())
        .capacity(capacity)
        .build()
}

pub struct Fixture {
    pub context: Context,
    pub code: OutPoint,
    pub owner: Script,
    pub a: Script,
    pub b: Script,
    pub args: Vec<u8>,
    pub offer_type: Option<Script>,
    pub offer_data: Vec<u8>,
    pub offer_capacity: u64,
    pub payments: Vec<(CellOutput, Bytes)>,
    pub before: Vec<(CellOutput, Bytes)>,
    pub after: Vec<(CellOutput, Bytes)>,
    pub duplicate: bool,
}

impl Fixture {
    pub fn new() -> Self {
        let mut context = Context::new_with_deterministic_rng();
        let code = context.deploy_cell(
            std::fs::read(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../target/riscv64imac-unknown-none-elf/release/openswap-lock"
            ))
            .expect("run make build first")
            .into(),
        );
        let always = context.deploy_cell(ALWAYS_SUCCESS.clone());
        let mut script = |tag| {
            context
                .build_script_with_hash_type(&always, ScriptHashType::Data1, Bytes::from(vec![tag]))
                .unwrap()
        };
        let owner = script(0);
        let a = script(1);
        let b = script(2);
        Self {
            args: terms(&owner, Some(&b), CAP, ASK, 1),
            offer_type: Some(a.clone()),
            offer_data: 200_u128.to_le_bytes().to_vec(),
            offer_capacity: CAP,
            payments: vec![(
                cell(&owner, Some(&b), CAP),
                ASK.to_le_bytes().to_vec().into(),
            )],
            before: vec![],
            after: vec![],
            duplicate: false,
            context,
            code,
            owner,
            a,
            b,
        }
    }

    pub fn lock(&mut self) -> Script {
        self.context
            .build_script_with_hash_type(
                &self.code,
                ScriptHashType::Data1,
                self.args.clone().into(),
            )
            .unwrap()
    }

    pub fn ckb_ask(&mut self) {
        self.args = terms(&self.owner, None, CAP, ASK, 1);
        self.payments = vec![(cell(&self.owner, None, CAP + ASK as u64), Bytes::new())];
    }

    pub fn ckb_offer(&mut self) {
        self.offer_type = None;
        self.offer_data.clear();
        self.offer_capacity = CAP + 1000;
    }

    pub fn recovery(&mut self) {
        self.payments = vec![(
            cell(&self.owner, self.offer_type.as_ref(), self.offer_capacity),
            self.offer_data.clone().into(),
        )];
    }

    pub fn proof(&mut self, decrease: u64) {
        self.after
            .push((cell(&self.owner, None, CAP), Bytes::new()));
        self.payments
            .push((cell(&self.owner, None, CAP - decrease), Bytes::new()));
    }

    pub fn tx(&mut self) -> TransactionView {
        let order = (
            cell(&self.lock(), self.offer_type.as_ref(), self.offer_capacity),
            self.offer_data.clone().into(),
        );
        let mut cells = self.before.clone();
        cells.push(order.clone());
        if self.duplicate {
            cells.push(order);
        }
        cells.extend(self.after.clone());
        let inputs: Vec<_> = cells
            .into_iter()
            .map(|(cell, data)| {
                CellInput::new_builder()
                    .previous_output(self.context.create_cell(cell, data))
                    .build()
            })
            .collect();
        let tx = TransactionBuilder::default()
            .inputs(inputs)
            .outputs(
                self.payments
                    .iter()
                    .map(|(c, _)| c.clone())
                    .collect::<Vec<_>>(),
            )
            .outputs_data(
                self.payments
                    .iter()
                    .map(|(_, d)| d.pack())
                    .collect::<Vec<_>>(),
            )
            .build();
        self.context.complete_tx(tx)
    }

    pub fn check(mut self, code: Option<i8>) -> u64 {
        let tx = self.tx();
        let result = self.context.verify_tx(&tx, MAX_CYCLES);
        match code {
            None => {
                let cycles = result.expect("valid transaction");
                println!("cycles={cycles}");
                cycles
            }
            Some(code) => {
                let error = result.expect_err("must reject");
                assert!(
                    error.to_string().contains(&format!("error code {code}")),
                    "expected {code}, got {error:?}"
                );
                0
            }
        }
    }
}
