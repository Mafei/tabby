import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { linuxPortableOptions } from '../linux-portable-options.mjs'
import afterLinuxPack, { linuxAppRun } from '../linux-portable-after-pack.mjs'

test('portable targets retain AppDir and tar fallback independently of artifact-only CI', () => {
    const options = linuxPortableOptions({ TABBY_LINUX_PORTABLE: '1', TABBY_ARTIFACT_ONLY: '1' }, 'x64', ['**/*', '!src'])
    assert.deepEqual(options.targets, ['appimage', 'tar.gz'])
    assert.equal(options.portable, true)
    assert.deepEqual(options.files.slice(0, 2), ['**/*', '!src'])
    assert.ok(options.files.some(x => x.includes('*.darwin-*.node')))
    assert.ok(options.files.some(x => x.includes('linux-x64/*musl*')))
    assert.deepEqual(linuxPortableOptions({ TABBY_ARTIFACT_ONLY: '1' }, 'arm64', ['**/*']).targets, ['tar.gz'])
    const notices = { from: 'scripts/fonts', to: 'font-notices', filter: ['font-manifest.json', 'licenses/**/*'] }
    const resources = linuxPortableOptions({ TABBY_LINUX_PORTABLE: '1' }, 'x64', ['**/*'], ['builtin-plugins', 'extras', notices]).extraResources
    assert.deepEqual(resources[2], notices)
    assert.ok(resources[0].filter.some(x => x.includes('*.darwin-*.node')))
    assert.ok(resources[0].filter.every(x => !x.includes('ttf')))
    const require = createRequire(import.meta.url)
    const matchModule = require('minimatch')
    const minimatch = typeof matchModule === 'function' ? matchModule : matchModule.minimatch
    const exclusion = resources[0].filter.find(x => x === '!**/src/fonts/bundled/**/*')
    assert.ok(exclusion)
    assert.equal(minimatch('tabby-terminal/src/fonts/bundled/example.ttf', exclusion.slice(1)), true)
    assert.equal(minimatch('tabby-terminal/dist/fonts/example-123.ttf', exclusion.slice(1)), false)
})

test('afterPack makes distributed fonts and notices public without changing source bytes or modes', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tabby-resource-modes-'))
    try {
        const source = path.join(directory, 'source.ttf')
        writeFileSync(source, 'public font bytes', { mode: 0o600 })
        const app = path.join(directory, 'AppDir')
        const fonts = path.join(app, 'resources/builtin-plugins/tabby-terminal/dist/fonts')
        const notices = path.join(app, 'resources/font-notices/licenses')
        mkdirSync(fonts, { recursive: true, mode: 0o700 })
        mkdirSync(notices, { recursive: true, mode: 0o700 })
        const font = path.join(fonts, 'example-123.ttf')
        copyFileSync(source, font)
        const notice = path.join(notices, 'NOTICE.txt')
        writeFileSync(notice, 'public attribution', { mode: 0o600 })
        await afterLinuxPack({ electronPlatformName: 'linux', appOutDir: app, packager: { executableName: 'tabby' } })
        for (const file of [font, notice]) {
            assert.equal(statSync(file).mode & 0o777, 0o644)
            let parent = path.dirname(file)
            while (true) {
                assert.equal(statSync(parent).mode & 0o777, 0o755)
                if (parent === app) { break }
                parent = path.dirname(parent)
            }
        }
        assert.equal(statSync(source).mode & 0o777, 0o600)
        assert.deepEqual(readFileSync(font), readFileSync(source))
        assert.equal(statSync(path.join(app, 'AppRun')).mode & 0o777, 0o755)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('actual electron-builder resource copy excludes source duplicates while preserving emitted fonts', async () => {
    const require = createRequire(import.meta.url)
    const { FileMatcher } = require('app-builder-lib/out/fileMatcher')
    const { copyDir } = require('builder-util/out/fs')
    const directory = mkdtempSync(path.join(tmpdir(), 'tabby-resource-copy-'))
    try {
        const source = path.join(directory, 'plugins')
        const output = path.join(directory, 'output')
        const duplicate = 'tabby-terminal/src/fonts/bundled/example.ttf'
        const emitted = 'tabby-terminal/dist/fonts/example-012345.ttf'
        for (const relative of [duplicate, emitted, 'tabby-terminal/src/fonts/SourceCodePro.ttf']) {
            mkdirSync(path.dirname(path.join(source, relative)), { recursive: true })
            writeFileSync(path.join(source, relative), 'public font bytes')
        }
        const resources = linuxPortableOptions({ TABBY_LINUX_PORTABLE: '1' }, 'x64', ['**/*']).extraResources
        const matcher = new FileMatcher(source, output, x => x, resources[0].filter)
        await copyDir(source, output, { filter: matcher.createFilter(), isUseHardLink: false })
        assert.equal(existsSync(path.join(output, duplicate)), false)
        assert.deepEqual(readFileSync(path.join(output, emitted)), readFileSync(path.join(source, emitted)))
        assert.equal(existsSync(path.join(output, 'tabby-terminal/src/fonts/SourceCodePro.ttf')), true)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('afterPack refuses public resource symlinks and hardlinks before source chmod', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tabby-resource-links-'))
    try {
        const source = path.join(directory, 'source.ttf')
        writeFileSync(source, 'public font bytes', { mode: 0o600 })
        for (const [name, create] of [['symlink', symlinkSync], ['hardlink', linkSync]]) {
            const app = path.join(directory, name)
            mkdirSync(app)
            create(source, path.join(app, 'copy.ttf'))
            await assert.rejects(afterLinuxPack({ electronPlatformName: 'linux', appOutDir: app, packager: { executableName: 'tabby' } }))
            assert.equal(statSync(source).mode & 0o777, 0o600)
        }
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('portable mode rejects unsupported architecture, typo, and hardlink overwrite semantics', () => {
    assert.throws(() => linuxPortableOptions({ TABBY_LINUX_PORTABLE: '1' }, 'arm64', ['**/*']))
    assert.throws(() => linuxPortableOptions({ TABBY_LINUX_PORTABLE: 'true' }, 'x64', ['**/*']))
    assert.throws(() => linuxPortableOptions({ TABBY_LINUX_PORTABLE: '1', USE_HARD_LINKS: 'true' }, 'x64', ['**/*']))
    assert.throws(() => linuxPortableOptions({ TABBY_LINUX_PORTABLE: '1', VITEST: '' }, 'x64', ['**/*']))
})

test('real shell AppRun preserves argument boundaries and AppImage path without sandbox fallback', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tabby portable '))
    try {
        const script = linuxAppRun('tabby')
        assert.ok(!script.includes('no-sandbox'))
        assert.ok(!script.includes('unshare'))
        writeFileSync(path.join(directory, 'AppRun'), script)
        chmodSync(path.join(directory, 'AppRun'), 0o755)
        writeFileSync(path.join(directory, 'tabby'), '#!/bin/sh\nprintf "%s\\n" "$APPDIR" "$APPIMAGE" "$#" "$@"\n')
        chmodSync(path.join(directory, 'tabby'), 0o755)
        const result = execFileSync(path.join(directory, 'AppRun'), ['one two', '$(false)', "a'b"], {
            encoding: 'utf8', env: { ...process.env, APPDIR: directory, APPIMAGE: '/tmp/image with space.AppImage' },
        }).trimEnd().split('\n')
        assert.deepEqual(result, [directory, '/tmp/image with space.AppImage', '3', 'one two', '$(false)', "a'b"])
        const fallback = execFileSync(path.join(directory, 'AppRun'), [], {
            encoding: 'utf8', env: { PATH: process.env.PATH },
        }).trimEnd().split('\n')
        assert.equal(fallback[1], path.join(directory, 'AppRun'))
        const inherited = execFileSync(path.join(directory, 'AppRun'), [], {
            encoding: 'utf8', env: { PATH: process.env.PATH, APPDIR: '/tmp/another-version', APPIMAGE: '/tmp/old.Tabby.AppImage' },
        }).trimEnd().split('\n')
        assert.equal(inherited[1], path.join(directory, 'AppRun'))
        assert.throws(() => linuxAppRun('tabby;false'))
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('actual host service relaunch uses persistent AppImage path and preserves Windows portable behavior', () => {
    // Execute the real TypeScript method with Electron calls captured. It does
    // not start Electron or claim native GUI behavior.
    const require = createRequire(import.meta.url)
    const ts = require('typescript')
    const source = readFileSync(new URL('../../tabby-electron/src/services/hostApp.service.ts', import.meta.url), 'utf8')
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
    })
    const module = { exports: {} }
    const Platform = { Windows: 0, macOS: 1, Linux: 2 }
    const env = {}
    vm.runInNewContext(outputText, {
        module, exports: module.exports, process: { env },
        require: name => name === '@angular/core' ? { Injectable: () => value => value } :
            name === 'tabby-core' ? { HostAppService: class {}, Platform } : {},
    })
    const relaunch = module.exports.ElectronHostAppService.prototype.relaunch
    for (const [platform, variables, expectedPath] of [
        [Platform.Linux, {}, undefined],
        [Platform.Linux, { APPIMAGE: '/tmp/App Image.AppImage' }, '/tmp/App Image.AppImage'],
        [Platform.Windows, { PORTABLE_EXECUTABLE_FILE: 'C:\\Tabby\\Tabby.exe' }, 'C:\\Tabby\\Tabby.exe'],
    ]) {
        for (const key of Object.keys(env)) { delete env[key] }
        Object.assign(env, variables)
        let options, exited = false
        relaunch.call({ platform, electron: { app: { relaunch: x => { options = x }, exit: () => { exited = true } } } })
        assert.equal(options.execPath, expectedPath)
        assert.equal(options.args.length, 0)
        assert.equal(exited, true)
    }
})

test('actual Linux working-directory wrapper uses own public PID without loading a native binding', () => {
    const require = createRequire(new URL('../../app/package.json', import.meta.url))
    const Module = require('node:module')
    const original = Module._load
    let loadedNative = false
    Module._load = function (request, ...args) {
        if (request.includes('native-process-working-directory.node')) {
            loadedNative = true
            throw new Error('Unexpected Linux native working-directory binding')
        }
        return original.call(this, request, ...args)
    }
    try {
        const wrapper = require('native-process-working-directory')
        assert.equal(wrapper.getWorkingDirectoryFromPID(process.pid), process.cwd())
        assert.throws(() => wrapper.getWorkingDirectoryFromHandle(0), /only available on Windows/)
        assert.equal(loadedNative, false)
    } finally {
        Module._load = original
    }
})
