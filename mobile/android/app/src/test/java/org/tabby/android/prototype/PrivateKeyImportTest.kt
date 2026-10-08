package org.tabby.android.prototype

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Runs the production coordinator/executors; provider I/O is an explicit test adapter. */
class PrivateKeyImportTest {
    private fun await(latch: CountDownLatch) = assertTrue("The import did not complete within the test bound", latch.await(2, TimeUnit.SECONDS))
    private fun uninterruptible(latch: CountDownLatch) {
        while (true) { try { latch.await(); return } catch (_: InterruptedException) { } }
    }

    @Test fun callbackBeforeResumeWaitsWithoutReadingAndZeroesTheTransientBuffer() {
        val foreground = AtomicBoolean(false)
        val reads = AtomicInteger()
        val callerThread = Thread.currentThread().id
        val readerThread = AtomicReference<Long>()
        val finished = CountDownLatch(1)
        val material = byteArrayOf(1, 2, 3)
        val vault = PrivateKeyVault()
        val importer = PrivateKeyImport<String>(
            { foreground.get() }, { it() },
            { _, _ -> readerThread.set(Thread.currentThread().id); reads.incrementAndGet(); PrivateKeyImport.Material(material, "literal-key-label") },
            { request, value -> vault.replace(request, value.bytes.copyOf()) },
            { _, _ -> fail("A foreground import was rejected") }, { finished.countDown() },
        )
        try {
            assertTrue(importer.begin("selected"))
            assertEquals(0, reads.get())
            assertTrue(vault.snapshot().isEmpty())
            foreground.set(true)
            importer.resume()
            await(finished)
            assertEquals(1, reads.get())
            assertNotEquals(callerThread, readerThread.get())
            assertTrue(material.all { it == 0.toByte() })
            assertEquals(setOf("selected"), vault.snapshot())
        } finally { importer.close(); vault.clear() }
    }

    @Test fun cancellationRejectsOnceAndLateProviderBytesCannotReplaceTheNextImport() {
        val entered = CountDownLatch(1)
        val returnOld = CountDownLatch(1)
        val cancelled = CountDownLatch(1)
        val failed = CountDownLatch(1)
        val oldFinished = CountDownLatch(1)
        val newFinished = CountDownLatch(1)
        val failures = AtomicInteger()
        val oldBytes = byteArrayOf(4, 5, 6)
        val delivered = AtomicReference<String>()
        val importer = PrivateKeyImport<String>(
            { true }, { it() }, { request, ticket ->
                if (request == "old") {
                    ticket.onCancel { cancelled.countDown() }
                    entered.countDown(); uninterruptible(returnOld)
                    PrivateKeyImport.Material(oldBytes, "old-label")
                } else PrivateKeyImport.Material(byteArrayOf(7), "current-label")
            }, { request, _ -> delivered.set(request) },
            { _, code -> assertEquals("KEY_IMPORT_CANCELLED", code); failures.incrementAndGet(); failed.countDown() },
            { request -> if (request == "old") oldFinished.countDown() else newFinished.countDown() },
        )
        try {
            assertTrue(importer.begin("old")); await(entered)
            importer.cancel(); importer.cancel()
            await(failed); await(cancelled)
            assertFalse(importer.begin("premature"))
            assertNull(delivered.get())
            returnOld.countDown(); await(oldFinished)
            assertTrue(oldBytes.all { it == 0.toByte() })
            assertEquals(1, failures.get())
            assertTrue(importer.begin("current")); await(newFinished)
            assertEquals("current", delivered.get())
        } finally { returnOld.countDown(); importer.close() }
    }

    @Test fun cancellationBetweenReadAndMainThreadDeliveryZeroesMaterial() {
        val actions = LinkedBlockingQueue<() -> Unit>()
        val finished = CountDownLatch(1)
        val material = byteArrayOf(8, 9)
        val successes = AtomicInteger()
        val failures = AtomicInteger()
        val importer = PrivateKeyImport<String>(
            { true }, { actions.add(it) }, { _, _ -> PrivateKeyImport.Material(material, "label") },
            { _, _ -> successes.incrementAndGet() }, { _, _ -> failures.incrementAndGet() }, { finished.countDown() },
        )
        try {
            assertTrue(importer.begin("old"))
            val delivery = actions.poll(2, TimeUnit.SECONDS) ?: error("No delivery was scheduled")
            importer.cancel()
            delivery()
            while (finished.count > 0 || failures.get() == 0) {
                (actions.poll(2, TimeUnit.SECONDS) ?: error("Cancellation did not settle"))()
            }
            assertEquals(0, successes.get())
            assertEquals(1, failures.get())
            assertTrue(material.all { it == 0.toByte() })
        } finally { importer.close() }
    }

    @Test fun aDeferredImportUsesOneAbsoluteDeadlineWithoutReadingInBackground() {
        val finished = CountDownLatch(1)
        val code = AtomicReference<String>()
        val reads = AtomicInteger()
        val importer = PrivateKeyImport<String>(
            { false }, { it() }, { _, _ -> reads.incrementAndGet(); PrivateKeyImport.Material(byteArrayOf(1), "label") },
            { _, _ -> fail("Background import delivered a key") }, { _, reason -> code.set(reason) },
            { finished.countDown() }, timeoutMillis = 25,
        )
        try {
            assertTrue(importer.begin("selected")); await(finished)
            assertEquals("KEY_IMPORT_TIMEOUT", code.get())
            assertEquals(0, reads.get())
            assertFalse(importer.hasFlight())
        } finally { importer.close() }
    }

    @Test fun losingForegroundBeforeDeliveryRejectsAndZeroesTheAcquiredBytes() {
        val foreground = AtomicBoolean(true)
        val actions = LinkedBlockingQueue<() -> Unit>()
        val material = byteArrayOf(10, 11)
        val code = AtomicReference<String>()
        val finished = CountDownLatch(1)
        val importer = PrivateKeyImport<String>(
            { foreground.get() }, { actions.add(it) }, { _, _ -> PrivateKeyImport.Material(material, "label") },
            { _, _ -> fail("A background callback stored a key") }, { _, reason -> code.set(reason) }, { finished.countDown() },
        )
        try {
            assertTrue(importer.begin("selected"))
            val delivery = actions.poll(2, TimeUnit.SECONDS) ?: error("No delivery was scheduled")
            foreground.set(false); delivery(); await(finished)
            assertEquals("KEY_IMPORT_CANCELLED", code.get())
            assertTrue(material.all { it == 0.toByte() })
        } finally { importer.close() }
    }

    @Test fun providerExceptionsRemainFixedCodesAndCannotExposeProviderText() {
        val finished = CountDownLatch(1)
        val code = AtomicReference<String>()
        val importer = PrivateKeyImport<String>(
            { true }, { it() }, { _, _ -> throw IllegalStateException("UNTRUSTED_PRIVATE_PROVIDER_TEXT") },
            { _, _ -> fail("The failing provider delivered a key") }, { _, reason -> code.set(reason) }, { finished.countDown() },
        )
        try {
            assertTrue(importer.begin("selected")); await(finished)
            assertEquals("KEY_IMPORT_FAILED", code.get())
        } finally { importer.close() }
    }

    @Test fun destroyAndBlockingResourceCancellationRetainTheSingleFlightSlot() {
        val entered = CountDownLatch(1)
        val returnBytes = CountDownLatch(1)
        val cancelEntered = CountDownLatch(1)
        val finishCancel = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val bytes = byteArrayOf(12, 13)
        val importer = PrivateKeyImport<String>(
            { true }, { it() }, { _, ticket ->
                ticket.onCancel { cancelEntered.countDown(); uninterruptible(finishCancel) }
                entered.countDown(); uninterruptible(returnBytes)
                PrivateKeyImport.Material(bytes, "label")
            }, { _, _ -> fail("Destroy allowed a late key") }, { _, _ -> }, { finished.countDown() },
        )
        try {
            assertTrue(importer.begin("selected")); await(entered)
            importer.close(); await(cancelEntered)
            assertFalse(importer.begin("new"))
            assertTrue(importer.hasFlight())
            returnBytes.countDown()
            finishCancel.countDown(); await(finished)
            assertTrue(bytes.all { it == 0.toByte() })
            assertFalse(importer.hasFlight())
        } finally { returnBytes.countDown(); finishCancel.countDown(); importer.close() }
    }

    @Test fun recreationSharesTheProcessBoundAndBothCancellationLanesRunIndependently() {
        val entered = CountDownLatch(1)
        val returnOld = CountDownLatch(1)
        val blockedCancelEntered = CountDownLatch(1)
        val finishBlockedCancel = CountDownLatch(1)
        val cooperativeCancel = CountDownLatch(1)
        val oldFinished = CountDownLatch(1)
        val newFinished = CountDownLatch(1)
        val oldBytes = byteArrayOf(14, 15)
        val old = PrivateKeyImport<String>(
            { true }, { it() }, { _, ticket ->
                ticket.onCancel { blockedCancelEntered.countDown(); uninterruptible(finishBlockedCancel) }
                ticket.onCancel { cooperativeCancel.countDown() }
                entered.countDown(); uninterruptible(returnOld)
                PrivateKeyImport.Material(oldBytes, "old-label")
            }, { _, _ -> fail("An old instance stored late material") }, { _, _ -> }, { oldFinished.countDown() },
        )
        val recreated = PrivateKeyImport<String>(
            { true }, { it() }, { _, _ -> PrivateKeyImport.Material(byteArrayOf(16), "new-label") },
            { _, _ -> }, { _, _ -> fail("The new import failed") }, { newFinished.countDown() },
        )
        try {
            assertTrue(old.begin("old")); await(entered)
            old.close(); await(blockedCancelEntered); await(cooperativeCancel)
            assertFalse(recreated.begin("while-old-provider-blocks"))
            returnOld.countDown()
            assertFalse(recreated.begin("while-old-cancellation-blocks"))
            finishBlockedCancel.countDown(); await(oldFinished)
            assertTrue(oldBytes.all { it == 0.toByte() })
            assertTrue(recreated.begin("current")); await(newFinished)
        } finally { returnOld.countDown(); finishBlockedCancel.countDown(); old.close(); recreated.close() }
    }

    @Test fun failedDeliverySettlesWithAFixedFailureAndClearsAcquiredMaterial() {
        val finished = CountDownLatch(1)
        val code = AtomicReference<String>()
        val bytes = byteArrayOf(17, 18)
        val importer = PrivateKeyImport<String>(
            { true }, { it() }, { _, _ -> PrivateKeyImport.Material(bytes, "label") },
            { _, _ -> throw IllegalStateException("UNTRUSTED_DELIVERY_EXCEPTION") },
            { _, reason -> code.set(reason) }, { finished.countDown() },
        )
        try {
            assertTrue(importer.begin("selected")); await(finished)
            assertEquals("KEY_IMPORT_FAILED", code.get())
            assertTrue(bytes.all { it == 0.toByte() })
        } finally { importer.close() }
    }
}
