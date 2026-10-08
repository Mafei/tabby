// Only fixed public categories cross the renderer boundary or enter a receipt.
// Never publish an arbitrary exception message, console output, URL or stack.
export const runtimeStages = ['STARTUP', 'NATIVE_PTY', 'NATIVE_RUSSH', 'NATIVE_KEYTAR', 'NATIVE_SERIALPORT', 'NATIVE_CWD', 'PLUGIN_FONT_SOURCES', 'SANDBOXED_FONT_RENDERER', 'COMPLETE']
const codes = new Set([
    'UNKNOWN_FAILURE', 'FONT_RUNTIME_DEADLINE', 'RENDER_PROCESS_GONE',
    'ELECTRON_43_REQUIRED', 'SANDBOX_BYPASS_FORBIDDEN',
    'NATIVE_BINDING_PATH_FAILED', 'NATIVE_BINDING_HASH_FAILED', 'NATIVE_BINDING_NOT_LOADED',
    'PTY_OUTPUT_LIMIT', 'PTY_PROBE_FAILED', 'CWD_WRAPPER_FAILED',
    'PACKAGED_PLUGIN_FONT_FAILED', 'PACKAGED_PLUGIN_FONT_PATH_FAILED', 'PACKAGED_PLUGIN_FONT_HASH_FAILED',
    'FONT_REPORT_SOURCE_REJECTED', 'FONT_RENDERER_FAILED', 'FONT_SAMPLE_LIST_FAILED',
    'FONT_SAMPLE_NODE_MISSING', 'FONT_SYSTEM_FALLBACK_DETECTED', 'FONT_RENDERER_CAPTURE_EMPTY', 'FONT_RENDERER_PREFERENCES_FAILED',
    'FONT_RENDERER_SANDBOX_REQUIRED', 'FONT_FACE_LOAD_FAILED', 'FONT_FACE_MISSING', 'FONT_CANVAS_UNAVAILABLE',
    'FONT_DISTINCT_GLYPH_INK_FAILED', 'FONT_MONO_WIDTH_FAILED', 'FONT_COLOR_EMOJI_FAILED',
    'WEBGL_ADDON_FAILED', 'TERMINAL_COLUMN_WIDTH_FAILED', 'TERMINAL_WRAP_FAILED',
    'TERMINAL_SELECTION_COPY_FAILED', 'TERMINAL_ACTIVE_LINE_RESIZE_FAILED', 'TERMINAL_COMPLETED_LINE_REFLOW_FAILED',
    'TERMINAL_REPAINT_FAILED', 'TERMINAL_LAYOUT_FAILED',
])
const kinds = new Set(['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError',
    'SecurityError', 'NotSupportedError', 'InvalidStateError', 'NetworkError', 'AbortError', 'OperationError', 'DataError'])
const loadErrors = new Set(['ERR_FILE_NOT_FOUND', 'ERR_ACCESS_DENIED', 'ERR_ABORTED', 'ERR_BLOCKED_BY_CLIENT',
    'ERR_FAILED', 'ERR_INVALID_URL', 'ERR_UNKNOWN_URL_SCHEME', 'ERR_NETWORK_ACCESS_DENIED', 'ERR_INSUFFICIENT_RESOURCES'])
const substages = new Set(['INITIALIZATION', 'NATIVE_PROBE', 'PRODUCT_FONT_PROBE', 'RENDERER_SETUP', 'RENDERER_LOAD',
    'RENDERER_WAIT', 'RENDERER_RESULT', 'PLATFORM_FONT_ATTACH', 'PLATFORM_FONT_DOM', 'PLATFORM_FONT_CSS',
    'PLATFORM_FONT_SAMPLE', 'CAPTURE', 'PREFERENCES', 'SANDBOX', 'FONT_LOAD', 'FONT_MATCH', 'SAMPLES',
    'PIXELS', 'MONO', 'COLOR_EMOJI', 'WEBGL_PROBE', 'WEBGL_ADDON',
    ...['DOM', 'WEBGL'].flatMap(backend => ['OPEN', 'CELLS', 'WRAP', 'COPY', 'ACTIVE_RESIZE', 'REFLOW', 'REPAINT', 'LAYOUT']
        .map(operation => `${backend}_${operation}`))])
export function failureCode (error) {
    const value = typeof error === 'string' ? error : error?.message
    return codes.has(value) ? value : 'UNKNOWN_FAILURE'
}
export function normalizeDiagnostic (value) {
    return { failureCode: failureCode(value?.failureCode),
        failureOrigin: ['MAIN', 'RENDERER'].includes(value?.failureOrigin) ? value.failureOrigin : 'UNKNOWN',
        failureKind: kinds.has(value?.failureKind) ? value.failureKind : 'UNKNOWN',
        substage: substages.has(value?.substage) ? value.substage : 'UNKNOWN',
        loadError: loadErrors.has(value?.loadError) ? value.loadError : 'UNKNOWN' }
}
export function failureDiagnostic (error, substage, origin) {
    return normalizeDiagnostic({ failureCode: failureCode(error), failureKind: error?.name, substage, failureOrigin: origin, loadError: error?.code })
}
export function runtimeFailure (value) {
    const stage = runtimeStages.includes(value?.stage) ? value.stage : 'STARTUP'
    return { passed: false, stage, code: `FONT_RUNTIME_FAILED_${stage}`, ...normalizeDiagnostic(value) }
}
