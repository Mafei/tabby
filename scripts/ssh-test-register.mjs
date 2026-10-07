// Keep Electron/Angular UI boundaries outside Node, while loading the real SSH
// sessions, tab logic, connectable tab lifecycle and terminal session middleware.
import * as nodeModule from 'node:module'
import * as hooks from './ssh-test-hooks.mjs'
// Define this without augmenting TypeScript's global require signature during lint.
Reflect.set(globalThis, 'require', () => '')
if (nodeModule.registerHooks) {
    nodeModule.registerHooks(hooks)
} else {
    nodeModule.register('./ssh-test-hooks.mjs', import.meta.url)
}
