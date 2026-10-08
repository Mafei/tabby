# Real JVM/JNI SSH smoke

This is a Linux cloud test of the **actual** Android
`mobile/android/app/src/main/java/org/tabby/android/ssh/NativeSSH.kt` object.
The runner compiles that source with Kotlin 2.2.20, compiles
`org/tabby/android/ssh/RealJNISmoke.java`, and uses `NativeSSH.INSTANCE` to call
the same instance JNI methods as the Android application. There is no Java
replacement for `NativeSSH`, no mock native library, and no SSH gateway.

Build the real native library first (the runner does not acquire a Cargo lock
or compile Rust):

```sh
cargo build --locked --features jni --manifest-path mobile/android-ssh/Cargo.toml
JAVA_HOME=/path/to/jdk21 node mobile/scripts/test-fixture-jni.mjs
```

Run from the repository root. Requirements are Linux, JDK 21 (`java` and
`javac`), Node, curl, Python, the normal repository `ssh2` test dependency,
and the built `mobile/android-ssh/target/debug/libtabby_ssh.so`. Override the
library location with `TABBY_JNI_LIBRARY`. Its directory must contain the
normal `libtabby_ssh.so` name, as the application's Kotlin code calls
`System.loadLibrary("tabby_ssh")`.

The runner fetches public Kotlin compiler runtime jars and org.json from
Maven Central using TLS, verifies their pinned SHA256 hashes, and caches them
under the system temporary directory. `MOBILE_JAVA_CACHE` can point to a
preloaded jar cache. No Android SDK, SDK license acceptance, Android signing
credential, Android API or emulator is used.

The runtime enables `-Xcheck:jni` and exercises eight sequential groups:

1. First-contact host-key decision blocks authentication.
2. Password authentication, actual PTY UTF-8 and control-key bytes, window
   resize checked with real `stty size`, stale generation and invalid sizes.
3. Cancel host/auth prompts, reject stale responses, and reconnect.
4. Plain and passphrase-encrypted generated OpenSSH private keys.
5. Cancel keyboard-interactive and answer only the new connection's prompt.
6. Cancel a delayed PTY request; prevent a late shell and release resources.
7. Actual TCP loss closes transport and PTY.
8. Change the host key on the same endpoint; reject before authentication.

Each connection is explicitly destroyed. `poll` must then report
`unknown_connection`; fixture transport, session, PTY, timer and pending-auth
counts must return to zero. Generated fixture credentials are read from a
private `0600` file via an environment **path**, never command arguments or
test output. The runner closes the fixture and deletes compiled test classes
on success, failure or cancellation.

Passing this suite verifies JVM/JNI ABI and the direct native SSH/PTY path.
It does **not** establish Android API behavior, APK installation, WebView
input, a particular system Chinese IME, touch selection, clipboard UI,
soft-keyboard resizing or physical-device acceptance.
