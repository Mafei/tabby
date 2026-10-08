use base64::{Engine as _, engine::general_purpose::STANDARD};
use zeroize::Zeroizing;

use crate::BridgeError;

pub(crate) fn validate_key_cost(key: &str) -> Result<(), BridgeError> {
    if key.len() > 64 * 1024 {
        return Err(BridgeError("private_key_too_large"));
    }
    // PKCS#8 KDFs have arbitrary cost parameters. This prototype supports
    // encrypted OpenSSH keys with a bounded bcrypt cost, not encrypted PKCS#8.
    if key.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----") {
        return Err(BridgeError("encrypted_pkcs8_unsupported"));
    }
    if !key.contains("-----BEGIN OPENSSH PRIVATE KEY-----") {
        return Ok(());
    }
    let encoded = Zeroizing::new(
        key.lines()
            .filter(|line| !line.starts_with("-----"))
            .map(str::trim)
            .collect::<String>(),
    );
    let blob = Zeroizing::new(
        STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| BridgeError("invalid_private_key"))?,
    );
    let mut bytes = blob
        .strip_prefix(b"openssh-key-v1\0")
        .ok_or(BridgeError("invalid_private_key"))?;
    let _cipher = read_string(&mut bytes)?;
    let kdf = read_string(&mut bytes)?;
    let mut options = read_string(&mut bytes)?;
    match kdf {
        b"none" if options.is_empty() => Ok(()),
        b"bcrypt" => {
            let salt = read_string(&mut options)?;
            let rounds = read_u32(&mut options)?;
            if salt.len() > 64 || rounds == 0 || rounds > 64 || !options.is_empty() {
                return Err(BridgeError("private_key_kdf_limit"));
            }
            Ok(())
        }
        _ => Err(BridgeError("private_key_kdf_unsupported")),
    }
}

fn read_u32(bytes: &mut &[u8]) -> Result<u32, BridgeError> {
    if bytes.len() < 4 {
        return Err(BridgeError("invalid_private_key"));
    }
    let value = u32::from_be_bytes(bytes[..4].try_into().unwrap());
    *bytes = &bytes[4..];
    Ok(value)
}

fn read_string<'a>(bytes: &mut &'a [u8]) -> Result<&'a [u8], BridgeError> {
    let length = read_u32(bytes)? as usize;
    if length > bytes.len() {
        return Err(BridgeError("invalid_private_key"));
    }
    let value = &bytes[..length];
    *bytes = &bytes[length..];
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encrypted_header(rounds: u32) -> String {
        fn field(out: &mut Vec<u8>, bytes: &[u8]) {
            out.extend((bytes.len() as u32).to_be_bytes());
            out.extend(bytes);
        }
        let mut blob = b"openssh-key-v1\0".to_vec();
        field(&mut blob, b"aes256-ctr");
        field(&mut blob, b"bcrypt");
        let mut options = Vec::new();
        field(&mut options, b"test-salt");
        options.extend(rounds.to_be_bytes());
        field(&mut blob, &options);
        format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----",
            STANDARD.encode(blob)
        )
    }

    #[test]
    fn rejects_unbounded_kdf_before_russh_decoding() {
        assert_eq!(
            validate_key_cost(&encrypted_header(u32::MAX)),
            Err(BridgeError("private_key_kdf_limit"))
        );
        assert_eq!(
            validate_key_cost(&encrypted_header(65)),
            Err(BridgeError("private_key_kdf_limit"))
        );
        assert_eq!(
            validate_key_cost(&encrypted_header(0)),
            Err(BridgeError("private_key_kdf_limit"))
        );
        assert_eq!(validate_key_cost(&encrypted_header(16)), Ok(()));
        assert_eq!(
            validate_key_cost("-----BEGIN ENCRYPTED PRIVATE KEY-----"),
            Err(BridgeError("encrypted_pkcs8_unsupported"))
        );
        assert_eq!(
            validate_key_cost(&"x".repeat(65537)),
            Err(BridgeError("private_key_too_large"))
        );
    }
}
