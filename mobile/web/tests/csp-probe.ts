/** Served only by the test server. Never included in the production build/APK.
 * These operations run as an ordinary same-origin page script, rather than
 * inside a DevTools evaluation that can bypass unsafe-eval restrictions.
 */
export {}

interface CSPProbe {
    externalExecuted: boolean
    callableTimerExecuted: boolean
    evalExecuted: boolean
    functionExecuted: boolean
    stringTimerExecuted: boolean
    inlineExecuted: boolean
    evalBlocked: boolean
    functionBlocked: boolean
    stringTimerBlocked: boolean
    inlineBlocked: boolean
    violations: { eval: number, inline: number }
    finished: boolean
}

declare global { interface Window { __tabbyCSPProbe?: CSPProbe } }

const state: CSPProbe = {
    externalExecuted: true, callableTimerExecuted: false,
    evalExecuted: false, functionExecuted: false, stringTimerExecuted: false, inlineExecuted: false,
    evalBlocked: false, functionBlocked: false, stringTimerBlocked: false, inlineBlocked: false,
    violations: { eval: 0, inline: 0 }, finished: false,
}
window.__tabbyCSPProbe = state

const violation = (event: SecurityPolicyViolationEvent) => {
    if (event.disposition !== 'enforce' || !['script-src', 'script-src-elem'].includes(event.effectiveDirective)) { return }
    // Keep only fixed counters: no policy, URL, source sample or message.
    if (event.blockedURI === 'eval') { state.violations.eval++ }
    if (event.blockedURI === 'inline') { state.violations.inline++ }
}
document.addEventListener('securitypolicyviolation', violation)

try { window.eval('window.__tabbyCSPProbe.evalExecuted = true') }
catch (error) { state.evalBlocked = error instanceof EvalError }
try { new Function('window.__tabbyCSPProbe.functionExecuted = true')() }
catch (error) { state.functionBlocked = error instanceof EvalError }
try { window.setTimeout('window.__tabbyCSPProbe.stringTimerExecuted = true', 0) }
catch { /* A blocked string timer may throw or return without scheduling. */ }

const inline = document.createElement('script')
inline.textContent = 'window.__tabbyCSPProbe.inlineExecuted = true'
document.head.appendChild(inline)
inline.remove()

// A callable timer is allowed. Its successful execution is also a positive
// control that the zero-delay string timer had an opportunity to run.
window.setTimeout(() => {
    state.callableTimerExecuted = true
    state.stringTimerBlocked = !state.stringTimerExecuted && state.violations.eval >= 3
    state.inlineBlocked = !state.inlineExecuted && state.violations.inline >= 1
    state.finished = true
    document.removeEventListener('securitypolicyviolation', violation)
}, 50)
