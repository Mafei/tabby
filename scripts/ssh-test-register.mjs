// Keep Electron/Angular UI boundaries outside Node, while loading the real SSH
// sessions, tab logic, connectable tab lifecycle and terminal session middleware.
import * as nodeModule from 'node:module'
import * as hooks from './ssh-test-hooks.mjs'
// Define this without augmenting TypeScript's global require signature during lint.
Object.defineProperty(globalThis, 'require', { value: () => '', configurable: true })
if (nodeModule.registerHooks) {
    nodeModule.registerHooks(hooks)
} else {
    nodeModule.register('./ssh-test-hooks.mjs', import.meta.url)
}
