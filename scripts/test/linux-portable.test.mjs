import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
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

test('actual builder config and copy avoid overlapping plugin owners while preserving runtime links, native files, fonts and notices', async () => {
    const require = createRequire(import.meta.url)
    const { getConfig } = require('app-builder-lib/out/util/config/config')
    const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher')
    const root = fileURLToPath(new URL('../..', import.meta.url))
    const base = require('js-yaml').load(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))
    const options = linuxPortableOptions({ TABBY_LINUX_PORTABLE: '1' }, 'x64', base.files, base.extraResources)
    const originalPortable = process.env.TABBY_LINUX_PORTABLE
    const directory = mkdtempSync(path.join(tmpdir(), 'tabby-builder-resource-owners-'))
    try {
        process.env.TABBY_LINUX_PORTABLE = '1'
        // This is the real loader/merge used by builder, rather than a hand-made
        // FileMatcher that misses the generic YAML owner.
        const overlapping = await getConfig(root, null, { extraResources: options.extraResources })
        const fixed = await getConfig(root, 'scripts/linux-portable-config.mjs', null)
        assert.equal(fixed.extraResources.length, 3)
        assert.equal(fixed.publish, null)
        assert.deepEqual(fixed.electronFuses, base.electronFuses)
        assert.deepEqual(fixed.linux.executableArgs, [])
        const project = path.join(directory, 'project')
        const plugin = path.join(project, 'builtin-plugins')
        const link = 'tabby-ssh/node_modules/@luminati-io/socksv5/node_modules/.bin/ipv6grep'
        const target = '../../../../ipv6/bin/ipv6grep.js'
        const files = [
            ['tabby-ssh/node_modules/ipv6/bin/ipv6grep.js', 'public runtime CLI'],
            ['tabby-ssh/node_modules/russh/russh.linux-x64-gnu.node', 'public native fixture'],
            ['tabby-ssh/node_modules/russh/russh.darwin-arm64.node', 'foreign native fixture'],
            ['tabby-terminal/dist/index.js', 'compiled plugin fixture'],
        ]
        for (const [relative, bytes] of files) {
            mkdirSync(path.dirname(path.join(plugin, relative)), { recursive: true })
            writeFileSync(path.join(plugin, relative), bytes)
        }
        const manifest = JSON.parse(readFileSync(path.join(root, 'scripts/fonts/font-manifest.json'), 'utf8'))
        for (const font of manifest.fonts) {
            for (const prefix of ['tabby-terminal/dist/fonts', 'tabby-terminal/src/fonts/bundled']) {
                const file = path.join(plugin, prefix, font.file)
                mkdirSync(path.dirname(file), { recursive: true })
                copyFileSync(path.join(root, 'tabby-terminal/src/fonts/bundled', font.file), file)
            }
        }
        const notices = path.join(project, 'scripts/fonts/licenses')
        mkdirSync(notices, { recursive: true })
        copyFileSync(path.join(root, 'scripts/fonts/font-manifest.json'), path.join(project, 'scripts/fonts/font-manifest.json'))
        for (const notice of manifest.licenses) {
            copyFileSync(path.join(root, 'scripts/fonts/licenses', notice.file), path.join(notices, notice.file))
        }
        mkdirSync(path.join(project, 'extras'))
        writeFileSync(path.join(project, 'extras/public-runtime.txt'), 'runtime extra')
        writeFileSync(path.join(project, 'extras/foreign.exe'), 'foreign executable fixture')
        mkdirSync(path.dirname(path.join(plugin, link)), { recursive: true })
        symlinkSync(target, path.join(plugin, link))
        function matchers (config, output) {
            return getFileMatchers(config, 'extraResources', output, {
                defaultSrc: project, globalOutDir: path.join(project, 'dist'),
                macroExpander: x => x, customBuildOptions: config.linux,
            })
        }
        const brokenOutput = path.join(directory, 'broken/resources')
        const oldMatchers = matchers(overlapping, brokenOutput)
        const generic = oldMatchers.find(m => m.from === project)
        const filtered = oldMatchers.find(m => m.from === plugin)
        assert(generic && filtered)
        // Sequential copies reproduce the same duplicate destination without
        // leaving concurrent copy jobs active after the expected rejection.
        await copyFiles([generic])
        await assert.rejects(copyFiles([filtered]), error => error.code === 'EEXIST')
        const output = path.join(directory, 'fixed/resources')
        const owners = matchers(fixed, output)
        assert.equal(owners.length, 3)
        await copyFiles(owners)
        assert.equal(readlinkSync(path.join(output, 'builtin-plugins', link)), target)
        for (const [relative, bytes] of files.filter(([relative]) => !relative.includes('darwin'))) {
            assert.equal(readFileSync(path.join(output, 'builtin-plugins', relative), 'utf8'), bytes)
        }
        assert.equal(existsSync(path.join(output, 'builtin-plugins/tabby-ssh/node_modules/russh/russh.darwin-arm64.node')), false)
        assert.equal(existsSync(path.join(output, 'extras/foreign.exe')), false)
        assert.equal(readFileSync(path.join(output, 'extras/public-runtime.txt'), 'utf8'), 'runtime extra')
        for (const font of manifest.fonts) {
            assert.deepEqual(readFileSync(path.join(output, 'builtin-plugins/tabby-terminal/dist/fonts', font.file)), readFileSync(path.join(root, 'tabby-terminal/src/fonts/bundled', font.file)))
            assert.equal(existsSync(path.join(output, 'builtin-plugins/tabby-terminal/src/fonts/bundled', font.file)), false)
        }
        for (const notice of manifest.licenses) {
            assert.deepEqual(readFileSync(path.join(output, 'font-notices/licenses', notice.file)), readFileSync(path.join(root, 'scripts/fonts/licenses', notice.file)))
        }
    } finally {
        if (originalPortable === undefined) { delete process.env.TABBY_LINUX_PORTABLE } else { process.env.TABBY_LINUX_PORTABLE = originalPortable }
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
