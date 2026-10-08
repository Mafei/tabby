package org.tabby.android.prototype

import org.junit.Assert.*
import org.junit.Test

class SessionOperationsTest {
    private fun rejects(action: () -> Unit) {
        try { action(); fail("An invalid operation was accepted") } catch (_: IllegalArgumentException) { }
    }

    @Test fun cancellingExecRetainsItsSlotUntilNativeCompletion() {
        val session = SessionOperations(true)
        rejects { session.reserveExec(1) }
        session.authenticated()
        session.reserveExec(1)
        session.reserveExec(2)
        session.cancelExec(1)
        session.cancelExec(1)
        rejects { session.reserveExec(3) }
        rejects { session.reserveTerminal(3, "exec") }
        session.completeExec(1)
        session.reserveExec(3)
        session.completeExec(2)
        session.completeExec(3)
        session.cancelExec(1) // Completed cancellation is still idempotent.
        rejects { session.cancelExec(4) }
    }

    @Test fun terminalAcquisitionFailureAllowsANewRequestWithoutImplicitReopening() {
        val session = SessionOperations(true)
        session.authenticated()
        session.reserveTerminal(1, "exec")
        rejects { session.reserveExec(2) }
        rejects { session.ready(1, "shell") }
        session.terminalFailed(1)
        assertFalse(session.isReady())
        rejects { session.reserveTerminal(1, "exec") }
        session.reserveTerminal(2, "exec")
        session.ready(2, "exec")
        assertTrue(session.isReady())
        rejects { session.reserveTerminal(3, "shell") }
        session.reserveExec(3)
        session.completeExec(3)
    }

    @Test fun queueRejectionDoesNotPermitRequestIdReuseOrReleaseOtherOperations() {
        val session = SessionOperations(true)
        session.authenticated()
        session.reserveExec(1)
        session.reserveExec(2)
        session.rejected(2)
        rejects { session.reserveExec(2) }
        session.reserveExec(3)
        rejects { session.reserveExec(4) }
        session.completeExec(1)
        session.completeExec(3)
        session.reserveTerminal(4, "shell")
        session.rejected(4)
        rejects { session.reserveTerminal(4, "shell") }
        session.reserveTerminal(5, "shell")
        session.ready(5, "shell")
    }

    @Test fun closingOneTabCannotInvalidateAnotherTransportOrConsumeItsChallenge() {
        val first = SessionOperations(true)
        val second = SessionOperations(true)
        val firstGate = ConnectionGate(1)
        val secondGate = ConnectionGate(1)
        firstGate.register("1", "auth")
        secondGate.register("1", "auth")
        first.authenticated(); second.authenticated()
        first.reserveExec(1); second.reserveExec(1)
        first.close(); firstGate.close()
        rejects { first.reserveExec(2) }
        assertFalse(firstGate.take("1", "auth", 1))
        assertTrue(secondGate.take("1", "auth", 1))
        second.completeExec(1)
        second.reserveTerminal(2, "shell")
        second.ready(2, "shell")
        assertTrue(second.isReady())
    }

    @Test fun cancelledExecOutputAndTerminalOutputShareAckFlowWithoutSequenceGaps() {
        val session = SessionOperations(true)
        val window = OutputWindow(48 * 1024)
        session.authenticated()
        session.reserveExec(1)
        val control = window.reserve(24 * 1024)
        session.cancelExec(1)
        val lateControl = window.reserve(24 * 1024)
        assertFalse(window.canPoll())
        session.completeExec(1)
        // Completion must not erase outstanding output. A discarded chunk is ACKed.
        assertFalse(window.canPoll())
        assertTrue(window.acknowledge(lateControl))
        assertTrue(window.canPoll())
        session.reserveTerminal(2, "exec")
        session.ready(2, "exec")
        val terminal = window.reserve(24 * 1024)
        assertTrue(terminal > lateControl)
        assertTrue(window.acknowledge(control))
        assertTrue(window.acknowledge(terminal))
    }

    @Test fun legacyShellAndUtf8CommandLimitsRemainStrict() {
        val legacy = SessionOperations(false)
        rejects { legacy.authenticated() }
        rejects { legacy.reserveTerminal(1, "shell") }
        legacy.ready()
        assertTrue(legacy.isReady())
        legacy.reserveExec(1)
        legacy.completeExec(1)
        assertEquals("中".repeat(5461), SessionOperations.checkedCommand("中".repeat(5461)))
        rejects { SessionOperations.checkedCommand("中".repeat(5462)) }
        rejects { SessionOperations.checkedCommand("") }
        rejects { SessionOperations.checkedCommand("true\u0000false") }
        rejects { legacy.reserveExec(BridgeNumbers.MAX_SAFE_INTEGER + 1) }
    }

    @Test fun importedKeysAreIndependentAndScopedCleanupZeroesOnlyTheOwner() {
        val vault = PrivateKeyVault()
        val first = "fixture-key-first".toByteArray()
        val second = "fixture-key-second".toByteArray()
        vault.replace("first", first)
        vault.replace("second", second)
        assertEquals(setOf("first", "second"), vault.snapshot())
        assertEquals("fixture-key-first", vault.consumeText("first") { it })
        assertTrue(first.all { it == 0.toByte() })
        assertEquals("fixture-key-second", second.toString(Charsets.UTF_8))
        vault.discard(setOf("first")) // An old Tab's repeated cleanup is harmless.
        assertEquals(setOf("second"), vault.snapshot())
        vault.clear()
        assertTrue(second.all { it == 0.toByte() })
    }

    @Test fun boundedKeyVaultRejectsAndZeroesAnExtraImportWithoutDroppingExistingKeys() {
        val vault = PrivateKeyVault()
        repeat(4) { vault.replace("key-$it", "fixture-$it".toByteArray()) }
        val rejected = "fixture-rejected".toByteArray()
        rejects { vault.replace("extra", rejected) }
        assertTrue(rejected.all { it == 0.toByte() })
        assertEquals(4, vault.snapshot().size)
        val old = "old".toByteArray()
        vault.replace("key-0", old)
        vault.replace("key-0", "new".toByteArray())
        assertTrue(old.all { it == 0.toByte() })
        assertEquals("new", vault.consumeText("key-0") { it })
    }

    @Test fun pickerCancellationRequiresBothTheTabAndRequestIncludingLegacyIsolation() {
        val current = PickerScope("tab-2", "request-2")
        assertNotEquals(current, PickerScope("tab-1", "request-2"))
        assertNotEquals(current, PickerScope("tab-2", "request-1"))
        assertNotEquals(current, PickerScope(null, null))
        assertEquals(current, PickerScope("tab-2", "request-2"))
        rejects { PickerScope("tab-2", null) }
        rejects { PickerScope(null, "request-2") }
        rejects { PickerScope("tab\u0000", "request") }
    }

    @Test fun oldKeyboardRequestsCannotFollowALiveTabSwitchOrLifecycleClear() {
        val lease = KeyboardLease()
        assertTrue(lease.permits(null, lease.capture())) // Legacy direct bridge.
        lease.switch("first", 1)
        val old = lease.capture()
        assertTrue(lease.permits("first", old))
        assertFalse(lease.permits(null, old))
        lease.switch("second", 2)
        assertFalse(lease.permits("first", old))
        assertFalse(lease.permits("second", old))
        assertTrue(lease.permits("second", lease.capture()))
        rejects { lease.switch("first", 1) }
        rejects { lease.switch("first", 2) }
        val beforePause = lease.capture()
        lease.clear()
        assertFalse(lease.permits("second", beforePause))
        lease.switch("first", 3)
        assertFalse(lease.permits("first", old))
        assertTrue(lease.permits("first", lease.capture()))
    }
}
