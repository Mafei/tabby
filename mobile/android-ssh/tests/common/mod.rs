// Each integration suite intentionally uses a different subset of this harness.
#![allow(dead_code)]
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

pub struct Fixture {
    pub metadata: Value,
    child: Option<Child>,
    metadata_file: Option<PathBuf>,
}

impl Fixture {
    pub fn start() -> Self {
        Self::start_profile("shell")
    }

    pub fn start_control() -> Self {
        Self::start_profile("control")
    }

    fn start_profile(profile: &str) -> Self {
        let metadata_env = if profile == "shell" {
            "SSH_FIXTURE_METADATA"
        } else {
            "SSH_CONTROL_FIXTURE_METADATA"
        };
        if let Some(path) = std::env::var_os(metadata_env) {
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
        let mut command = Command::new("node");
        if profile != "shell" {
            command.arg(&script).arg("--profile").arg(profile);
        } else {
            command.arg(&script);
        }
        let child = command
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

    pub fn control(&self, request: Value) -> Value {
        let mut socket = UnixStream::connect(self.metadata["controlSocket"].as_str().unwrap())
            .unwrap_or_else(|error| {
                eprintln!(
                    "fixture control connect failed with kind {:?}",
                    error.kind()
                );
                panic!("fixture control unavailable");
            });
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        serde_json::to_writer(&mut socket, &request).unwrap();
        socket.write_all(b"\n").unwrap();
        let mut line = String::new();
        BufReader::new(socket).read_line(&mut line).unwrap();
        serde_json::from_str(&line).expect("fixture control JSON")
    }

    pub fn configure(&self, fields: Value) {
        let mut request = json!({"type":"configure","authMode":"all","delayAuthMs":0,"delaySessionMs":0,
            "delayPTYMs":0,"delayShellMs":0,"rejectPTY":false,"rejectShell":false,
            "delayExecAckMs":0,"delayExecOutputMs":0,"delayExecExitMs":0,"rejectExec":false,
            "noExitStatus":false,"closeChannelOnly":false,"eofOnly":false,"omitBareCloseAck":false});
        for (key, value) in fields.as_object().unwrap() {
            request[key] = value.clone();
        }
        let response = self.control(request);
        assert_ne!(response["ok"], false, "fixture configuration rejected");
    }

    pub fn stats(&self) -> Value {
        self.control(json!({"type":"stats"}))
    }

    pub fn wait_quiet(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let stats = self.stats();
            let stats = stats.get("result").unwrap_or(&stats);
            if [
                "clients",
                "sessions",
                "ptys",
                "execs",
                "timers",
                "pendingAuth",
            ]
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

    pub fn wait_counter(&self, field: &str, minimum: u64) {
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

    pub fn options(&self, generation: u64, mode: &str, pinned: bool) -> Value {
        let mut options = json!({"host":self.metadata["host"],"port":self.metadata["port"],
            "username":self.metadata["username"],"generation":generation,"authMode":mode,"cols":80,"rows":24});
        if pinned {
            options["expectedHostKey"] = self.metadata["keyBase64"].clone();
        }
        options
    }

    pub fn password_response(&self) -> Value {
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

pub struct Connection {
    pub id: u64,
    pub generation: u64,
    pub pending: VecDeque<Value>,
}

impl Connection {
    pub fn start(options: Value) -> Self {
        let id = start_json(&options.to_string()).expect("valid SSH connection starts");
        // Keep assertion locations useful while preserving the native rule that
        // panic payloads (which can include credentials) are never printed.
        std::panic::set_hook(Box::new(|panic| {
            if let Some(location) = panic.location() {
                eprintln!("test failure at {}:{}", location.file(), location.line());
            }
        }));
        Self {
            generation: options["generation"].as_u64().unwrap(),
            id,
            pending: VecDeque::new(),
        }
    }

    pub fn command(&self, mut command: Value) -> Result<(), BridgeError> {
        command["generation"] = self.generation.into();
        command_json(self.id, &command.to_string())
    }

    pub fn wait(&mut self, predicate: impl Fn(&Value) -> bool) -> Value {
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

    pub fn auth(&mut self, credentials: Value) {
        let auth = self.wait(|e| e["type"] == "auth");
        let mut response = json!({"type":"authResponse","requestId":auth["requestId"]});
        for (key, value) in credentials.as_object().unwrap() {
            response[key] = value.clone();
        }
        self.command(response)
            .expect("current authentication response accepted");
    }

    pub fn ready(&mut self) {
        let state =
            self.wait(|e| e["type"] == "state" && (e["state"] == "ready" || e["state"] == "error"));
        assert_eq!(
            state["state"], "ready",
            "SSH ready failed with stable code: {}",
            state["code"]
        );
    }

    pub fn error(&mut self, expected: &str) {
        let state = self
            .wait(|e| e["type"] == "state" && (e["state"] == "error" || e["state"] == "closed"));
        assert_eq!(state["code"], expected);
    }

    pub fn write(&self, bytes: &[u8]) {
        self.command(json!({"type":"write","data":STANDARD.encode(bytes)}))
            .expect("input accepted");
    }

    pub fn output_contains(&mut self, needle: &str) {
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
