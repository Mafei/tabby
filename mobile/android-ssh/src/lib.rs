//! Direct SSH transport for the Android prototype.
//!
//! There is no gateway, disk credential storage, or logging in this crate. The
//! existing desktop N-API binding and this bridge use the same russh core.

mod device_key;
mod engine;
#[cfg(feature = "jni")]
mod jni_bridge;
mod key_limits;
mod panic_guard;
mod protocol;

pub use device_key::{describe_device_key, generate_ed25519};
pub use engine::{command_json, destroy, poll_json, start_json};
pub use protocol::BridgeError;
