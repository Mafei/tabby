// Executes real TypeScript services/handlers and compiles actual Sass/Pug.
// DOM/DI boundaries are controlled fixtures, not full application GUI evidence.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import * as sass from 'sass'
import pug from 'pug'
import postcss from 'postcss'
import { Subject } from 'rxjs'

const read = file => fs.readFileSync(file, 'utf8')
const coreRequire = createRequire(path.resolve('tabby-core/package.json'))
const decorator = () => () => {}
const angular = { Injectable: () => value => value, Component: () => value => value,
    Input: decorator, HostBinding: decorator, HostListener: decorator, Inject: decorator, Optional: decorator }
function compile (source, modules = {}, globals = {}) {
    const module = { exports: {} }
    const output = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
        experimentalDecorators: true, esModuleInterop: true,
    } }).outputText
    vm.runInNewContext(output, { module, exports: module.exports, require: name => {
        assert(name in modules, `Uncontrolled fixture import ${name}`)
        return modules[name]
    }, ...globals })
    return module.exports
}
const legacy = compile(read('tabby-core/src/tabStripColors.ts'))
const desktop = compile(read('tabby-core/src/desktopChrome.ts'))
const DefaultTheme = compile(read('tabby-core/src/theme.ts'), {
    '@angular/core': angular, '@biesbjerg/ngx-translate-extract-marker': { marker: value => value },
    './api': { Theme: class {} }, './theme.new.scss': 'STANDARD',
}).NewTheme
const schemes = compile(read('tabby-terminal/src/colorSchemes.ts'), {
    '@angular/core': angular, './api/colorSchemeProvider': { TerminalColorSchemeProvider: class {} },
}).DefaultColorSchemes

function themeFixture (source = read('tabby-core/src/services/themes.service.ts')) {
    const vars = {}, classes = new Set(), customCSS = {}
    let cssText = ''
    const style = { setProperty: (key, value) => { vars[key] = value },
        get cssText () { return cssText }, set cssText (value) {
            cssText = value; Object.keys(vars).forEach(key => delete vars[key])
        } }
    const document = { documentElement: { style }, body: { classList: {
        toggle: (key, value) => value ? classes.add(key) : classes.delete(key),
    } }, createElement: () => ({ setAttribute () {} }), querySelector: selector => selector === 'head' ? { appendChild () {} } : customCSS }
    const Service = compile(source, {
        '@angular/core': angular, rxjs: { Subject }, color: coreRequire('color'),
        '../api/theme': { Theme: class {} }, '../theme': { NewTheme: DefaultTheme },
        '../tabStripColors': legacy, '../desktopChrome': desktop,
    }, { document }).ThemesService
    const standard = Object.assign(new DefaultTheme(), { name: 'standard' })
    const providedStandard = Object.assign(new DefaultTheme(), { name: 'standard' })
    const external = { name: 'external', css: 'EXTERNAL', followsColorScheme: false }
    const derived = { name: 'derived', css: 'DERIVED', followsColorScheme: true }
    const store = { appearance: { theme: 'standard', colorSchemeMode: 'dark', vibrancy: false, spaciness: 1, css: '.user { color: red; }' },
        accessibility: { animations: false }, terminal: { minimumContrastRatio: 4,
            colorScheme: structuredClone(schemes.defaultColorScheme), lightColorScheme: structuredClone(schemes.defaultLightColorScheme) } }
    const config = { store, getDefaults: () => store, enabledServices: value => value, ready$: new Subject(), changed$: new Subject() }
    const platform = { mode: 'dark', getTheme () { return this.mode }, themeChanged$: new Subject() }
    const service = new Service(config, standard, platform, [providedStandard, external, derived])
    return { service, standard, config, platform, vars, classes, customCSS }
}
const plain = value => JSON.parse(JSON.stringify(value))
const nonChrome = value => Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('--tabby-')))

test('real ThemesService preserves terminal/legacy variables and scopes desktop colors to its standard theme', () => {
    const beforeSource = execFileSync('git', ['show', 'd83bf1b4904e439533d074aa6f7d3b48ebde5776:tabby-core/src/services/themes.service.ts'], { encoding: 'utf8' })
    for (const mode of ['dark', 'light']) {
        for (const vibrancy of [false, true]) {
            const current = themeFixture(), previous = themeFixture(beforeSource)
            for (const fixture of [current, previous]) {
                Object.assign(fixture.config.store.appearance, { colorSchemeMode: mode, vibrancy })
                fixture.service.applyThemeVariables()
            }
            assert.deepEqual(nonChrome(current.vars), nonChrome(previous.vars))
            assert(current.classes.has('tabby-desktop-theme'))
            assert.notEqual(current.service.findCurrentTheme(), current.standard, 'exercise separate Angular multi-provider/default injection instances')
            assert.equal(current.vars['--tabby-tab-inactive-bg'], mode === 'dark' ? '#0d1320' : '#cad8e9')
            const terminal = JSON.stringify(current.config.store.terminal)
            current.config.store.terminal.colorScheme.background = '#ffffff'
            current.config.store.terminal.lightColorScheme.background = '#171717'
            current.service.applyThemeVariables()
            assert.equal(current.vars['--tabby-tab-inactive-bg'], mode === 'dark' ? '#0d1320' : '#cad8e9', 'UI follows explicit mode, not inverted terminal colors')
            current.config.store.terminal = JSON.parse(terminal)
            for (const name of ['external', 'derived']) {
                current.config.store.appearance.theme = name
                previous.config.store.appearance.theme = name
                current.service.applyThemeVariables(); previous.service.applyThemeVariables()
                assert(!current.classes.has('tabby-desktop-theme'))
                assert.deepEqual(nonChrome(current.vars), nonChrome(previous.vars))
                if (name === 'derived') {
                    for (const [key, value] of Object.entries(previous.vars).filter(([key]) => key.startsWith('--tabby-tab-'))) {
                        assert.equal(current.vars[key], value, 'third-party follow-scheme theme keeps safe derived palette')
                    }
                }
                assert.equal(JSON.stringify(current.config.store.terminal), terminal, 'theme application never mutates terminal configuration')
            }
        }
    }
})

test('real theme subscriptions respond to system mode, user config and switching away from the default theme', async () => {
    const f = themeFixture()
    f.config.ready$.next(); f.config.ready$.complete(); await Promise.resolve()
    f.config.store.appearance.colorSchemeMode = 'auto'
    f.platform.mode = 'light'; f.platform.themeChanged$.next()
    assert.equal(f.vars['--tabby-tab-inactive-bg'], '#cad8e9')
    assert.equal(f.service._getActiveColorScheme(), f.config.store.terminal.lightColorScheme)
    f.platform.mode = 'dark'; f.platform.themeChanged$.next()
    assert.equal(f.vars['--tabby-tab-inactive-bg'], '#0d1320')
    f.config.store.appearance.theme = 'external'; f.config.changed$.next()
    assert(!f.classes.has('tabby-desktop-theme'))
    assert.equal(f.customCSS.innerHTML, '.user { color: red; }')
    f.config.store.appearance.theme = 'standard'; f.config.changed$.next()
    assert(f.classes.has('tabby-desktop-theme'))
    f.config.changed$.complete(); f.platform.themeChanged$.complete()
})

const frames = []
const Header = compile(read('tabby-core/src/components/tabHeader.component.ts'), {
    '@angular/core': angular, rxjs: { auditTime: () => {} }, '../components/baseTab.component': { BaseTabComponent: class {} },
    './splitTab.component': { SplitTabComponent: class {} }, './base.component': { BaseComponent: class {} },
    '../api/hostApp': { Platform: { macOS: 'mac' } },
    '../api/tabContextMenuProvider': { TabContextMenuItemProvider: class {} },
}, { requestAnimationFrame: callback => frames.push(callback) }).TabHeaderComponent

test('real TabHeader keyboard handlers distinguish focus from selection and leave terminal/nested button keys alone', () => {
    let selection = 0, focused = -1
    const header = Object.create(Header.prototype)
    header.config = { store: { appearance: { tabsLocation: 'top' }, terminal: {} } }
    header.tab = { title: 'Long title', customTitle: 'User label', effectivelyPinned: false }
    header.app = { selectTab: tab => { assert.equal(tab, header.tab); selection++ } }
    const nodes = Array.from({ length: 3 }, (_, index) => ({ focus: () => { focused = index } }))
    const root = nodes[0]; root.parentElement = { querySelectorAll: () => nodes }
    const key = (name, extra = {}) => {
        const event = { key: name, target: root, currentTarget: root, prevented: false, stopped: false,
            preventDefault () { this.prevented = true }, stopPropagation () { this.stopped = true }, ...extra }
        header.onKeyDown(event); return event
    }
    assert(key('ArrowRight').prevented); assert.equal(focused, 1); assert.equal(selection, 0)
    key('ArrowLeft'); assert.equal(focused, 2)
    key('Home'); assert.equal(focused, 0); key('End'); assert.equal(focused, 2)
    key('Enter'); key(' '); assert.equal(selection, 2)
    assert(!key('Enter', { target: {} }).prevented)
    assert(!key('ArrowRight', { ctrlKey: true }).prevented)
    assert(!key('Tab').prevented)
    header.config.store.appearance.tabsLocation = 'right'
    key('ArrowDown'); assert.equal(focused, 1); key('ArrowUp'); assert.equal(focused, 2)
    assert(!key('ArrowRight').prevented)
    header.active = false; assert.equal(header.isSelected, false); assert.equal(header.accessibleTitle, 'User label')
    assert.equal(header.actionCount, 2); header.tab.effectivelyPinned = true; assert.equal(header.actionCount, 1)
    header.config.store.terminal.hideTabOptionsButton = true; assert.equal(header.actionCount, 0)
    const scrolls = []
    header.element = { nativeElement: { isConnected: true, scrollIntoView: options => scrolls.push(options) } }
    header.active = true; header.ngOnChanges(); frames.shift()()
    assert.deepEqual(plain(scrolls), [{ block: 'nearest', inline: 'nearest' }])
    header.ngOnChanges(); header.element.nativeElement.isConnected = false; frames.shift()()
    assert.equal(scrolls.length, 1, 'a removed tab does not scroll after its pending frame')
})

test('actual Windows overlay handler follows desktop/custom CSS text, active scheme fallback and native-frame guard', () => {
    const source = ts.createSourceFile('index.ts', read('tabby-electron/src/index.ts'), ts.ScriptTarget.Latest, true)
    const method = source.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'ElectronModule').members.find(n => n.name?.text === 'updateWindowControlsColor')
    let desktopTheme = true, cssColor = '#123456'
    const Handler = compile(`export class Handler { ${method.getText(source)} }`, {}, {
        Platform: { Windows: 'win' }, document: { body: { classList: { contains: () => desktopTheme } }, querySelector: () => ({}) },
        getComputedStyle: () => ({ getPropertyValue: () => cssColor }),
    }).Handler
    const handler = new Handler(), messages = []
    handler.config = { store: { appearance: { frame: 'thin' } } }; handler.hostApp = { platform: 'win' }
    handler.themeService = { _getActiveColorScheme: () => ({ foreground: '#4d4d4c' }) }
    handler.electron = { ipcRenderer: { send: (...args) => messages.push(args) } }
    handler.updateWindowControlsColor(); assert.deepEqual(plain(messages.pop()), ['window-set-window-controls-color', { foreground: '#123456' }])
    desktopTheme = false; handler.updateWindowControlsColor(); assert.equal(messages.pop()[1].foreground, '#4d4d4c')
    desktopTheme = true; cssColor = ''; handler.updateWindowControlsColor(); assert.equal(messages.pop()[1].foreground, '#4d4d4c')
    handler.config.store.appearance.frame = 'native'; handler.updateWindowControlsColor(); assert.equal(messages.length, 0)
    handler.config.store = null; handler.updateWindowControlsColor(); assert.equal(messages.length, 0)
})

test('real root focus handlers preserve selection while tab sizing follows density and vertical/flex options', () => {
    const source = ts.createSourceFile('root.ts', read('tabby-core/src/components/appRoot.component.ts'), ts.ScriptTarget.Latest, true)
    const root = source.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'AppRootComponent')
    const methods = root.members.filter(n => ['onWindowFocus', 'onWindowBlur', 'hasVerticalTabs', 'targetTabSize'].includes(n.name?.text)).map(n => n.getText(source)).join('\n')
    const Root = compile(`export class Root { ${methods} }`, {}, { HostListener: decorator }).Root
    const instance = new Root()
    instance.config = { store: { appearance: { tabsLocation: 'top', flexTabs: false } } }
    instance.onWindowFocus(); assert.equal(instance.windowFocused, true)
    instance.onWindowBlur(); assert.equal(instance.windowFocused, false)
    assert.equal(instance.targetTabSize, 'var(--tabby-tab-width, 200px)')
    instance.config.store.appearance.flexTabs = true; assert.equal(instance.targetTabSize, '*')
    instance.config.store.appearance.flexTabs = false; instance.config.store.appearance.tabsLocation = 'left'
    assert.equal(instance.targetTabSize, '*')
})

test('actual Sass, Pug and Angular encapsulation compile; geometry and state selectors stay platform-neutral', async () => {
    const importer = { findFileUrl: url => url.startsWith('~') ? pathToFileURL(path.resolve('tabby-core/node_modules', url.slice(1))) : null }
    const options = { importers: [importer], quietDeps: true, logger: { warn () {}, debug () {} } }
    const css = sass.compile('tabby-core/src/theme.new.scss', options).css
    const parsed = postcss.parse(css)
    const chrome = parsed.nodes.filter(n => n.type === 'rule' && n.selector.includes('.tabby-desktop-theme'))
    assert(chrome.length > 30)
    assert(chrome.every(n => !/platform-(linux|darwin|win32)/.test(n.selector)), 'all platforms use the same visual rules')
    assert(chrome.some(n => n.selector.endsWith('app-root:not(.window-focused)') && n.nodes.some(p => p.prop === '--tabby-selected-marker' && p.value.includes('unfocused'))))
    assert(chrome.some(n => n.selector.endsWith('split-tab > .child') && n.nodes.some(p => p.prop === 'opacity' && p.value === '1')))
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-style-compile-'))
    try {
        const compiler = path.resolve('node_modules/@angular/compiler/fesm2015/compiler.mjs')
        const module = path.join(scratch, 'shadow-css.mjs'); fs.writeFileSync(module, read(compiler) + '\nexport { ShadowCss };\n')
        const { ShadowCss } = await import(pathToFileURL(module).href)
        for (const name of ['appRoot', 'tabHeader', 'splitTab', 'splitTabSpanner', 'splitTabPaneLabel', 'titleBar', 'windowControls']) {
            const scoped = new ShadowCss().shimCssText(sass.compile(`tabby-core/src/components/${name}.component.scss`, options).css, '_ngcontent-test', '_nghost-test')
            assert(scoped.includes('_nghost-test') || scoped.includes('_ngcontent-test'))
        }
        for (const name of ['appRoot', 'tabHeader']) {
            const html = pug.compile(read(`tabby-core/src/components/${name}.component.pug`))({ require: file => read(path.resolve('tabby-core/src/components', file)) })
            assert(html.includes('aria-label'))
        }
    } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
})
