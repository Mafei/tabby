#!/usr/bin/env node
// Linux-only baseline build. Await every native rebuild before packaging;
// preserve all tracked lockfiles rather than the general installer's --force.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rebuild } from '@electron/rebuild'
import * as vars from './vars.mjs'

if (process.platform !== 'linux' || process.arch !== 'x64' || process.env.TABBY_LINUX_PORTABLE !== '1') {
    throw new Error('LINUX_PORTABLE_BASELINE_REQUIRED')
}
const root = fileURLToPath(new URL('..', import.meta.url))
function run (program, args, cwd = root) {
    const result = spawnSync(program, args, { cwd, stdio: 'inherit', env: process.env })
    if (result.error || result.status !== 0) { throw new Error('LINUX_PORTABLE_BUILD_COMMAND_FAILED') }
}
function install (directory, production = false) {
    run('yarn', ['install', '--frozen-lockfile', '--ignore-scripts', '--network-timeout', '1000000',
        ...(production ? ['--production'] : [])], directory)
    // Every package keeps its own patch cwd; the pinned root tool is available
    // even when that plugin or production copy does not declare patch-package.
    run(process.execPath, [resolve(root, 'node_modules/patch-package/index.js'), '--error-on-fail'], directory)
}
for (const name of ['app', ...vars.allPackages]) { install(resolve(root, name)) }
for (const name of vars.builtinPlugins) {
    const link = resolve(root, 'node_modules', name)
    if (!existsSync(link)) { symlinkSync(resolve(root, name), link, 'dir') }
}
// Electron's verified downloader is intentionally invoked after root install
// with scripts disabled; no host Electron binary is copied into the baseline.
run(process.execPath, ['node_modules/electron/install.js'])
for (const name of ['app', 'tabby-core', 'tabby-local', 'tabby-ssh', 'tabby-terminal']) {
    await rebuild({ buildPath: resolve(root, name), electronVersion: vars.electronVersion,
        arch: 'x64', force: true, useCache: false, ignoreModules: ['fontmanager-redux', 'native-process-working-directory'] })
}
run('yarn', ['build'])
const plugins = resolve(root, 'builtin-plugins')
mkdirSync(plugins, { recursive: true })
for (const name of vars.builtinPlugins.filter(name => name !== 'tabby-web')) {
    const destination = resolve(plugins, name)
    rmSync(destination, { recursive: true, force: true })
    cpSync(resolve(root, name), destination, { recursive: true,
        filter: source => source !== resolve(root, name, 'node_modules')
            && !source.startsWith(resolve(root, name, 'node_modules') + '/') })
    install(destination, true)
    if (existsSync(resolve(destination, 'node_modules'))) {
        await rebuild({ buildPath: destination, electronVersion: vars.electronVersion,
            arch: 'x64', force: true, useCache: false, ignoreModules: ['fontmanager-redux', 'native-process-working-directory'] })
    }
}
run('git', ['diff', '--exit-code'])
console.log('PASS Linux baseline build: frozen lockfiles and awaited native/plugin rebuilds.')
