//! Local software generation only. Android wraps these bytes with Keystore;
//! neither private key bytes nor an export method enter the JavaScript bridge.
use russh::keys::{Algorithm, HashAlg, PrivateKey, ssh_key::LineEnding};
use zeroize::Zeroizing;

use crate::{BridgeError, key_limits::validate_key_cost};

pub fn generate_ed25519() -> Result<Zeroizing<Vec<u8>>, BridgeError> {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .map_err(|_| BridgeError("key_generation_failed"))?;
    let pem = key
        .to_openssh(LineEnding::LF)
        .map_err(|_| BridgeError("key_generation_failed"))?;
    Ok(Zeroizing::new(pem.as_bytes().to_vec()))
}

pub fn describe_device_key(bytes: &[u8]) -> Result<String, BridgeError> {
    if bytes.is_empty() || bytes.len() > 64 * 1024 {
        return Err(BridgeError("invalid_device_key"));
    }
    let pem = std::str::from_utf8(bytes).map_err(|_| BridgeError("invalid_device_key"))?;
    validate_key_cost(pem)?;
    let key =
        russh::keys::decode_secret_key(pem, None).map_err(|_| BridgeError("invalid_device_key"))?;
    if key.algorithm() != Algorithm::Ed25519 || key.is_encrypted() {
        return Err(BridgeError("unsupported_device_key"));
    }
    let public = key.public_key();
    let encoded = public
        .to_openssh()
        .map_err(|_| BridgeError("invalid_device_key"))?;
    // Comments are not identity. Return just the algorithm and public blob.
    let line = encoded
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    Ok(
        serde_json::json!({ "algorithm": "ssh-ed25519", "publicKey": line,
        "fingerprint": public.fingerprint(HashAlg::Sha256).to_string() })
        .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_ed25519_keys_have_stable_public_identity_only() {
        let first = generate_ed25519().unwrap();
        let second = generate_ed25519().unwrap();
        assert!(first != second);
        let info = describe_device_key(&first).unwrap();
        assert_eq!(describe_device_key(&first).unwrap(), info);
        assert_ne!(describe_device_key(&second).unwrap(), info);
        let record: serde_json::Value = serde_json::from_str(&info).unwrap();
        assert_eq!(record["algorithm"], "ssh-ed25519");
        assert!(
            record["publicKey"]
                .as_str()
                .unwrap()
                .starts_with("ssh-ed25519 ")
        );
        assert!(
            record["fingerprint"]
                .as_str()
                .unwrap()
                .starts_with("SHA256:")
        );
        assert_eq!(record.as_object().unwrap().len(), 3);
        assert!(!info.contains("PRIVATE KEY"));
    }
    #[test]
    fn malformed_and_oversized_private_inputs_fail_with_fixed_codes() {
        for bytes in [
            Vec::new(),
            b"synthetic-invalid-key".to_vec(),
            vec![0; 65537],
        ] {
            assert!(describe_device_key(&bytes).is_err());
        }
    }
}
