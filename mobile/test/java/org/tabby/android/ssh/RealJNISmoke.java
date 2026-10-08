package org.tabby.android.ssh;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Predicate;

/** Real JVM -> JNI -> russh -> SSH wire -> Linux PTY acceptance smoke. */
public final class RealJNISmoke {
    private static final NativeSSH NATIVE = NativeSSH.INSTANCE;
    private final JSONObject fixture;
    private int passed;

    private RealJNISmoke(JSONObject fixture) { this.fixture = fixture; }

    private static JSONObject json(Object... fields) {
        JSONObject result = new JSONObject();
        for (int index = 0; index < fields.length; index += 2) {
            result.put((String) fields[index], fields[index + 1]);
        }
        return result;
    }

    private static void check(boolean value, String message) {
        if (!value) { throw new AssertionError(message); }
    }

    private static void until(BooleanSupplier predicate, String stage) {
        long deadline = System.nanoTime() + Duration.ofSeconds(8).toNanos();
        while (!predicate.getAsBoolean()) {
            check(System.nanoTime() < deadline, "Deadline exceeded: " + stage);
            sleep(10);
        }
    }

    private static void sleep(long milliseconds) {
        try { Thread.sleep(milliseconds); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AssertionError("Test interrupted"); }
    }

    private static void nativeError(String code, Runnable operation) {
        try { operation.run(); }
        catch (IllegalStateException error) {
            check(code.equals(error.getMessage()), "Unexpected native failure code");
            return;
        }
        throw new AssertionError("Expected native rejection: " + code);
    }

    private JSONObject control(JSONObject request) {
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        try (SocketChannel socket = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            socket.configureBlocking(false);
            socket.connect(UnixDomainSocketAddress.of(fixture.getString("controlSocket")));
            while (!socket.finishConnect()) {
                check(System.nanoTime() < deadline, "Fixture control connection timed out");
                sleep(5);
            }
            ByteBuffer write = StandardCharsets.UTF_8.encode(request.toString() + "\n");
            while (write.hasRemaining()) {
                socket.write(write);
                check(System.nanoTime() < deadline, "Fixture control write timed out");
                sleep(1);
            }
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            ByteBuffer read = ByteBuffer.allocate(4096);
            while (true) {
                int count = socket.read(read);
                if (count < 0) { throw new AssertionError("Fixture control closed early"); }
                if (count > 0) {
                    bytes.write(read.array(), 0, count);
                    read.clear();
                    String response = bytes.toString(StandardCharsets.UTF_8);
                    int end = response.indexOf('\n');
                    if (end >= 0) {
                        JSONObject parsed = new JSONObject(response.substring(0, end));
                        check(parsed.getBoolean("ok"), "Fixture control rejected request");
                        return parsed.getJSONObject("result");
                    }
                }
                check(bytes.size() <= 65536 && System.nanoTime() < deadline, "Fixture control read timed out");
                sleep(5);
            }
        } catch (java.io.IOException error) {
            throw new AssertionError("Fixture control I/O failed");
        }
    }

    private JSONObject stats() { return control(json("type", "stats")); }

    private void quiet() {
        until(() -> {
            JSONObject stats = stats();
            return List.of("clients", "sessions", "ptys", "timers", "pendingAuth").stream().allMatch(key -> stats.getLong(key) == 0);
        }, "all fixture resources released");
    }

    private JSONObject options(long generation, String mode, boolean pinned) {
        JSONObject options = json("host", fixture.getString("host"), "port", fixture.getInt("port"),
            "username", fixture.getString("username"), "generation", generation, "authMode", mode,
            "cols", 80, "rows", 24, "term", "xterm-256color");
        if (pinned) { options.put("expectedHostKey", fixture.getString("keyBase64")); }
        return options;
    }

    private void pass(String label) {
        passed++;
        // Labels contain no credential, raw event, terminal output or endpoint.
        System.out.println("PASS " + label);
    }

    private final class Connection implements AutoCloseable {
        final long id;
        final long generation;
        final List<JSONObject> pending = new ArrayList<>();
        boolean destroyed;

        Connection(long generation, String mode, boolean pinned) {
            this.generation = generation;
            this.id = NATIVE.start(options(generation, mode, pinned).toString());
            check(id > 0, "Native start did not return a connection id");
        }

        void command(JSONObject command) {
            command.put("generation", generation);
            NATIVE.command(id, command.toString());
        }

        JSONObject event(Predicate<JSONObject> predicate) {
            long deadline = System.nanoTime() + Duration.ofSeconds(20).toNanos();
            while (true) {
                for (int index = 0; index < pending.size(); index++) {
                    if (predicate.test(pending.get(index))) { return pending.remove(index); }
                }
                JSONArray batch = new JSONArray(NATIVE.poll(id));
                for (int index = 0; index < batch.length(); index++) {
                    JSONObject event = batch.getJSONObject(index);
                    check(event.getLong("connectionId") == id, "JNI event connection identity mismatch");
                    check(event.getLong("generation") == generation, "JNI event generation mismatch");
                    pending.add(event);
                }
                check(System.nanoTime() < deadline, "Native event deadline exceeded");
                sleep(5);
            }
        }

        JSONObject auth() { return event(e -> "auth".equals(e.getString("type"))); }

        void password() {
            JSONObject prompt = auth();
            command(json("type", "authResponse", "requestId", prompt.getLong("requestId"), "password", fixture.getString("password")));
        }

        void ready() {
            JSONObject event = event(e -> "state".equals(e.getString("type"))
                && List.of("ready", "error", "closed").contains(e.optString("state")));
            check("ready".equals(event.getString("state")), "Native transport did not become ready");
        }

        void ended(String code) {
            JSONObject event = event(e -> "state".equals(e.getString("type")) && List.of("error", "closed").contains(e.optString("state")));
            check(code.equals(event.getString("code")), "Unexpected native terminal code");
        }

        void write(byte[] bytes) { command(json("type", "write", "data", Base64.getEncoder().encodeToString(bytes))); }
        void write(String text) { write(text.getBytes(StandardCharsets.UTF_8)); }

        void output(String needle) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
            while (!bytes.toString(StandardCharsets.UTF_8).contains(needle)) {
                JSONObject event = event(e -> "data".equals(e.getString("type"))
                    || ("state".equals(e.getString("type")) && "error".equals(e.optString("state"))));
                check("data".equals(event.getString("type")), "Native terminal closed while reading");
                byte[] data = Base64.getDecoder().decode(event.getString("data"));
                bytes.write(data, 0, data.length);
                check(bytes.size() <= 2 * 1024 * 1024 && System.nanoTime() < deadline, "Terminal output deadline exceeded");
            }
        }

        @Override public void close() {
            if (destroyed) { return; }
            NATIVE.destroy(id);
            destroyed = true;
            nativeError("unknown_connection", () -> NATIVE.poll(id));
        }
    }

    private void run() throws Exception {
        try (Connection c = new Connection(1, "password", false)) {
            JSONObject key = c.event(e -> "hostKey".equals(e.getString("type")));
            check("unknown".equals(key.getString("status")), "First host key was not challenged");
            check(fixture.getString("fingerprint").equals(key.getString("fingerprint")), "Host-key fingerprint mismatch");
            check(stats().getLong("authenticated") == 0, "Authentication occurred before host approval");
            c.command(json("type", "hostKeyResponse", "requestId", key.getLong("requestId"), "accept", false));
            c.ended("host_key_rejected");
        }
        quiet();
        pass("first-host decision blocks authentication");

        try (Connection c = new Connection(2, "password", false)) {
            JSONObject key = c.event(e -> "hostKey".equals(e.getString("type")));
            c.command(json("type", "hostKeyResponse", "requestId", key.getLong("requestId"), "accept", true));
            c.password();
            c.ready();
            nativeError("stale_generation", () -> NATIVE.command(c.id, json("type", "write", "generation", 1, "data", "YQ==").toString()));
            nativeError("invalid_dimensions", () -> c.command(json("type", "resize", "cols", 0, "rows", 0)));
            c.write("stty -echo\r");
            c.write("printf '%s\\n' 'JNI_中文🙂_OK'\r");
            c.output("JNI_中文🙂_OK");
            c.command(json("type", "resize", "cols", 99, "rows", 31));
            until(() -> stats().getLong("resizeRequests") >= 1, "PTY window-change delivered");
            c.write("stty size\r");
            c.output("31 99");

            byte[] input = "中文\u0003\u001b\t\u001b[A\u001b[B\u001b[C\u001b[D".getBytes(StandardCharsets.UTF_8);
            String program = "import sys,os,tty,termios\nfd=sys.stdin.fileno()\nold=termios.tcgetattr(fd)\ntty.setraw(fd)\n"
                + "print(\"JNI_RAW\"+\"_READY\",flush=True)\ndata=b\"\"\n"
                + "while len(data)<" + input.length + ": data+=os.read(fd," + input.length + "-len(data))\n"
                + "termios.tcsetattr(fd,termios.TCSANOW,old)\nprint(\"JNI_HEX\"+\"_\"+data.hex(),flush=True)";
            c.write("python3 -c '" + program.replace("'", "'\"'\"'") + "'\r");
            c.output("JNI_RAW_READY");
            c.write(input);
            c.output("JNI_HEX_" + java.util.HexFormat.of().formatHex(input));
        }
        quiet();
        pass("password-auth real PTY UTF-8 control bytes resize and generation checks");

        try (Connection c = new Connection(3, "password", false)) {
            JSONObject key = c.event(e -> "hostKey".equals(e.getString("type")));
            c.command(json("type", "cancel"));
            c.ended("cancelled");
            nativeError("connection_closed", () -> c.command(json("type", "hostKeyResponse", "requestId", key.getLong("requestId"), "accept", true)));
        }
        quiet();
        try (Connection c = new Connection(4, "password", true)) {
            JSONObject auth = c.auth();
            c.command(json("type", "cancel"));
            c.ended("cancelled");
            nativeError("connection_closed", () -> c.command(json("type", "authResponse", "requestId", auth.getLong("requestId"), "password", "stale-test-response")));
        }
        quiet();
        try (Connection c = new Connection(5, "password", true)) { c.password(); c.ready(); }
        quiet();
        pass("host and auth cancellation reject old responses and allow reconnect");

        for (int index = 0; index < 2; index++) {
            try (Connection c = new Connection(10 + index, "privateKey", true)) {
                JSONObject auth = c.auth();
                String field = index == 0 ? "privateKeyFile" : "encryptedPrivateKeyFile";
                String key = Files.readString(Path.of(fixture.getString(field)), StandardCharsets.UTF_8);
                JSONObject response = json("type", "authResponse", "requestId", auth.getLong("requestId"), "privateKey", key);
                if (index == 1) { response.put("passphrase", fixture.getString("privateKeyPassphrase")); }
                c.command(response);
                c.ready();
                c.write("printf '%s%s\\n' 'JNI_KEY_' 'OK'\r");
                c.output("JNI_KEY_OK");
            }
            quiet();
        }
        pass("plain and encrypted generated private-key authentication");

        byte[] generatedDeviceKey = NATIVE.generateEd25519();
        Path enrolled = Path.of(fixture.getString("privateKeyFile")).getParent().resolve(".ssh/authorized_keys");
        try {
            JSONObject description = new JSONObject(NATIVE.describeDeviceKey(generatedDeviceKey));
            check(description.length() == 3 && "ssh-ed25519".equals(description.getString("algorithm")) && !description.toString().contains("PRIVATE KEY"), "Device key description must be public only");
            Files.createDirectories(enrolled.getParent());
            Files.writeString(enrolled, description.getString("publicKey") + "\n", StandardCharsets.UTF_8);
            try (Connection c = new Connection(15, "privateKey", true)) {
                JSONObject auth = c.auth();
                c.command(json("type", "authResponse", "requestId", auth.getLong("requestId"), "privateKey", new String(generatedDeviceKey, StandardCharsets.UTF_8)));
                c.ready();
            }
            quiet();
            control(json("type", "configure", "publickeyPartialSuccess", true));
            try (Connection c = new Connection(16, "privateKey", true)) {
                JSONObject auth = c.auth();
                c.command(json("type", "authResponse", "requestId", auth.getLong("requestId"), "privateKey", new String(generatedDeviceKey, StandardCharsets.UTF_8)));
                c.ended("auth_partial_success");
            }
            quiet();
            control(json("type", "configure", "publickeyPartialSuccess", false));
        } finally { java.util.Arrays.fill(generatedDeviceKey, (byte) 0); Files.deleteIfExists(enrolled); }
        pass("actual JNI Ed25519 generation authenticates and distinguishes additional-auth requirements");

        control(json("type", "configure", "authMode", "keyboard-interactive"));
        long answers = stats().getLong("authAnswers");
        try (Connection c = new Connection(20, "keyboardInteractive", true)) {
            JSONObject auth = c.auth();
            check(!auth.getJSONArray("prompts").getJSONObject(0).getBoolean("echo"), "Authentication prompt must hide its answer");
            c.command(json("type", "cancel"));
            c.ended("cancelled");
            nativeError("connection_closed", () -> c.command(json("type", "authResponse", "requestId", auth.getLong("requestId"), "responses", new JSONArray().put("obsolete-test-answer"))));
        }
        quiet();
        try (Connection c = new Connection(21, "keyboardInteractive", true)) {
            JSONObject auth = c.auth();
            c.command(json("type", "authResponse", "requestId", auth.getLong("requestId"), "responses", new JSONArray().put(fixture.getString("password"))));
            c.ready();
        }
        quiet();
        check(stats().getLong("authAnswers") == answers + 1, "Canceled interactive prompt received an answer");
        control(json("type", "configure", "authMode", "all"));
        pass("interactive auth cancellation and fresh reconnect");

        control(json("type", "configure", "delayPTYMs", 1500));
        long shellStarts = stats().getLong("shellStarts");
        try (Connection c = new Connection(30, "password", true)) {
            c.password();
            until(() -> stats().getLong("timers") >= 1, "delayed PTY pending");
            c.command(json("type", "cancel"));
            c.ended("cancelled");
        }
        quiet();
        sleep(1550);
        check(stats().getLong("shellStarts") == shellStarts, "Late canceled PTY started a shell");
        control(json("type", "configure", "delayPTYMs", 0));
        pass("delayed PTY cancellation prevents late shell and releases resources");

        try (Connection c = new Connection(40, "password", true)) {
            c.password();
            c.ready();
            control(json("type", "dropConnections"));
            JSONObject event = c.event(e -> "state".equals(e.getString("type")) && List.of("error", "closed").contains(e.optString("state")));
            check(List.of("transport_lost", "remote_closed").contains(event.getString("code")), "Transport loss was not propagated");
        }
        quiet();
        pass("actual TCP loss releases transport and PTY");

        long authenticated = stats().getLong("authenticated");
        JSONObject replacement = control(json("type", "rotateHostKey"));
        check(!fixture.getString("fingerprint").equals(replacement.getString("fingerprint")), "Fixture did not replace host key");
        try (Connection c = new Connection(50, "password", true)) {
            c.ended("host_key_changed");
            check(c.pending.stream().noneMatch(e -> "auth".equals(e.getString("type"))), "Changed host key requested credentials");
        }
        quiet();
        check(stats().getLong("authenticated") == authenticated, "Changed host key authenticated");
        pass("same-endpoint changed host key fails before authentication");

        System.out.println(json("suite", "real-jvm-jni-ssh", "passed", passed, "failed", 0).toString());
    }

    public static void main(String[] args) {
        try {
            String metadata = System.getenv("SSH_FIXTURE_METADATA");
            check(metadata != null && !metadata.isEmpty(), "Private fixture metadata path is required");
            new RealJNISmoke(new JSONObject(Files.readString(Path.of(metadata), StandardCharsets.UTF_8))).run();
        } catch (Throwable error) {
            // Intentionally omit event JSON, terminal output and upstream text.
            String detail = error instanceof AssertionError ? ": " + error.getMessage() : "";
            System.err.println("Real JVM/JNI SSH smoke failed: " + error.getClass().getSimpleName() + detail);
            System.exit(1);
        }
    }
}
