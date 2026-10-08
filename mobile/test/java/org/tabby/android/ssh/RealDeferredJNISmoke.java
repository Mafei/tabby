package org.tabby.android.ssh;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.function.Predicate;

/** Actual Kotlin NativeSSH -> Linux JNI -> SSH wire -> isolated tmux/PTY. */
public final class RealDeferredJNISmoke {
    private static final NativeSSH NATIVE = NativeSSH.INSTANCE;
    private final JSONObject fixture;
    private int passed;
    private RealDeferredJNISmoke(JSONObject fixture) { this.fixture = fixture; }
    private static JSONObject json(Object... fields) {
        JSONObject result = new JSONObject();
        for (int i = 0; i < fields.length; i += 2) result.put((String) fields[i], fields[i + 1]);
        return result;
    }
    private static void check(boolean value) { if (!value) throw new AssertionError("DEFERRED_JNI_CHECK_FAILED"); }
    private static void sleep() {
        try { Thread.sleep(5); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new AssertionError("DEFERRED_JNI_INTERRUPTED"); }
    }
    private JSONObject control(JSONObject request) {
        long deadline = System.nanoTime() + 5_000_000_000L;
        try (SocketChannel socket = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            socket.configureBlocking(false);
            socket.connect(UnixDomainSocketAddress.of(fixture.getString("controlSocket")));
            while (!socket.finishConnect()) { check(System.nanoTime() < deadline); sleep(); }
            ByteBuffer write = StandardCharsets.UTF_8.encode(request + "\n");
            while (write.hasRemaining()) { check(System.nanoTime() < deadline); socket.write(write); sleep(); }
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            ByteBuffer read = ByteBuffer.allocate(4096);
            while (true) {
                check(System.nanoTime() < deadline && bytes.size() <= 65536);
                int count = socket.read(read);
                check(count >= 0);
                if (count > 0) {
                    bytes.write(read.array(), 0, count); read.clear();
                    String text = bytes.toString(StandardCharsets.UTF_8);
                    int end = text.indexOf('\n');
                    if (end >= 0) {
                        JSONObject result = new JSONObject(text.substring(0, end));
                        check(result.getBoolean("ok"));
                        return result.getJSONObject("result");
                    }
                }
                sleep();
            }
        } catch (java.io.IOException e) { throw new AssertionError("DEFERRED_JNI_CONTROL_FAILED"); }
    }
    private void quiet() {
        long deadline = System.nanoTime() + 5_000_000_000L;
        while (true) {
            JSONObject stats = control(json("type", "stats"));
            if (List.of("clients", "sessions", "ptys", "execs", "timers", "pendingAuth").stream().allMatch(k -> stats.getLong(k) == 0)) return;
            check(System.nanoTime() < deadline); sleep();
        }
    }
    private static void nativeError(String code, Runnable action) {
        try { action.run(); }
        catch (IllegalStateException e) { check(code.equals(e.getMessage())); return; }
        throw new AssertionError("DEFERRED_JNI_EXPECTED_REJECTION");
    }
    private void pass(String label) { passed++; System.out.println("PASS " + label); }
    private static String quote(String value) { return "'" + value.replace("'", "'\"'\"'") + "'"; }

    private final class Connection implements AutoCloseable {
        final long generation;
        final long id;
        final List<JSONObject> pending = new ArrayList<>();
        boolean destroyed;
        Connection(long generation) {
            this.generation = generation;
            id = NATIVE.start(json("host", fixture.getString("host"), "port", fixture.getInt("port"),
                "username", fixture.getString("username"), "authMode", "password", "generation", generation,
                "rows", 24, "cols", 80, "deferTerminal", true).toString());
            check(id > 0);
        }
        void send(JSONObject value) { NATIVE.command(id, value.put("generation", generation).toString()); }
        JSONObject event(Predicate<JSONObject> predicate) {
            long deadline = System.nanoTime() + 20_000_000_000L;
            while (System.nanoTime() < deadline) {
                for (int i = 0; i < pending.size(); i++) if (predicate.test(pending.get(i))) return pending.remove(i);
                JSONArray batch = new JSONArray(NATIVE.poll(id));
                for (int i = 0; i < batch.length(); i++) {
                    JSONObject value = batch.getJSONObject(i);
                    check(value.getLong("connectionId") == id && value.getLong("generation") == generation);
                    pending.add(value);
                }
                sleep();
            }
            throw new AssertionError("DEFERRED_JNI_EVENT_TIMEOUT");
        }
        void authenticated() {
            JSONObject host = event(e -> "hostKey".equals(e.optString("type")));
            check(fixture.getString("keyBase64").equals(host.getString("keyBase64")));
            send(json("type", "hostKeyResponse", "requestId", host.getLong("requestId"), "accept", true));
            JSONObject auth = event(e -> "auth".equals(e.optString("type")));
            send(json("type", "authResponse", "requestId", auth.getLong("requestId"), "password", fixture.getString("password")));
            JSONObject ready = event(e -> "state".equals(e.optString("type")) && List.of("ready", "authenticated", "error", "closed").contains(e.optString("state")));
            check("authenticated".equals(ready.getString("state")) && ready.getBoolean("deferredTerminal"));
        }
        JSONObject complete(long request, ByteArrayOutputStream stdout, ByteArrayOutputStream stderr) {
            long deadline = System.nanoTime() + 15_000_000_000L;
            while (System.nanoTime() < deadline) {
                JSONObject value = event(e -> e.optLong("requestId", -1) == request && List.of("execData", "execExit", "execError").contains(e.optString("type")));
                if (!"execData".equals(value.getString("type"))) return value;
                byte[] chunk = Base64.getDecoder().decode(value.getString("data"));
                check(chunk.length <= 1024 * 1024 - stdout.size() - stderr.size());
                (value.getBoolean("extended") ? stderr : stdout).write(chunk, 0, chunk.length);
            }
            throw new AssertionError("DEFERRED_JNI_EXEC_TIMEOUT");
        }
        String exec(long request, String command) {
            send(json("type", "exec", "requestId", request, "command", command));
            ByteArrayOutputStream stdout = new ByteArrayOutputStream(), stderr = new ByteArrayOutputStream();
            JSONObject result = complete(request, stdout, stderr);
            check("execExit".equals(result.getString("type")) && result.getBoolean("complete") && result.getLong("exitStatus") == 0 && stderr.size() == 0);
            return stdout.toString(StandardCharsets.UTF_8);
        }
        void open(long request, String command) {
            JSONObject options = json("type", "openTerminal", "requestId", request, "kind", command == null ? "shell" : "exec", "rows", 24, "cols", 80);
            if (command != null) options.put("command", command);
            send(options);
            JSONObject ready = event(e -> "state".equals(e.optString("type")) && List.of("ready", "error", "closed").contains(e.optString("state")));
            check("ready".equals(ready.getString("state")) && ready.getLong("requestId") == request && (command == null ? "shell" : "exec").equals(ready.getString("terminalKind")));
        }
        void write(String text) { send(json("type", "write", "data", Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8)))); }
        void output(String needle) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            long deadline = System.nanoTime() + 15_000_000_000L;
            while (!bytes.toString(StandardCharsets.UTF_8).contains(needle)) {
                check(System.nanoTime() < deadline);
                JSONObject value = event(e -> "data".equals(e.optString("type")));
                byte[] data = Base64.getDecoder().decode(value.getString("data"));
                check(data.length <= 1024 * 1024 - bytes.size()); bytes.write(data, 0, data.length);
            }
        }
        @Override public void close() {
            if (!destroyed) { NATIVE.destroy(id); destroyed = true; nativeError("unknown_connection", () -> NATIVE.poll(id)); }
        }
    }

    private void run() {
        control(json("type", "configure", "delayExecAckMs", 150));
        try (Connection c = new Connection(701)) {
            c.authenticated();
            check(control(json("type", "stats")).getLong("ptys") == 0);
            c.send(json("type", "exec", "requestId", 1, "command", "if test -t 0; then exit 0; fi; printf 'JNI_中文🙂_OUT'; printf 'JNI_中文🙂_ERR' >&2; exit 7"));
            ByteArrayOutputStream out = new ByteArrayOutputStream(), err = new ByteArrayOutputStream();
            JSONObject result = c.complete(1, out, err);
            check("execExit".equals(result.getString("type")) && result.getBoolean("complete") && result.getLong("exitStatus") == 7);
            check("JNI_中文🙂_OUT".equals(out.toString(StandardCharsets.UTF_8)) && "JNI_中文🙂_ERR".equals(err.toString(StandardCharsets.UTF_8)));
            check(control(json("type", "stats")).getLong("execEarlyBytes") > 0);
            check("AFTER_EXEC".equals(c.exec(2, "printf AFTER_EXEC")));
        }
        quiet(); control(json("type", "configure", "delayExecAckMs", 0));
        pass("deferred no-PTY exec preserves early Unicode stdout/stderr and exact completion");

        try (Connection first = new Connection(801); Connection other = new Connection(802)) {
            first.authenticated(); other.authenticated(); other.open(1, null);
            first.send(json("type", "exec", "requestId", 1, "command", "sleep 30"));
            first.event(e -> "execStarted".equals(e.optString("type")) && e.optLong("requestId") == 1);
            first.send(json("type", "execCancel", "requestId", 1));
            JSONObject cancelled = first.complete(1, new ByteArrayOutputStream(), new ByteArrayOutputStream());
            check("execError".equals(cancelled.getString("type")) && "exec_cancelled".equals(cancelled.getString("code")) && !cancelled.getBoolean("complete"));
            long requests = control(json("type", "stats")).getLong("execRequests");
            nativeError("stale_generation", () -> NATIVE.command(first.id, json("type", "exec", "generation", 800, "requestId", 2, "command", "printf OLD_GENERATION").toString()));
            check(control(json("type", "stats")).getLong("execRequests") == requests);
            check("AFTER_CANCEL".equals(first.exec(2, "printf AFTER_CANCEL")));
            first.close(); other.write("printf '%s%s\\n' '__JNI_OTHER_' 'ALIVE__'\n"); other.output("__JNI_OTHER_ALIVE__");
        }
        quiet(); pass("exec cancellation and old generations preserve another actual terminal");

        String base = quote(fixture.getString("tmuxPath")) + " -S " + quote(fixture.getString("tmuxSocket")) + " -f /dev/null";
        String identity, session;
        String query = base + " list-sessions -F '#{pid}|#{start_time}|#{session_id}|#{session_created}'";
        try (Connection first = new Connection(901)) {
            first.authenticated(); first.exec(1, base + " new-session -d -s jni_keep -x 80 -y 24 'exec /bin/sh -i'");
            identity = first.exec(2, query).trim(); String[] fields = identity.split("\\|", -1);
            check(fields.length == 4 && fields[0].matches("[0-9]+") && fields[1].matches("[0-9]+") && fields[2].matches("\\$[0-9]+") && fields[3].matches("[0-9]+"));
            session = fields[2]; first.open(3, base + " attach-session -t " + quote(session));
            first.write("printf '%s%s\\n' '__JNI_TMUX_' '中文🙂__'\n"); first.output("__JNI_TMUX_中文🙂__");
            check(first.exec(4, base + " capture-pane -p -t " + quote(session + ":")).contains("__JNI_TMUX_中文🙂__"));
            control(json("type", "dropConnections"));
            JSONObject ended = first.event(e -> "state".equals(e.optString("type")) && List.of("error", "closed").contains(e.optString("state")));
            check("transport_lost".equals(ended.getString("code")) && ended.getBoolean("transportLost"));
        }
        quiet();
        try (Connection restored = new Connection(902)) {
            restored.authenticated(); check(identity.equals(restored.exec(1, query).trim()));
            check(restored.exec(2, base + " capture-pane -p -t " + quote(session + ":")).contains("__JNI_TMUX_中文🙂__"));
            restored.open(3, base + " attach-session -t " + quote(session));
            restored.write("printf '%s%s\\n' '__JNI_TMUX_' 'RECOVERED__'\n"); restored.output("__JNI_TMUX_RECOVERED__");
        }
        quiet(); pass("real TCP loss preserves tmux identity and pane output through Kotlin JNI reconnect");
        check(passed == 3);
        System.out.println(json("suite", "real-jvm-jni-deferred-tmux", "passed", passed, "failed", 0));
    }

    public static void main(String[] args) {
        try {
            Path metadata = Path.of(System.getenv("SSH_FIXTURE_METADATA"));
            check(Files.size(metadata) > 0 && Files.size(metadata) <= 131072);
            JSONObject fixture = new JSONObject(Files.readString(metadata));
            check("127.0.0.1".equals(fixture.getString("host")) && "tabby-fixture".equals(fixture.getString("username")) && "control-tmux".equals(fixture.getString("profile")));
            new RealDeferredJNISmoke(fixture).run();
        } catch (Throwable ignored) {
            // JNI errors/JSON may contain generated secrets. Only a fixed code.
            System.err.println("DEFERRED_JNI_ACCEPTANCE_FAILED"); System.exit(1);
        }
    }
}
