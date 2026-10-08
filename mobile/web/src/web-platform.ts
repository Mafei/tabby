// Angular uses this during module/injector initialization. Load this module
// before Angular; syntax transpilation does not add missing built-in methods.
if (typeof Object.hasOwn !== 'function') {
    const hasOwnProperty = Object.prototype.hasOwnProperty
    Object.defineProperty(Object, 'hasOwn', {
        configurable: true,
        writable: true,
        value: (object: unknown, key: PropertyKey): boolean => {
            // Match ToObject before ToPropertyKey, including exotic key effects.
            if (object === null || object === undefined) { throw new TypeError('Object.hasOwn requires a value') }
            return hasOwnProperty.call(Object(object), key)
        },
    })
}

/** RFC 4122 version 4 ID, using the platform CSPRNG on older WebViews too. */
export function secureUUID(): string {
    if (typeof crypto.randomUUID === 'function') { return crypto.randomUUID() }
    // No weak-random or time-based fallback: missing secure entropy fails closed.
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
