// Test-only preload. This runs in the isolated sandbox and exposes no Node API.
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('fontRuntime', Object.freeze({
    sandboxed: process.sandboxed === true,
    contextIsolated: process.contextIsolated === true,
    report: result => ipcRenderer.send('font-runtime-result', result),
}))
