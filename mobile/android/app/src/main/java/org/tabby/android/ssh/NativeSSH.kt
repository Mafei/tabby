package org.tabby.android.ssh

/** The implementation is the real russh JNI library, never a Web SSH gateway. */
object NativeSSH {
    init { System.loadLibrary("tabby_ssh") }

    external fun start(optionsJson: String): Long
    external fun command(id: Long, commandJson: String)
    external fun poll(id: Long): String
    external fun destroy(id: Long)
}
