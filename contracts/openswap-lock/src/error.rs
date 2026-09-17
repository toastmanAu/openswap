use ckb_std::error::SysError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i8)]
#[allow(dead_code)] // Published codes remain reserved even when not emitted.
pub enum Error {
    IndexOutOfBound = 1,
    ItemMissing = 2,
    LengthNotEnough = 3,
    Encoding = 4,
    ScriptTooLarge = 20,
    ArgsTooShort = 21,
    OwnerScriptTooLarge = 22,
    OwnerScriptInvalid = 23,
    AskScriptTooLarge = 24,
    AskScriptInvalid = 25,
    ArgsLengthInvalid = 26,
    UnsupportedVersion = 27,
    UnsupportedFlags = 28,
    ReservedNonZero = 29,
    NonceZero = 30,
    AskAmountZero = 31,
    SelfOwnerLock = 32,
    InvalidGroupInputCount = 33,
    InputIndexNotFound = 34,
    OfferDataInvalid = 40,
    OfferAmountZero = 41,
    CapacityRefundInvalid = 42,
    SameAsset = 43,
    OrderRecreated = 50,
    PaymentOutputMissing = 51,
    PaymentOwnerMismatch = 52,
    AskAssetMismatch = 53,
    AskDataInvalid = 54,
    AskAmountInsufficient = 55,
    PaymentCapacityInvalid = 56,
    CkbAskUnrepresentable = 57,
    CancelRecoveryInvalid = 60,
    CancelProofMissing = 61,
}

impl From<SysError> for Error {
    fn from(error: SysError) -> Self {
        match error {
            SysError::IndexOutOfBound => Self::IndexOutOfBound,
            SysError::ItemMissing => Self::ItemMissing,
            SysError::LengthNotEnough(_) => Self::LengthNotEnough,
            _ => Self::Encoding,
        }
    }
}
