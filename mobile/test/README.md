# Isolated SSH fixture

This fixture uses `ssh2` for a real SSH server and Python's system PTY support
to run `/bin/sh`. It listens only on `127.0.0.1` at a randomly allocated port.
No production host, user credential, SSH agent or user home directory is used.

From the repository root, after installing the normal project dependencies:

```sh
node --test mobile/test/ssh-fixture.test.mjs
node mobile/scripts/test-fixture.mjs --metadata /tmp/tabby-fixture-new.json
node mobile/scripts/test-fixture-native.mjs
```

The launcher prints only its endpoint, public host-key fingerprint, control
socket and metadata path. The metadata file and generated key files have mode
`0600` inside a mode `0700` temporary directory. **Metadata contains generated
test credentials. Read it into memory; do not print it or upload it as a test
artifact.** Send SIGTERM to the launcher to close connections, stop the shell
processes and remove the temporary files.

The metadata schema is:

```ts
{
  host: '127.0.0.1', port: number, username: string, password: string,
  privateKeyFile: string, encryptedPrivateKeyFile: string,
  privateKeyPassphrase: string,
  fingerprint: string, keyBase64: string, controlSocket: string
}
```

`privateKeyPassphrase` applies to `encryptedPrivateKeyFile`; `privateKeyFile`
is an unencrypted, generated test key. `keyBase64` is the public SSH host-key
blob, and `fingerprint` is its OpenSSH-style SHA256 fingerprint.

The Unix control socket accepts newline-terminated JSON commands and responds
with `{ok: true, result}` or a generic failure. `controlFixture(metadata,
command)` from `mobile/scripts/test-fixture.mjs` is the Node helper.

| Command | Behavior |
| --- | --- |
| `{type: 'stats'}` | Reports live transports, sessions, auth prompts, PTYs, timers and nonsecret counters. |
| `{type: 'configure', delayAuthMs: 1000}` | Delays authentication processing. |
| `{type: 'configure', delaySessionMs: 1000}` | Delays session channel acceptance. |
| `{type: 'configure', delayPTYMs: 1000}` | Delays PTY request response. |
| `{type: 'configure', delayShellMs: 1000}` | Delays shell request response. |
| `{type: 'configure', rejectPTY: true}` | Rejects the PTY request. |
| `{type: 'configure', rejectShell: true}` | Rejects the shell request. |
| `{type: 'configure', authMode: 'keyboard-interactive'}` | Restricts advertised auth to the chosen method. Values: `all`, `password`, `publickey`, `keyboard-interactive`. |
| `{type: 'dropConnections'}` | Abruptly destroys active network transports. |
| `{type: 'rotateHostKey'}` | Drops transports and changes the host key while retaining the same port and generated credentials. Updates private metadata. |

Configuration delays range from zero to 60 seconds. Use zero or `false` to
reset a behavior. Session/PTY/shell response timers are canceled when their
transport closes, so cancellation checks do not leave late shell processes.

The fixture's Node self-tests verify the server itself, UTF-8/control bytes,
real `stty size`, auth decisions, cancellation, rejection, host-key rotation
and resource cleanup. Native-core integration tests must separately drive the
actual application transport against this service. Neither this fixture nor
synthetic browser composition events verify a particular Android device's
IME, touch selection, clipboard UI or keyboard layout behavior.

`test-fixture-native.mjs` starts a fixture, runs `cargo test --locked --features
jni --manifest-path mobile/android-ssh/Cargo.toml --test real_ssh` with
`SSH_FIXTURE_METADATA` set to its private metadata path, and always closes the
fixture afterward. Put Cargo on PATH, or set `CARGO` to the executable path.
The runner also terminates its owned Cargo process group when canceled.
