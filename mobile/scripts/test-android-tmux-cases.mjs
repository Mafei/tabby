/** Exact supplemental acceptance labels; original Android 7+7 remain separate. */
export const TMUX_WEBVIEW_CASES = Object.freeze([
    'actual SSH exec detects tmux, lists the selected private socket and creates literal session names with atomic collision rejection',
    'two real PTYs share one tmux session; read-only blocks input and explicit takeover detaches prior clients',
    'real TCP interruption restores the same tmux server/session identity and pauses automatic recovery while occupied',
    'missing, replaced and restarted tmux identities fail closed without implicit session creation',
    'cancel and old generations cannot reopen tmux or affect another Tab',
])

export const TMUX_NATIVE_CLASS = 'org.tabby.android.prototype.DeferredSSHBridgeTest'
export const TMUX_NATIVE_METHODS = Object.freeze([
    'deferredExecCompletesWithSeparateUnicodeStreamsAndNoPTY',
    'cancelledExecAndStaleGenerationCannotAffectAnotherTab',
    'deferredTmuxTerminalPreservesIdentityAcrossReconnect',
])

export const TMUX_ISOLATION_CLASS = 'org.tabby.android.prototype.NativeSessionIsolationTest'
export const TMUX_ISOLATION_METHODS = Object.freeze([
    'actualPluginPreservesOtherTabsAndClosesAllSessionsOnBackground',
])
