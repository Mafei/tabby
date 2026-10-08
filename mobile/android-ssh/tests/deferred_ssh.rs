//! Real SSH control requests and deferred PTY lifecycle; no synthetic transport.
#![cfg(unix)]
mod common;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use common::{Connection, Fixture};
use serde_json::{Value, json};
use std::{sync::Mutex, thread, time::Duration};
use tabby_ssh::{BridgeError, command_json, poll_json};

// These suites share the public engine's four-connection cap. Concurrency is
// exercised deliberately within each suite instead of between unrelated fixtures.
static SERIAL: Mutex<()> = Mutex::new(());

#[test]
fn terminal_acquisition_interruption_uses_confirmed_transport_reason() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let fixture = Fixture::start_control();
    for (stage_index, (stage, kind)) in [
        ("delaySessionMs", "shell"),
        ("delayPTYMs", "shell"),
        ("delayShellMs", "shell"),
        ("delayExecAckMs", "exec"),
    ]
    .iter()
    .enumerate()
    {
        for (reason_index, (control, code, lost)) in [
            ("dropConnections", "transport_lost", true),
            ("disconnectConnections", "remote_disconnect", true),
            ("corruptTransport", "transport_failed", false),
        ]
        .iter()
        .enumerate()
        {
            fixture.configure(json!({}));
            let mut connection = deferred(&fixture, 500 + (stage_index * 3 + reason_index) as u64);
            fixture.configure(json!({*stage:20000}));
            let mut request = json!({"type":"openTerminal","requestId":1,"kind":kind});
            if *kind == "exec" {
                request["command"] = "sleep 20".into();
            }
            connection.command(request).unwrap();
            fixture.wait_counter("timers", 1);
            assert_ne!(fixture.control(json!({"type":control}))["ok"], false);
            let completion = connection
                .wait(|event| event["type"] == "terminalError" && event["requestId"] == 1);
            assert_eq!(completion["code"], *code, "terminal stage {stage}");
            let ended = connection.wait(|event| {
                event["type"] == "state"
                    && matches!(event["state"].as_str(), Some("error" | "closed"))
            });
            assert_eq!(ended["code"], *code, "terminal stage {stage}");
            assert_eq!(ended["transportLost"], *lost);
            assert!(
                !connection
                    .pending
                    .iter()
                    .any(|event| event["state"] == "ready" || event["type"] == "terminalError")
            );
            drop(connection);
            fixture.wait_quiet();
        }
    }
}

#[test]
fn missing_peer_close_resets_only_its_own_transport() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let fixture = Fixture::start_control();
    let mut first = deferred(&fixture, 400);
    let mut second = deferred(&fixture, 401);
    fixture.configure(json!({"delaySessionMs":150,"omitBareCloseAck":true}));
    exec(&first, 1, "printf MUST_NOT_EXECUTE");
    fixture.wait_counter("timers", 1);
    first
        .command(json!({"type":"execCancel","requestId":1}))
        .unwrap();
    failure(&mut first, 1, "exec_cancelled");
    let ended = first.wait(|event| event["type"] == "state" && event["state"] == "error");
    assert_eq!(ended["code"], "channel_cleanup_timeout");
    assert_eq!(ended["transportLost"], false);
    let stats = fixture.stats()["result"].clone();
    assert_eq!(stats["bareCloseOmitted"], 1);
    assert_eq!(stats["execRequests"], 0);
    assert_eq!(stats["execStarts"], 0);
    drop(first);
    fixture.configure(json!({}));
    exec(&second, 1, "printf OTHER_CONNECTION_STILL_ALIVE");
    assert_eq!(success(&mut second, 1, 0), b"OTHER_CONNECTION_STILL_ALIVE");
    close(&mut second);
    drop(second);
    fixture.wait_quiet();
}

#[test]
fn true_transport_loss_is_distinct_from_ssh_disconnect_and_protocol_failure() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let fixture = Fixture::start_control();
    for (stage_index, stage) in [None, Some("delaySessionMs"), Some("delayExecAckMs")]
        .iter()
        .enumerate()
    {
        for (index, (control, code, lost, counter)) in [
            ("dropConnections", "transport_lost", true, ""),
            (
                "disconnectConnections",
                "remote_disconnect",
                true,
                "protocolDisconnects",
            ),
            (
                "corruptTransport",
                "transport_failed",
                false,
                "transportCorruptions",
            ),
        ]
        .iter()
        .enumerate()
        {
            fixture.configure(json!({}));
            let mut connection = deferred(&fixture, 300 + (stage_index * 3 + index) as u64);
            if let Some(stage) = stage {
                fixture.configure(json!({*stage:20000}));
            }
            exec(&connection, 1, "printf BEFORE_INTERRUPTION; sleep 20");
            if stage.is_some() {
                fixture.wait_counter("timers", 1);
            } else {
                connection.wait(|event| event["type"] == "execStarted" && event["requestId"] == 1);
            }
            let previous = fixture.stats()["result"][counter]
                .as_u64()
                .unwrap_or_default();
            assert_ne!(fixture.control(json!({"type":control}))["ok"], false);
            let (completion, _, _) = completion(&mut connection, 1);
            assert_eq!(completion["type"], "execError");
            assert_eq!(completion["code"], *code, "exec stage {stage:?}");
            assert_eq!(completion["complete"], false);
            let ended = connection.wait(|event| {
                event["type"] == "state"
                    && matches!(event["state"].as_str(), Some("error" | "closed"))
            });
            assert_eq!(ended["code"], *code);
            assert_eq!(ended["transportLost"], *lost);
            drop(connection);
            fixture.wait_quiet();
            if !counter.is_empty() {
                assert_eq!(fixture.stats()["result"][counter], previous + 1);
            }
        }
    }
}

fn deferred(fixture: &Fixture, generation: u64) -> Connection {
    let mut options = fixture.options(generation, "password", true);
    options["deferTerminal"] = true.into();
    let mut connection = Connection::start(options);
    assert_eq!(
        connection.command(json!({"type":"exec","requestId":1,"command":"true"})),
        Err(BridgeError("not_authenticated"))
    );
    connection.auth(fixture.password_response());
    let state = connection.wait(|event| {
        event["type"] == "state" && (event["state"] == "authenticated" || event["state"] == "error")
    });
    assert_eq!(
        state["state"], "authenticated",
        "authentication failed with stable code {}",
        state["code"]
    );
    assert_eq!(state["deferredTerminal"], true);
    assert!(
        !connection
            .pending
            .iter()
            .any(|event| event["state"] == "ready")
    );
    assert_eq!(
        connection.command(json!({"type":"write","data":"YQ=="})),
        Err(BridgeError("not_ready"))
    );
    connection
}

fn exec(connection: &Connection, id: u64, command: &str) {
    connection
        .command(json!({"type":"exec","requestId":id,"command":command}))
        .unwrap_or_else(|error| {
            eprintln!("control request {id} rejected with stable code {}", error.0);
            panic!("control admission failed");
        });
}

fn completion(connection: &mut Connection, id: u64) -> (Value, Vec<u8>, Vec<u8>) {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    loop {
        let event = connection.wait(|event| {
            (event["requestId"] == id
                && matches!(
                    event["type"].as_str(),
                    Some("execStarted" | "execData" | "execExit" | "execError")
                ))
                || (event["type"] == "state" && event["state"] == "error")
        });
        match event["type"].as_str().unwrap() {
            "execStarted" => {}
            "execData" => {
                let bytes = STANDARD.decode(event["data"].as_str().unwrap()).unwrap();
                assert!(bytes.len() <= 16 * 1024);
                if event["extended"] == true {
                    stderr.extend(bytes);
                } else {
                    stdout.extend(bytes);
                }
                assert!(stdout.len() + stderr.len() <= 1024 * 1024);
            }
            "execExit" | "execError" => return (event, stdout, stderr),
            _ => panic!(
                "connection ended before control completion: {}",
                event["code"]
            ),
        }
    }
}

fn success(connection: &mut Connection, id: u64, expected_status: u32) -> Vec<u8> {
    let (event, stdout, _) = completion(connection, id);
    assert_eq!(
        event["type"], "execExit",
        "control failed with stable code {}",
        event["code"]
    );
    assert_eq!(event["exitStatus"], expected_status);
    assert_eq!(event["complete"], true);
    stdout
}

fn failure(connection: &mut Connection, id: u64, code: &str) {
    let (event, _, _) = completion(connection, id);
    assert_eq!(event["type"], "execError");
    assert_eq!(event["code"], code);
    assert_eq!(event["complete"], false);
}

fn close(connection: &mut Connection) {
    connection.command(json!({"type":"cancel"})).unwrap();
    let state = connection.wait(|event| event["type"] == "state" && event["state"] == "closed");
    assert_eq!(state["code"], "cancelled");
    assert_eq!(state["transportLost"], false);
}

#[test]
fn deferred_exec_boundaries_and_terminal_lifecycle() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let fixture = Fixture::start_control();
    let mut connection = deferred(&fixture, 100);

    // A real no-PTY command has independent stdout/stderr and a nonzero result.
    exec(
        &connection,
        1,
        "printf 'CONTROL_中文🙂'; printf 'CONTROL_STDERR' >&2; exit 7",
    );
    let (event, stdout, stderr) = completion(&mut connection, 1);
    assert_eq!(event["type"], "execExit");
    assert_eq!(event["exitStatus"], 7);
    assert_eq!(event["complete"], true);
    assert_eq!(String::from_utf8(stdout).unwrap(), "CONTROL_中文🙂");
    assert_eq!(String::from_utf8(stderr).unwrap(), "CONTROL_STDERR");
    assert!(
        !connection
            .pending
            .iter()
            .any(|event| event["type"] == "data" || event["state"] == "ready")
    );
    assert_eq!(
        connection.command(json!({"type":"exec","requestId":1,"command":"true"})),
        Err(BridgeError("stale_request"))
    );

    // Data can arrive before request Success; it must keep its request route.
    fixture.configure(json!({"delayExecAckMs":150}));
    exec(&connection, 2, "printf EARLY_CONTROL");
    let first = connection.wait(|event| {
        event["requestId"] == 2 && (event["type"] == "execData" || event["type"] == "execStarted")
    });
    assert_eq!(first["type"], "execData");
    assert_eq!(first["extended"], false);
    assert_eq!(
        STANDARD.decode(first["data"].as_str().unwrap()).unwrap(),
        b"EARLY_CONTROL"
    );
    success(&mut connection, 2, 0);
    fixture.configure(json!({}));

    // Request cancellation closes only that channel; no auth or PTY recreation.
    exec(&connection, 3, "sleep 20");
    connection.wait(|event| event["requestId"] == 3 && event["type"] == "execStarted");
    connection
        .command(json!({"type":"execCancel","requestId":3}))
        .unwrap();
    failure(&mut connection, 3, "exec_cancelled");
    connection
        .command(json!({"type":"execCancel","requestId":3}))
        .unwrap();
    exec(&connection, 4, "printf AFTER_CANCEL");
    assert_eq!(success(&mut connection, 4, 0), b"AFTER_CANCEL");

    // Admission is atomic and bounded; rejected ID can be retried after cleanup.
    exec(&connection, 5, "sleep 20");
    exec(&connection, 6, "sleep 20");
    assert_eq!(
        connection.command(json!({"type":"exec","requestId":7,"command":"true"})),
        Err(BridgeError("exec_limit"))
    );
    for id in [5, 6] {
        connection
            .command(json!({"type":"execCancel","requestId":id}))
            .unwrap();
        failure(&mut connection, id, "exec_cancelled");
    }
    exec(&connection, 7, "true");
    success(&mut connection, 7, 0);
    assert_eq!(
        connection
            .command(json!({"type":"exec","requestId":9_007_199_254_740_992u64,"command":"true"})),
        Err(BridgeError("invalid_request_id"))
    );

    // Cancelling sent channel-open retains its future and closes the late channel.
    fixture.configure(json!({"delaySessionMs":250}));
    let before = fixture.stats()["result"].clone();
    exec(&connection, 8, "printf LATE_COMMAND_MUST_NOT_RUN");
    fixture.wait_counter("timers", 1);
    connection
        .command(json!({"type":"execCancel","requestId":8}))
        .unwrap();
    failure(&mut connection, 8, "exec_cancelled");
    let after = fixture.stats()["result"].clone();
    assert_eq!(after["execRequests"], before["execRequests"]);
    assert_eq!(after["execStarts"], before["execStarts"]);
    assert_eq!(after["sessions"], 0);
    fixture.configure(json!({}));
    exec(&connection, 9, "printf AFTER_LATE_CLEANUP");
    assert_eq!(success(&mut connection, 9, 0), b"AFTER_LATE_CLEANUP");

    // Missing status/early channel Close are incomplete, never network loss.
    for (id, field) in [(10, "noExitStatus"), (11, "closeChannelOnly")] {
        fixture.configure(json!({field:true}));
        exec(&connection, id, "printf INCOMPLETE");
        failure(&mut connection, id, "exec_incomplete");
    }
    fixture.configure(json!({"rejectExec":true}));
    exec(&connection, 12, "true");
    failure(&mut connection, 12, "exec_rejected");
    fixture.configure(json!({}));

    exec(&connection, 13, "head -c 1048577 /dev/zero");
    failure(&mut connection, 13, "exec_output_limit");
    exec(&connection, 14, "sleep 20");
    failure(&mut connection, 14, "exec_timeout");
    exec(&connection, 15, "printf AFTER_LIMIT_AND_TIMEOUT");
    assert_eq!(success(&mut connection, 15, 0), b"AFTER_LIMIT_AND_TIMEOUT");

    // A dropped, backpressured send must release its event reservation.
    exec(&connection, 16, "head -c 1048576 /dev/zero; sleep 20");
    thread::sleep(Duration::from_millis(300));
    connection
        .command(json!({"type":"execCancel","requestId":16}))
        .unwrap();
    failure(&mut connection, 16, "exec_cancelled");
    exec(&connection, 17, "printf AFTER_BACKPRESSURE_CANCEL");
    assert_eq!(
        success(&mut connection, 17, 0),
        b"AFTER_BACKPRESSURE_CANCEL"
    );

    // Recoverable PTY failure permits an explicit plain SSH fallback.
    fixture.configure(json!({"rejectPTY":true}));
    connection
        .command(json!({"type":"openTerminal","requestId":18,"kind":"shell"}))
        .unwrap();
    let failed =
        connection.wait(|event| event["type"] == "terminalError" && event["requestId"] == 18);
    assert_eq!(failed["code"], "pty_rejected");
    fixture.configure(json!({}));
    connection
        .command(json!({"type":"openTerminal","requestId":19,"kind":"shell","cols":99,"rows":31}))
        .unwrap();
    let ready = connection.wait(|event| event["state"] == "ready");
    assert_eq!(ready["requestId"], 19);
    assert_eq!(ready["terminalKind"], "shell");
    assert_eq!(
        connection.command(json!({"type":"openTerminal","requestId":20,"kind":"shell"})),
        Err(BridgeError("terminal_exists"))
    );
    connection.write(b"stty -echo; stty size\r");
    connection.output_contains("31 99");
    connection.write("printf '\\nPTY_中文🙂\\n'\r".as_bytes());
    connection.output_contains("PTY_中文🙂");
    close(&mut connection);
    drop(connection);
    fixture.wait_quiet();

    // A short PTY exec channel closes while TCP is alive. No reconnect trigger.
    fixture.configure(json!({"noExitStatus":true}));
    let mut connection = deferred(&fixture, 101);
    connection.command(json!({"type":"openTerminal","requestId":1,"kind":"exec","command":"printf PTY_EXEC; sleep 0.1"})).unwrap();
    let ready = connection.wait(|event| event["state"] == "ready");
    assert_eq!(ready["terminalKind"], "exec");
    connection.output_contains("PTY_EXEC");
    let closed = connection.wait(|event| event["type"] == "state" && event["state"] == "closed");
    assert_eq!(closed["code"], "remote_closed");
    assert_eq!(closed["transportLost"], false);
    drop(connection);
    fixture.wait_quiet();

    // Native API generation gates apply to control operations too.
    fixture.configure(json!({}));
    let mut first = deferred(&fixture, 102);
    let mut second = deferred(&fixture, 103);
    assert_eq!(
        command_json(
            second.id,
            &json!({"type":"exec","generation":102,"requestId":1,"command":"true"}).to_string()
        ),
        Err(BridgeError("stale_generation"))
    );
    exec(&first, 1, "sleep 20");
    first.command(json!({"type":"cancel"})).unwrap();
    failure(&mut first, 1, "cancelled");
    first.wait(|event| event["state"] == "closed");
    drop(first);
    exec(&second, 1, "printf OTHER_TAB_SURVIVES");
    assert_eq!(success(&mut second, 1, 0), b"OTHER_TAB_SURVIVES");
    fixture.control(json!({"type":"dropConnections"}));
    let lost = second.wait(|event| event["state"] == "error");
    assert_eq!(lost["code"], "transport_lost");
    assert_eq!(lost["transportLost"], true);
    drop(second);
    fixture.wait_quiet();

    // Unknown acquisition cannot retain an old request forever. Reset this ID.
    let mut first = deferred(&fixture, 104);
    let mut second = deferred(&fixture, 105);
    second
        .command(json!({"type":"openTerminal","requestId":1,"kind":"shell"}))
        .unwrap();
    second.ready();
    fixture.configure(json!({"delaySessionMs":20000}));
    exec(&first, 1, "printf NEVER_EXECUTED");
    fixture.wait_counter("timers", 1);
    first
        .command(json!({"type":"execCancel","requestId":1}))
        .unwrap();
    failure(&mut first, 1, "exec_cancelled");
    let ended = first.wait(|event| event["state"] == "error");
    assert_eq!(ended["code"], "channel_cleanup_timeout");
    assert_eq!(ended["transportLost"], false);
    drop(first);
    fixture.configure(json!({}));
    second.write(b"printf '\\nSURVIVING_TAB\\n'\r");
    second.output_contains("SURVIVING_TAB");
    close(&mut second);
    drop(second);
    fixture.wait_quiet();

    // No duplicate completion can arrive after the request ID was released.
    let mut connection = deferred(&fixture, 106);
    exec(&connection, 1, "true");
    success(&mut connection, 1, 0);
    thread::sleep(Duration::from_millis(50));
    let later: Vec<Value> = serde_json::from_str(&poll_json(connection.id).unwrap()).unwrap();
    assert!(!later.iter().any(|event| event["requestId"] == 1
        && matches!(
            event["type"].as_str(),
            Some("execExit" | "execError" | "execData")
        )));
    close(&mut connection);
    drop(connection);
    fixture.wait_quiet();
}

#[test]
fn deferred_terminal_cancel_and_first_host_verification() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let fixture = Fixture::start_control();
    for (index, (stage, kind)) in [
        ("delaySessionMs", "shell"),
        ("delayPTYMs", "shell"),
        ("delayShellMs", "shell"),
        ("delayExecAckMs", "exec"),
    ]
    .iter()
    .enumerate()
    {
        eprintln!("deferred terminal cancellation stage {stage}");
        fixture.configure(json!({}));
        let mut connection = deferred(&fixture, 200 + index as u64);
        fixture.configure(json!({*stage:20000}));
        let mut request = json!({"type":"openTerminal","requestId":1,"kind":kind});
        if *kind == "exec" {
            request["command"] = "sleep 20".into();
        }
        connection.command(request).unwrap();
        fixture.wait_counter("timers", 1);
        close(&mut connection);
        drop(connection);
        fixture.wait_quiet();
    }
    fixture.configure(json!({}));
    let mut options = fixture.options(210, "password", false);
    options["deferTerminal"] = true.into();
    let mut connection = Connection::start(options);
    let unknown = connection.wait(|event| event["type"] == "hostKey");
    assert_eq!(unknown["status"], "unknown");
    connection
        .command(json!({"type":"hostKeyResponse","requestId":unknown["requestId"],"accept":true}))
        .unwrap();
    let known = connection.wait(|event| event["type"] == "hostKey" && event["status"] == "known");
    assert_eq!(known["keyBase64"], fixture.metadata["keyBase64"]);
    assert!(known.get("requestId").is_none());
    connection.auth(fixture.password_response());
    connection.wait(|event| event["state"] == "authenticated");
    close(&mut connection);
    drop(connection);
    fixture.wait_quiet();
}
