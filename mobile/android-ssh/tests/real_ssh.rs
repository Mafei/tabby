//! End-to-end SSH wire tests of the exact core APIs exported through JNI.
#![cfg(unix)]
mod common;
use common::{Connection, Fixture};
use serde_json::json;
use std::{fs, thread, time::Duration};
use tabby_ssh::{BridgeError, command_json};

#[test]
fn direct_ssh_auth_pty_cancel_and_cleanup() {
    let fixture = Fixture::start();

    // First contact is a real KEX challenge; no auth before an explicit choice.
    {
        let mut c = Connection::start(fixture.options(1, "password", false));
        let key = c.wait(|e| e["type"] == "hostKey");
        assert_eq!(key["fingerprint"], fixture.metadata["fingerprint"]);
        assert_eq!(key["keyBase64"], fixture.metadata["keyBase64"]);
        let stats = fixture.stats();
        assert_eq!(stats.get("result").unwrap_or(&stats)["authenticated"], 0);
        c.command(json!({"type":"hostKeyResponse","requestId":key["requestId"],"accept":false}))
            .unwrap();
        c.error("host_key_rejected");
    }
    fixture.wait_quiet();

    // Cancel while first-contact host prompt is outstanding and reconnect.
    {
        let mut c = Connection::start(fixture.options(2, "password", false));
        let key = c.wait(|e| e["type"] == "hostKey");
        c.command(json!({"type":"cancel"})).unwrap();
        c.error("cancelled");
        assert_eq!(
            c.command(json!({"type":"hostKeyResponse","requestId":key["requestId"],"accept":true})),
            Err(BridgeError("connection_closed"))
        );
    }
    fixture.wait_quiet();

    // Accept first host, actual password auth, binary UTF-8 PTY and window-change.
    {
        let mut c = Connection::start(fixture.options(3, "password", false));
        let key = c.wait(|e| e["type"] == "hostKey");
        c.command(json!({"type":"hostKeyResponse","requestId":key["requestId"],"accept":true}))
            .unwrap();
        c.auth(fixture.password_response());
        c.ready();
        assert_eq!(
            command_json(
                c.id,
                &json!({"type":"write","generation":2,"data":"YQ=="}).to_string()
            ),
            Err(BridgeError("stale_generation"))
        );
        assert_eq!(
            c.command(json!({"type":"resize","cols":0,"rows":0})),
            Err(BridgeError("invalid_dimensions"))
        );
        c.write(b"stty -echo\r");
        c.write("printf '\\n%s\\n' 'TABBY_' '中文_传输_OK'\r".as_bytes());
        c.output_contains("中文_传输_OK");
        c.command(json!({"type":"resize","cols":99,"rows":31}))
            .unwrap();
        fixture.wait_counter("resizeRequests", 1);
        c.write(b"stty size\r");
        c.output_contains("31 99");
        c.command(json!({"type":"cancel"})).unwrap();
        c.error("cancelled");
    }
    fixture.wait_quiet();

    // Pinned matches emit actual verification; a different pin is fatal before auth.
    {
        let mut c = Connection::start(fixture.options(4, "password", true));
        let key = c.wait(|e| e["type"] == "hostKey");
        assert_eq!(key["status"], "known");
        assert!(key.get("requestId").is_none());
        let auth = c.wait(|e| e["type"] == "auth");
        c.command(json!({"type":"cancel"})).unwrap();
        c.error("cancelled");
        assert_eq!(
            c.command(
                json!({"type":"authResponse","requestId":auth["requestId"],"password":"obsolete"})
            ),
            Err(BridgeError("connection_closed"))
        );
    }
    fixture.wait_quiet();
    {
        let mut options = fixture.options(5, "password", true);
        options["expectedHostKey"] = "different-public-pin".into();
        let mut c = Connection::start(options);
        c.error("host_key_changed");
        assert!(!c.pending.iter().any(|e| e["type"] == "auth"));
    }
    fixture.wait_quiet();

    // Both plaintext and passphrase-encrypted OpenSSH keys authenticate on wire.
    for (index, field) in ["privateKeyFile", "encryptedPrivateKeyFile"]
        .iter()
        .enumerate()
    {
        let mut c = Connection::start(fixture.options(10 + index as u64, "privateKey", true));
        let key = fs::read_to_string(fixture.metadata[*field].as_str().unwrap()).unwrap();
        let mut credentials = json!({"privateKey":key});
        if index == 1 {
            credentials["passphrase"] = fixture.metadata["privateKeyPassphrase"].clone();
        }
        c.auth(credentials);
        c.ready();
        c.write(b"printf '\\nTABBY_PUBLIC_KEY_OK\\n'\r");
        c.output_contains("TABBY_PUBLIC_KEY_OK");
        c.command(json!({"type":"close"})).unwrap();
        c.error("cancelled");
        drop(c);
        fixture.wait_quiet();
    }

    // Auth rejection/decode errors are sanitized codes, not secret/library text.
    {
        let mut c = Connection::start(fixture.options(12, "password", true));
        c.auth(json!({"password":"wrong-test-password"}));
        c.error("auth_rejected");
    }
    fixture.wait_quiet();
    {
        let mut c = Connection::start(fixture.options(13, "privateKey", true));
        c.auth(json!({"privateKey":"invalid-test-key"}));
        c.error("invalid_private_key");
    }
    fixture.wait_quiet();

    // Outstanding keyboard-interactive challenge cancels without answering it.
    fixture.configure(json!({"authMode":"keyboard-interactive"}));
    {
        let mut c = Connection::start(fixture.options(20, "keyboardInteractive", true));
        let auth = c.wait(|e| e["type"] == "auth");
        assert_eq!(auth["prompts"][0]["echo"], false);
        c.command(json!({"type":"cancel"})).unwrap();
        c.error("cancelled");
        assert_eq!(c.command(json!({"type":"authResponse","requestId":auth["requestId"],"responses":["obsolete"]})), Err(BridgeError("connection_closed")));
    }
    fixture.wait_quiet();
    {
        let mut c = Connection::start(fixture.options(21, "keyboardInteractive", true));
        c.auth(json!({"responses":[fixture.metadata["password"]]}));
        c.ready();
        c.command(json!({"type":"close"})).unwrap();
        c.error("cancelled");
    }
    fixture.wait_quiet();

    // Every acquisition stage can be cancelled; delayed requests create no shell.
    for (index, stage) in [
        "delayAuthMs",
        "delaySessionMs",
        "delayPTYMs",
        "delayShellMs",
    ]
    .iter()
    .enumerate()
    {
        fixture.configure(json!({*stage:20000}));
        let mut c = Connection::start(fixture.options(30 + index as u64, "password", true));
        c.auth(fixture.password_response());
        fixture.wait_counter("timers", 1);
        c.command(json!({"type":"cancel"})).unwrap();
        c.error("cancelled");
        drop(c);
        fixture.wait_quiet();
    }

    // PTY/shell failures require the server ACK and close all native resources.
    for (index, (field, expected)) in [
        ("rejectPTY", "pty_rejected"),
        ("rejectShell", "shell_rejected"),
    ]
    .iter()
    .enumerate()
    {
        fixture.configure(json!({*field:true}));
        let mut c = Connection::start(fixture.options(40 + index as u64, "password", true));
        c.auth(fixture.password_response());
        c.error(expected);
        drop(c);
        fixture.wait_quiet();
    }

    // A server that never ACKs cannot hold the single-flight connection forever.
    fixture.configure(json!({"delayPTYMs":20000}));
    {
        let mut c = Connection::start(fixture.options(42, "password", true));
        c.auth(fixture.password_response());
        c.error("pty_timeout");
    }
    fixture.wait_quiet();

    // Abrupt actual TCP loss terminates the native session and can reconnect.
    fixture.configure(json!({}));
    {
        let mut c = Connection::start(fixture.options(50, "password", true));
        c.auth(fixture.password_response());
        c.ready();
        fixture.control(json!({"type":"dropConnections"}));
        c.error("transport_lost");
    }
    fixture.wait_quiet();
    {
        let mut c = Connection::start(fixture.options(51, "password", true));
        c.auth(fixture.password_response());
        c.ready();
        // Fill output/event queues; cancellation must interrupt backpressure.
        c.write(b"head -c 1048576 /dev/zero | tr '\\000' x\r");
        thread::sleep(Duration::from_millis(500));
        c.command(json!({"type":"cancel"})).unwrap();
        c.error("cancelled");
    }
    fixture.wait_quiet();

    // Real host replacement at the same address cannot be user-accepted as old pin.
    fixture.control(json!({"type":"rotateHostKey"}));
    {
        let mut c = Connection::start(fixture.options(60, "password", true));
        c.error("host_key_changed");
        assert!(!c.pending.iter().any(|e| e["type"] == "auth"));
    }
    fixture.wait_quiet();
}
