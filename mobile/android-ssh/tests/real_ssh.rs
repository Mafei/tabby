//! End-to-end SSH wire tests of the exact core APIs exported through JNI.
//! The server is an isolated ssh2 server with an actual Python/system PTY.
#![cfg(unix)]

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use tabby_ssh::{BridgeError, command_json, destroy, poll_json, start_json};

struct Fixture {
    metadata: Value,
    child: Option<Child>,
    metadata_file: Option<PathBuf>,
}

impl Fixture {
    fn start() -> Self {
        if let Some(path) = std::env::var_os("SSH_FIXTURE_METADATA") {
            return Self {
                metadata: serde_json::from_slice(
                    &fs::read(path).expect("fixture metadata readable"),
                )
                .expect("fixture metadata JSON"),
                child: None,
                metadata_file: None,
            };
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let metadata_file = std::env::temp_dir().join(format!(
            "tabby-rust-test-{}-{stamp}.json",
            std::process::id()
        ));
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/test-fixture.mjs");
        let child = Command::new("node")
            .arg(script)
            .arg("--metadata")
            .arg(&metadata_file)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("Node SSH fixture starts");
        let mut fixture = Self {
            metadata: Value::Null,
            child: Some(child),
            metadata_file: Some(metadata_file.clone()),
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(bytes) = fs::read(&metadata_file) {
                if let Ok(metadata) = serde_json::from_slice(&bytes) {
                    fixture.metadata = metadata;
                    return fixture;
                }
            }
            assert!(
                Instant::now() < deadline,
                "SSH fixture did not become ready; install repository ssh2 test dependency"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn control(&self, request: Value) -> Value {
        let mut socket = UnixStream::connect(self.metadata["controlSocket"].as_str().unwrap())
            .expect("fixture control connected");
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        serde_json::to_writer(&mut socket, &request).unwrap();
        socket.write_all(b"\n").unwrap();
        let mut line = String::new();
        BufReader::new(socket).read_line(&mut line).unwrap();
        serde_json::from_str(&line).expect("fixture control JSON")
    }

    fn configure(&self, fields: Value) {
        let mut request = json!({"type":"configure","authMode":"all","delayAuthMs":0,"delaySessionMs":0,
            "delayPTYMs":0,"delayShellMs":0,"rejectPTY":false,"rejectShell":false});
        for (key, value) in fields.as_object().unwrap() {
            request[key] = value.clone();
        }
        let response = self.control(request);
        assert_ne!(response["ok"], false, "fixture configuration rejected");
    }

    fn stats(&self) -> Value {
        self.control(json!({"type":"stats"}))
    }

    fn wait_quiet(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let stats = self.stats();
            let stats = stats.get("result").unwrap_or(&stats);
            if ["clients", "sessions", "ptys", "timers", "pendingAuth"]
                .iter()
                .all(|field| stats[*field] == 0)
            {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "fixture resources did not close: {stats}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_counter(&self, field: &str, minimum: u64) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let stats = self.stats();
            let stats = stats.get("result").unwrap_or(&stats);
            if stats[field].as_u64().unwrap_or_default() >= minimum {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "fixture stage not reached: {field}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn options(&self, generation: u64, mode: &str, pinned: bool) -> Value {
        let mut options = json!({"host":self.metadata["host"],"port":self.metadata["port"],
            "username":self.metadata["username"],"generation":generation,"authMode":mode,"cols":80,"rows":24});
        if pinned {
            options["expectedHostKey"] = self.metadata["keyBase64"].clone();
        }
        options
    }

    fn password_response(&self) -> Value {
        json!({"password":self.metadata["password"]})
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Only our own fixture PID; graceful shutdown removes its private files.
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(child.id().to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let deadline = Instant::now() + Duration::from_secs(3);
            while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(path) = &self.metadata_file {
            let _ = fs::remove_file(path);
        }
    }
}

struct Connection {
    id: u64,
    generation: u64,
    pending: VecDeque<Value>,
}

impl Connection {
    fn start(options: Value) -> Self {
        Self {
            generation: options["generation"].as_u64().unwrap(),
            id: start_json(&options.to_string()).expect("valid SSH connection starts"),
            pending: VecDeque::new(),
        }
    }

    fn command(&self, mut command: Value) -> Result<(), BridgeError> {
        command["generation"] = self.generation.into();
        command_json(self.id, &command.to_string())
    }

    fn wait(&mut self, predicate: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(35);
        loop {
            if let Some(index) = self.pending.iter().position(&predicate) {
                return self.pending.remove(index).unwrap();
            }
            let batch: Vec<Value> = serde_json::from_str(&poll_json(self.id).unwrap()).unwrap();
            for event in batch {
                assert_eq!(event["generation"], self.generation);
                assert_eq!(event["connectionId"], self.id);
                self.pending.push_back(event);
            }
            assert!(Instant::now() < deadline, "SSH event deadline exceeded");
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn auth(&mut self, credentials: Value) {
        let auth = self.wait(|e| e["type"] == "auth");
        let mut response = json!({"type":"authResponse","requestId":auth["requestId"]});
        for (key, value) in credentials.as_object().unwrap() {
            response[key] = value.clone();
        }
        self.command(response)
            .expect("current authentication response accepted");
    }

    fn ready(&mut self) {
        let state =
            self.wait(|e| e["type"] == "state" && (e["state"] == "ready" || e["state"] == "error"));
        assert_eq!(
            state["state"], "ready",
            "SSH ready failed with stable code: {}",
            state["code"]
        );
    }

    fn error(&mut self, expected: &str) {
        let state = self
            .wait(|e| e["type"] == "state" && (e["state"] == "error" || e["state"] == "closed"));
        assert_eq!(state["code"], expected);
    }

    fn write(&self, bytes: &[u8]) {
        self.command(json!({"type":"write","data":STANDARD.encode(bytes)}))
            .expect("input accepted");
    }

    fn output_contains(&mut self, needle: &str) {
        let mut bytes = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !String::from_utf8_lossy(&bytes).contains(needle) {
            let event = self
                .wait(|e| e["type"] == "data" || (e["type"] == "state" && e["state"] == "error"));
            assert_eq!(event["type"], "data", "terminal closed: {}", event["code"]);
            bytes.extend(STANDARD.decode(event["data"].as_str().unwrap()).unwrap());
            assert!(
                bytes.len() < 2 * 1024 * 1024 && Instant::now() < deadline,
                "expected terminal output not received"
            );
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        destroy(self.id);
    }
}

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
