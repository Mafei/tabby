// A browser fixture using the real theme service, Sass, Pug header and Angular
// CSS encapsulation. It is not a full Tabby, physical display or xrdp test.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import * as sass from 'sass'
import ts from 'typescript'
import pug from 'pug'

const baseline = 'd83bf1b4904e439533d074aa6f7d3b48ebde5776'
const output = path.resolve('dist/linux-tab-strip')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-tab-strip-'))
const coreRequire = createRequire(path.resolve('tabby-core/package.json'))
const read = file => fs.readFileSync(file, 'utf8')
const before = file => execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' })
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
fs.mkdirSync(output, { recursive: true })

function compileTS (source, modules, document = {}) {
    const module = { exports: {} }
    const require = name => {
        assert(name in modules, `Uncontrolled fixture import: ${name}`)
        return modules[name]
    }
    const compiled = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
        experimentalDecorators: true, esModuleInterop: true,
    } }).outputText
    vm.runInNewContext(compiled, { module, exports: module.exports, require, document })
    return module.exports
}
const angular = { Injectable: () => value => value, Inject: () => () => {} }
const schemes = compileTS(read('tabby-terminal/src/colorSchemes.ts'), {
    '@angular/core': angular, './api/colorSchemeProvider': { TerminalColorSchemeProvider: class {} },
}).DefaultColorSchemes
const palette = compileTS(read('tabby-core/src/tabStripColors.ts'), {})
const desktop = compileTS(read('tabby-core/src/desktopChrome.ts'), {})
function variables (source, mode, vibrancy = false, followsColorScheme = true, customScheme) {
    class DefaultTheme {}
    const vars = {}
    const document = { documentElement: { style: { setProperty: (key, value) => { vars[key] = value }, cssText: '' } }, body: { classList: { toggle () {} } } }
    const Service = compileTS(source, {
        '@angular/core': angular, rxjs: { Subject: class {} }, color: coreRequire('color'),
        '../api/theme': { Theme: class {} }, '../theme': { NewTheme: DefaultTheme },
        '../tabStripColors': palette, '../desktopChrome': desktop,
    }, document).ThemesService
    const service = Object.create(Service.prototype)
    service.config = { store: {
        appearance: { colorSchemeMode: mode, vibrancy, spaciness: 1 },
        accessibility: { animations: false }, terminal: { minimumContrastRatio: 4,
            colorScheme: customScheme ?? schemes.defaultColorScheme, lightColorScheme: schemes.defaultLightColorScheme },
    } }
    service.standardTheme = Object.assign(new DefaultTheme(), { followsColorScheme: true })
    const providedTheme = Object.assign(new DefaultTheme(), { followsColorScheme: true })
    service.findCurrentTheme = () => followsColorScheme ? providedTheme : { followsColorScheme: false }
    service.platform = { getTheme: () => mode === 'light' ? 'light' : 'dark' }
    service.applyThemeVariables()
    return vars
}
const sources = { before: before('tabby-core/src/services/themes.service.ts'), after: read('tabby-core/src/services/themes.service.ts') }
const datasets = {}
for (const mode of ['dark', 'light']) {
    for (const vibrant of [false, true]) {
        for (const version of ['before', 'after']) {
            datasets[`${version}-${mode}-${vibrant}`] = variables(sources[version], mode, vibrant)
        }
        const old = datasets[`before-${mode}-${vibrant}`], current = datasets[`after-${mode}-${vibrant}`]
        const nonChrome = data => Object.fromEntries(Object.entries(data).filter(([key]) => !key.startsWith('--tabby-')))
        assert.deepEqual(nonChrome(current), nonChrome(old), 'Existing theme/terminal variables unchanged')
    }
    assert.deepEqual(variables(sources.after, mode, false, false), variables(sources.before, mode, false, false), 'External theme variables unchanged')
}
const importer = { findFileUrl: url => url.startsWith('~') ? pathToFileURL(path.resolve('tabby-core/node_modules', url.slice(1))) : null }
const options = { importers: [importer], quietDeps: true, logger: { warn () {}, debug () {} } }
const css = {
    before: sass.compileString(before('tabby-core/src/theme.new.scss'), { ...options, url: pathToFileURL(path.resolve('tabby-core/src/theme.new.scss')) }).css,
    after: sass.compile('tabby-core/src/theme.new.scss', options).css,
}
// Use the installed Angular compiler's own ShadowCss implementation, rather
// than replacing :host and accidentally removing selector specificity.
const compilerPath = path.resolve('node_modules/@angular/compiler/fesm2015/compiler.mjs')
const shimPath = path.join(scratch, 'angular-shadow-css.mjs')
fs.writeFileSync(shimPath, read(compilerPath) + '\nexport { ShadowCss };\n')
const { ShadowCss } = await import(pathToFileURL(shimPath).href)
const scope = new ShadowCss()
const componentCSS = scope.shimCssText(sass.compile('tabby-core/src/components/appRoot.component.scss', options).css, '_ngcontent-root', '_nghost-root') +
    scope.shimCssText(sass.compile('tabby-core/src/components/tabHeader.component.scss', options).css, '_ngcontent-header', '_nghost-header') +
    scope.shimCssText(sass.compile('tabby-core/src/components/windowControls.component.scss', options).css, '_ngcontent-controls', '_nghost-controls') +
    scope.shimCssText(sass.compile('tabby-core/src/components/splitTab.component.scss', options).css, '_ngcontent-split', '_nghost-split') +
    scope.shimCssText(sass.compile('tabby-core/src/components/splitTabSpanner.component.scss', options).css, '_ngcontent-spanner', '_nghost-spanner') +
    scope.shimCssText(sass.compile('tabby-core/src/components/splitTabPaneLabel.component.scss', options).css, '_ngcontent-pane', '_nghost-pane')
const header = pug.compile(read('tabby-core/src/components/tabHeader.component.pug'))({
    require: file => read(path.resolve('tabby-core/src/components', file)),
})
const terminalSchemes = { dark: schemes.defaultColorScheme, light: schemes.defaultLightColorScheme,
    custom: { ...schemes.defaultColorScheme, background: '#002b36', foreground: '#839496' } }
datasets['after-custom-false'] = variables(sources.after, 'dark', false, true, terminalSchemes.custom)
const uiFontCSS = [[400, 'Regular'], [600, 'Semibold']].map(([weight, name]) => {
    const file = coreRequire.resolve(`source-sans-pro/WOFF2/TTF/SourceSansPro-${name}.ttf.woff2`)
    return `@font-face{font-family:'Source Sans Pro';font-weight:${weight};src:url(data:font/woff2;base64,${fs.readFileSync(file).toString('base64')}) format('woff2')}`
}).join('\n')
const html = `<!doctype html><meta charset="utf-8"><title>Tabby tab strip fixture — simulated display only</title>
<style id="font">${uiFontCSS}</style><style id="component">${componentCSS}</style><style id="theme"></style><style>
body { margin:0 } pre { margin:0; padding:20px; font:16px/1.6 monospace }
/* Disable animation timing only in this static measurement fixture. */
* { transition:none !important; animation:none !important }
</style><app-root _nghost-root class="platform-linux"><div _ngcontent-root class="main content tabs-on-top">
<div _ngcontent-root class="tab-bar"><div _ngcontent-root class="inset background"></div><div _ngcontent-root class="tabs"></div><div _ngcontent-root class="btn-space background"></div>
<button _ngcontent-root class="btn btn-secondary btn-tab-bar" aria-label="New tab">+</button><window-controls _ngcontent-root _nghost-controls><button _ngcontent-controls aria-label="Minimize">−</button><button _ngcontent-controls aria-label="Maximize">□</button><button _ngcontent-controls aria-label="Close window">×</button></window-controls><div _ngcontent-root class="window-controls-spacer"></div></div>
<div _ngcontent-root class="content"><tab-body _ngcontent-root class="content-tab content-tab-active"><split-tab _nghost-split class="has-split-panes" style="height:100%"><div class="child focused" style="left:0;top:0;width:50%;height:100%"><pre></pre></div><div class="child" style="left:50%;top:0;width:50%;height:100%"><pre></pre></div><split-tab-spanner _nghost-spanner class="h" style="left:50%;top:0;height:100%"></split-tab-spanner><split-tab-pane-label _nghost-pane class="positioned focused" style="left:0;top:0;width:50%;height:100%"></split-tab-pane-label></split-tab></tab-body></div></div></app-root>
<script>
const css=${JSON.stringify(css)}, data=${JSON.stringify(datasets)}, schemes=${JSON.stringify(terminalSchemes)}, header=${JSON.stringify(header)};
const tabs=document.querySelector('.tabs');
for(let i=0;i<3;i++){
 const tab=document.createElement('tab-header');tab.setAttribute('_ngcontent-root','');tab.setAttribute('_nghost-header','');tab.tabIndex=0;tab.setAttribute('role','tab');tab.className=i===0?'active':'';tab.innerHTML=header;
 tab.querySelectorAll('.colorbar,.progressbar,profile-icon,.pin-indicator,ng-content').forEach(n=>n.remove());
 if(i!==2)tab.querySelector('.activity-indicator').remove();
 tab.querySelectorAll('.index')[1].remove();tab.querySelector('.index').textContent=i+1;
 tab.querySelector('.name').textContent=['SSH · production','Local terminal','Build output'][i];
 tab.querySelectorAll('button').forEach((n,j)=>n.setAttribute('aria-label',j?'Close tab':'Tab options'));
 tab.querySelectorAll('*').forEach(n=>n.setAttribute('_ngcontent-header',''));tabs.append(tab);
}
const headerTemplate=document.createElement('template');headerTemplate.innerHTML=header;
window.setTabState=(index,values)=>{
 const tab=tabs.children[index];
 for(const [key,selector] of [['activity','.activity-indicator'],['progress','.progressbar'],['color','.colorbar']]){
  if(!(key in values))continue;
  let node=tab.querySelector(selector);const visible=key==='activity'?values[key]:values[key]!=null;
  if(!visible){node?.remove();continue;}
  if(!node){node=headerTemplate.content.querySelector(selector).cloneNode(true);node.setAttribute('_ngcontent-header','');tab.prepend(node);}
  if(key==='progress')node.style.width=values[key]+'%';if(key==='color')node.style.backgroundColor=values[key];
 }
};
// Match the existing AppService presentation lifecycle; the real method and
// activity subjects are executed independently in desktop-uiux.test.mjs.
window.selectFixtureTab=index=>{
 const previous=[...tabs.children].find(n=>n.classList.contains('active'));
 if(previous&&previous!==tabs.children[index])previous.querySelector('.activity-indicator')?.remove();
 [...tabs.children].forEach((n,i)=>n.classList.toggle('active',i===index));
};
window.setPaneCount=(count,maximized=false)=>{
 const split=document.querySelector('split-tab');const template=split.querySelector('.child').cloneNode(true);
 split.querySelectorAll('.child,split-tab-pane-label,split-tab-spanner').forEach(n=>n.remove());
 split.classList.toggle('has-split-panes',count>1&&!maximized);
 for(let i=0;i<count;i++){
  const child=template.cloneNode(true);child.className='child'+(i===0?' focused':'')+(maximized?(i===0?' maximized':' minimized'):'');
  child.style.cssText=maximized&&i===0?'left:5%;top:5%;width:90%;height:90%':'left:'+i*100/count+'%;top:0;width:'+100/count+'%;height:100%';split.append(child);
  const label=document.createElement('split-tab-pane-label');label.setAttribute('_nghost-pane','');label.className='positioned'+(i===0?' focused':'')+(maximized&&i>0?' minimized':'');label.style.cssText=child.style.cssText;split.append(label);
  if(i>0&&!maximized){const spanner=document.createElement('split-tab-spanner');spanner.setAttribute('_nghost-spanner','');spanner.className='h';spanner.style.cssText='left:'+i*100/count+'%;top:0;height:100%';split.append(spanner);}
 }
};
window.setFixture=(version='after',mode='dark',position='top',vibrant=false,platform='linux',override=false,focused=true)=>{
 document.documentElement.style.cssText='';Object.entries(data[version+'-'+mode+'-'+vibrant]).forEach(([k,v])=>document.documentElement.style.setProperty(k,v));
 document.querySelector('#theme').textContent=css[version];
 const root=document.querySelector('app-root');root.className='platform-'+platform+(vibrant?' vibrant':'')+(focused?' window-focused':'');
 document.body.classList.toggle('tabby-desktop-theme',version==='after');
 document.querySelector('.tab-bar').classList.toggle('tab-bar-no-controls-overlay',platform==='darwin');
 document.querySelector('.inset').style.display=platform==='darwin'&&position==='top'?'':'none';
 document.querySelector('.window-controls-spacer').style.display=platform==='win32'&&position==='top'?'':'none';
 document.querySelector('window-controls').style.display=platform==='linux'&&(position==='top'||position==='bottom')?'flex':'none';
 root.style.cssText=override?'--tabby-tab-strip-bg:#225566;--tabby-tab-active-bg:#eeeeee;--tabby-tab-border:#ffffff':'';
 document.querySelector('.main').className='main content '+(position==='bottom'?'': 'tabs-on-'+position)+(['left','right'].includes(position)&&platform!=='darwin'?' tabs-titlebar-enabled':'');
 document.querySelectorAll('tab-header').forEach(n=>n.classList.toggle('vertical',position==='left'||position==='right'));
 document.querySelectorAll('pre').forEach(n=>n.style.color=schemes[mode].foreground);const pre=document.querySelector('pre');
 pre.textContent='$ ssh example.invalid\\nConnected to a public test fixture\\n$ tmux list-sessions\\nwork: 1 windows\\n\\nTerminal text and ANSI colors retain their configured values.';
};window.addEventListener('focus',()=>document.querySelector('app-root').classList.add('window-focused'));window.addEventListener('blur',()=>document.querySelector('app-root').classList.remove('window-focused'));window.setFixture();
</script>`
fs.writeFileSync(path.join(output, 'fixture.html'), html)
const report = { headSHA: git('rev-parse', 'HEAD'), treeSHA: git('rev-parse', 'HEAD^{tree}'), baseline,
    mode: 'Chrome fixture: actual theme service, Sass, Pug header and Angular style encapsulation',
    fullApplication: false, realXrdp: false, physical16BitDisplay: false,
    unchangedTerminalVariables: true, unchangedExternalThemes: true, platformClasses: ['linux', 'darwin', 'win32'], sourceDirty: !!git('status', '--porcelain'), states: [] }
let child, cdp, log
try {
    if (!process.argv.includes('--generate-only')) {
        const server = net.createServer()
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        const port = server.address().port
        await new Promise(resolve => server.close(resolve))
        const executable = process.env.TABBY_CHROME_BINARY || 'google-chrome'
        log = fs.openSync(path.join(output, 'browser.log'), 'w')
        child = spawn(executable, ['--headless', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
            `--user-data-dir=${path.join(scratch, 'profile')}`, pathToFileURL(path.join(output, 'fixture.html')).href], { detached: true, stdio: ['ignore', log, log] })
        let stopped = false, spawnError
        child.once('exit', () => { stopped = true })
        child.once('error', error => { stopped = true; spawnError = error })
        let target
        for (let attempt = 0; attempt < 60; attempt++) {
            if (stopped) { throw spawnError ?? new Error('Normal sandboxed Chrome exited; no policy override is attempted') }
            try {
                target = (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then(r => r.json())).find(x => x.type === 'page' && x.url.startsWith('file:'))
            } catch { /* Listener startup only. */ }
            if (target) { break }
            await delay(250)
        }
        assert(target, 'Normal Chrome did not start within 15 seconds')
        const socket = new WebSocket(target.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('CDP open timeout')), 5000)
            socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
            socket.addEventListener('error', error => { clearTimeout(timer); reject(error) }, { once: true })
        })
        let id = 0
        const pending = new Map()
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data), request = pending.get(message.id)
            if (!request) { return }
            pending.delete(message.id); clearTimeout(request.timer)
            message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result)
        })
        cdp = { close: () => socket.close(), request: (method, params = {}) => new Promise((resolve, reject) => {
            const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error(`CDP timeout: ${method}`)) }, 10000)
            pending.set(next, { resolve, reject, timer }); socket.send(JSON.stringify({ id: next, method, params }))
        }) }
        const evaluate = async expression => {
            const result = await cdp.request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
            assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value
        }
        report.browser = await cdp.request('Browser.getVersion')
        await cdp.request('Emulation.setDeviceMetricsOverride', { width: 960, height: 480, deviceScaleFactor: 1, mobile: false })
        await evaluate(`new Promise(resolve=>document.readyState==='complete'?resolve():window.addEventListener('load',resolve,{once:true}))`)
        await evaluate(`Promise.all([document.fonts.load('400 13px \"Source Sans Pro\"'),document.fonts.load('600 13px \"Source Sans Pro\"')])`)
        const snapshot = async label => {
            const state = await evaluate(`(() => {
                const describe=selector=>{const n=document.querySelector(selector);if(!n)return null;const s=getComputedStyle(n),r=n.getBoundingClientRect();return {bg:s.backgroundColor,fg:s.color,opacity:s.opacity,outline:s.outlineWidth,borderTop:s.borderTopWidth,borderBottom:s.borderBottomWidth,borderLeft:s.borderLeftWidth,borderRight:s.borderRightWidth,borderRadius:s.borderRadius,pointerEvents:s.pointerEvents,weight:s.fontWeight,visibility:s.visibility,display:s.display,height:r.height,x:r.x,y:r.y,width:r.width}};
                const pseudo=(selector)=>{const n=document.querySelector(selector);if(!n)return null;const s=getComputedStyle(n,'::after'),r=n.getBoundingClientRect();return {bg:s.backgroundColor,width:s.width,height:s.height,content:s.content,x:r.x+parseFloat(s.left||0),y:r.y+parseFloat(s.top||0)}};
                return {pane:describe('split-tab > .child:not(.focused)'),spanner:describe('split-tab-spanner'),splitLine:pseudo('split-tab-spanner'),paneMarker:pseudo('split-tab-pane-label'),focused:document.hasFocus(),strip:describe('.tab-bar'),spacer:describe('.btn-space'),active:describe('tab-header.active'),inactive:describe('tab-header:nth-child(2)'),index:describe('tab-header .index'),marker:describe('tab-header.active .current-tab-indicator'),inactiveMarker:describe('tab-header:nth-child(2) .current-tab-indicator'),inactiveIndex:describe('tab-header:nth-child(2) .index'),terminal:describe('tab-body'),buttons:describe('tab-header .buttons'),button:describe('tab-header button'),activityTab:describe('tab-header:nth-child(3)'),activityDot:describe('tab-header:nth-child(3) .activity-indicator'),profileColor:describe('tab-header:nth-child(3) .colorbar'),progress:describe('tab-header:nth-child(3) .progressbar')};
            })()`)
            const screenshot = await cdp.request('Page.captureScreenshot', { format: 'png' })
            fs.writeFileSync(path.join(output, `${label}.png`), Buffer.from(screenshot.data, 'base64'))
            report.states.push({ label, ...state }); return state
        }
        const expectedRGB = hex => `rgb(${coreRequire('color')(hex).rgb().array().join(', ')})`
        for (const mode of ['dark', 'light']) {
            await evaluate(`setFixture('before',${JSON.stringify(mode)})`); await snapshot(`${mode}-before-top`)
            for (const position of ['top', 'bottom', 'left', 'right']) {
                await cdp.request('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 950, y: 470 })
                await evaluate(`setFixture('after',${JSON.stringify(mode)},${JSON.stringify(position)})`)
                const state = await snapshot(`${mode}-after-${position}`), vars = datasets[`after-${mode}-false`]
                assert.equal(state.strip.bg, expectedRGB(vars['--tabby-tab-strip-bg']), `${mode} ${position}: opaque strip applies through Angular component specificity`)
                assert.equal(state.active.bg, expectedRGB(vars['--tabby-tab-active-bg']))
                assert.equal(state.inactive.fg, expectedRGB(vars['--tabby-tab-fg']))
                assert.equal(state.index.opacity, '1'); assert.equal(state.marker.height, 2)
                assert.equal(state.inactive.bg, expectedRGB(vars['--tabby-tab-inactive-bg']))
                assert.equal(state.inactiveMarker.display, 'none')
                assert.equal(state.active.height, 36, `${mode} ${position}: actual tab height`)
                assert.equal(state.pane.opacity, '1');assert.equal(state.spanner.width, 10);assert.equal(state.splitLine.width, '1px');assert.equal(state.paneMarker.height, '2px')
                assert.equal(state.terminal.bg, expectedRGB(terminalSchemes[mode].background))
                assert.equal(state.strip[{ top: 'borderBottom', bottom: 'borderTop', left: 'borderRight', right: 'borderLeft' }[position]], '0px')
            }
            await evaluate(`setFixture('after',${JSON.stringify(mode)})`)
            const r = await evaluate(`(()=>{const r=document.querySelector('tab-header:nth-child(2)').getBoundingClientRect();return {x:r.x+20,y:r.y+18}})()`)
            await cdp.request('Input.dispatchMouseEvent', { type: 'mouseMoved', ...r })
            const hover = await snapshot(`${mode}-after-hover`)
            assert.equal(hover.inactive.bg, expectedRGB(datasets[`after-${mode}-false`]['--tabby-tab-hover-bg']))
            const buttonRect = await evaluate(`(()=>{const r=document.querySelector('tab-header button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
            await cdp.request('Input.dispatchMouseEvent', { type: 'mouseMoved', ...buttonRect })
            const buttonHover = await snapshot(`${mode}-after-button-hover`)
            assert.equal(buttonHover.button.bg, expectedRGB(datasets[`after-${mode}-false`]['--tabby-tab-hover-bg']))
            assert.equal(buttonHover.button.fg, expectedRGB(datasets[`after-${mode}-false`]['--tabby-tab-hover-fg']))
            await cdp.request('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 950, y: 470 })
            await evaluate(`document.activeElement.blur();document.body.tabIndex=-1;document.body.focus()`)
            await cdp.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
            await cdp.request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
            const focus = await snapshot(`${mode}-after-keyboard-focus`)
            assert.equal(focus.buttons.visibility, 'visible'); assert.equal(focus.active.outline, '2px')
            await evaluate(`document.querySelector('tab-header:nth-child(2)').focus()`);
            const inactiveFocus = await snapshot(`${mode}-after-inactive-focus`);
            assert.equal(inactiveFocus.inactive.outline, '2px');assert.equal(inactiveFocus.inactiveMarker.display, 'none');assert.equal(inactiveFocus.inactive.bg, expectedRGB(datasets[`after-${mode}-false`]['--tabby-tab-inactive-bg']))
            await evaluate(`setFixture('after',${JSON.stringify(mode)},'top',true)`)
            const vibrant = await snapshot(`${mode}-after-vibrancy`)
            assert.equal(vibrant.strip.bg, expectedRGB(datasets[`after-${mode}-true`]['--tabby-tab-strip-bg']))
            await evaluate(`setFixture('after',${JSON.stringify(mode)},'top',false,'linux',true)`)
            assert.equal((await snapshot(`${mode}-after-custom-css`)).strip.bg, 'rgb(34, 85, 102)')
            for (const platform of ['darwin', 'win32']) {
                for (const position of ['top', 'bottom', 'left', 'right']) {
                    await evaluate(`setFixture('after',${JSON.stringify(mode)},${JSON.stringify(position)},false,${JSON.stringify(platform)})`)
                    const state = await snapshot(`${mode}-after-${platform}-${position}`)
                    assert.equal(state.strip.bg, expectedRGB(datasets[`after-${mode}-false`]['--tabby-tab-strip-bg']))
                    assert.equal(state.active.bg, expectedRGB(datasets[`after-${mode}-false`]['--tabby-tab-active-bg']))
                    assert.equal(state.inactive.bg, expectedRGB(datasets[`after-${mode}-false`]['--tabby-tab-inactive-bg']))
                    assert.equal(state.terminal.bg, expectedRGB(terminalSchemes[mode].background))
                    const reservation = await evaluate(`(()=>{const a=document.querySelector('tab-header').getBoundingClientRect();const b=document.querySelector('.window-controls-spacer').getBoundingClientRect();return {tabLeft:a.left,spacer:b.width}})()`);
                    if(position==='top'&&platform==='darwin')assert(reservation.tabLeft>=85, 'macOS traffic-light inset retained');
                    if(position==='top'&&platform==='win32')assert.equal(reservation.spacer,138, 'Windows caption overlay spacer retained');
                }
            }
            await evaluate(`setFixture('after',${JSON.stringify(mode)},'top',false,'linux',false,false)`)
            const blur = await snapshot(`${mode}-after-window-blur-state`)
            assert.equal(blur.marker.bg, expectedRGB(datasets[`after-${mode}-false`]['--tabby-tab-unfocused-marker']))
            assert.equal(blur.active.bg, expectedRGB(datasets[`after-${mode}-false`]['--tabby-tab-active-bg']))
            assert.equal(blur.inactive.bg, expectedRGB(datasets[`after-${mode}-false`]['--tabby-tab-inactive-bg']))
            for (const platform of ['linux', 'darwin', 'win32']) {
                const label = `${mode}-activity-${platform}`
                await cdp.request('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 950, y: 470 })
                await evaluate(`setFixture('after',${JSON.stringify(mode)},'top',false,${JSON.stringify(platform)});selectFixtureTab(0);setPaneCount(2);setTabState(2,{activity:false,progress:null,color:null})`)
                assert.equal((await snapshot(`${label}-idle`)).activityDot, null)
                await evaluate(`setTabState(2,{activity:true,progress:48,color:'#9f52ff'})`)
                const decorated = await snapshot(`${label}-decorated`)
                assert.equal(decorated.activityDot.width, 6); assert.equal(decorated.activityDot.height, 6)
                assert.equal(decorated.activityDot.borderRadius, '50%'); assert.equal(decorated.activityDot.pointerEvents, 'none')
                assert.equal(decorated.activityDot.bg, decorated.activityTab.fg)
                assert.equal(decorated.profileColor.bg, 'rgb(159, 82, 255)'); assert.equal(decorated.profileColor.height, 3)
                assert.equal(decorated.progress.height, 3)
                assert(Math.abs(decorated.progress.width - decorated.activityTab.width * .48) < .02)
                assert.equal(decorated.activityDot.y + 3, decorated.activityTab.y + decorated.activityTab.height / 2)
                assert(decorated.activityDot.y > decorated.progress.y + decorated.progress.height)
                assert(decorated.activityDot.y + 6 < decorated.profileColor.y, 'activity dot does not overlap progress or profile color')
                const point = { x: decorated.activityTab.x + 20, y: decorated.activityTab.y + 18 }
                await cdp.request('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
                const activityHover = await snapshot(`${label}-hover`)
                assert.equal(activityHover.activityDot.width, 6); assert.equal(activityHover.activityTab.bg, expectedRGB(datasets[`after-${mode}-false`]['--tabby-tab-hover-bg']))
                await cdp.request('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 950, y: 470 })
                await cdp.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
                await cdp.request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
                await evaluate(`document.querySelector('tab-header:nth-child(3)').focus()`)
                const activityFocus = await snapshot(`${label}-keyboard-focus`)
                assert.equal(activityFocus.activityTab.outline, '2px'); assert.equal(activityFocus.activityDot.width, 6)
                await evaluate(`selectFixtureTab(2)`)
                const selected = await snapshot(`${label}-selected`)
                assert.equal(selected.activityDot.display, 'none'); assert.equal(selected.marker.height, 2)
                assert.equal(selected.profileColor.bg, decorated.profileColor.bg); assert.equal(selected.progress.height, 3)
                await evaluate(`selectFixtureTab(0)`)
                assert.equal((await snapshot(`${label}-cleared`)).activityDot, null)
                await evaluate(`setPaneCount(1)`)
                assert.equal((await snapshot(`${label}-single-pane`)).paneMarker.content, 'none')
                await evaluate(`setPaneCount(2)`)
                assert.equal((await snapshot(`${label}-split-added`)).paneMarker.height, '2px')
                await evaluate(`setPaneCount(2,true)`)
                assert.equal((await snapshot(`${label}-maximized`)).paneMarker.content, 'none')
                await evaluate(`setPaneCount(2)`)
                assert.equal((await snapshot(`${label}-restored`)).paneMarker.height, '2px')
                await evaluate(`setPaneCount(1)`)
                assert.equal((await snapshot(`${label}-split-removed`)).paneMarker.content, 'none')
                await evaluate(`setPaneCount(2);setTabState(2,{activity:true,progress:null,color:null})`)
            }
        }
        for (const scale of [1, 1.25, 1.5, 2]) {
            for (const count of [2, 8, 20]) {
                const width = count === 2 ? 800 : count === 8 ? 1024 : 1920
                await cdp.request('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: scale, mobile: false })
                await evaluate(`setFixture('after','dark');(() => {const tabs=document.querySelector('.tabs');while(tabs.children.length>${count})tabs.lastElementChild.remove();while(tabs.children.length<${count}){const n=tabs.children[1].cloneNode(true);tabs.append(n)};tabs.scrollLeft=0})()`)
                const state = await snapshot(`dark-after-density-${count}-tabs-scale-${scale}`)
                assert(state.active.width >= 144 && state.active.height === 36)
                const geometry = await evaluate(`(()=>{const tabs=document.querySelector('.tabs');const root=document.querySelector('app-root');return {viewport:root.getBoundingClientRect().width,overflow:tabs.scrollWidth>tabs.clientWidth}})()`)
                assert.equal(geometry.viewport,width)
                if(count===20)assert(geometry.overflow,'large tab counts scroll instead of compressing below 144px')
            }
        }
        await cdp.request('Emulation.setDeviceMetricsOverride', { width: 960, height: 480, deviceScaleFactor: 1, mobile: false })
        await evaluate(`setFixture('after','custom')`)
        const custom = await snapshot('custom-after-top')
        assert.equal(custom.strip.bg, expectedRGB(datasets['after-custom-false']['--tabby-tab-strip-bg']))
        assert.equal(custom.terminal.bg, expectedRGB(terminalSchemes.custom.background))
        // A second real browser target can remove document focus. This does not
        // stand in for native window-manager or real xrdp focus validation.
        await evaluate(`setFixture('after','dark')`)
        const other = await cdp.request('Target.createTarget', { url: 'about:blank' })
        await cdp.request('Target.activateTarget', { targetId: other.targetId })
        await delay(200)
        const blurred = await snapshot('dark-after-document-blur')
        report.documentBlurObserved = !blurred.focused
        report.nativeWindowBlurVerified = false
        assert.equal(blurred.active.bg, expectedRGB(datasets['after-dark-false']['--tabby-tab-active-bg']))
        await cdp.request('Target.closeTarget', { targetId: other.targetId })
        report.passed = true
        console.log(`PASS actual tab CSS browser fixture: ${report.states.length} rendered states; default dark/light, geometry, hover, keyboard focus, vibrancy, custom CSS, unchanged terminal/external themes; shared macOS/Windows/Linux chrome; document blur observed: ${report.documentBlurObserved}`)
    } else { report.generatedOnly = true; console.log('Generated actual source fixture; no browser or physical/xrdp verification claimed') }
} catch (error) {
    report.passed = false; report.error = String(error)
    // This browser has only the generated public fixture and a fresh profile.
    // Keep startup diagnostics visible even if an artifact cannot be downloaded.
    const browserLog = path.join(output, 'browser.log')
    if (fs.existsSync(browserLog)) { console.error('Fixture Chrome diagnostics:\n' + fs.readFileSync(browserLog, 'utf8').slice(-8000)) }
    throw error
} finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    cdp?.close()
    if (child && child.exitCode === null && child.signalCode === null && child.pid) {
        const exited = new Promise(resolve => child.once('exit', resolve)); process.kill(-child.pid, 'SIGTERM')
        await Promise.race([exited, delay(2000)])
        if (child.exitCode === null && child.signalCode === null) { process.kill(-child.pid, 'SIGKILL'); await Promise.race([exited, delay(2000)]) }
    }
    if (log !== undefined) { fs.closeSync(log) }
    fs.rmSync(scratch, { recursive: true, force: true })
}
