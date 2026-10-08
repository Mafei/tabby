#!/usr/bin/env node
/** Bounded startup checks for this workflow's disposable AOSP emulator. */
import { availableParallelism } from 'node:os'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { Android, TestFailure, check, cancelCommands } from './test-android-utils.mjs'

const BUDGET_MS = 240000
const STABLE_MS = 350
const identities = new WeakMap()

function text (value) {
    return typeof value === 'string' && Buffer.byteLength(value) <= 1024 * 1024
        ? value.replaceAll('\r\n', '\n') : ''
}

function unique (body, expression) {
    const matches = [...body.matchAll(expression)]
    return matches.length === 1 ? matches[0][1] : undefined
}

function boolean (value) { return value === 'true' ? true : value === 'false' ? false : null }
function id (value) {
    const number = /^\d+$/.test(value || '') ? Number(value) : NaN
    return Number.isSafeInteger(number) && number <= 1000000 ? number : null
}

function category (value) {
    if (value === undefined || value.trim() === '') { return 'UNKNOWN' }
    const name = value.trim()
    if (name === 'null' || name === '<none>') { return 'NONE' }
    // Error titles contain the affected package: classify them first.
    if (/\bApplication Not Responding: /.test(name)) { return 'ANR' }
    if (/\bApplication Error: /.test(name)) { return 'CRASH' }
    if (/\bError Dialog\b/.test(name)) { return 'ERROR' }
    if (/\bKeyguard\b|\bBouncer\b/.test(name)) { return 'KEYGUARD' }
    if (/^Window\{[a-f0-9]+ u\d+ (?:StatusBar|NotificationShade)\}$/.test(name)
        || /^[a-f0-9]+ (?:StatusBar|NotificationShade)$/.test(name)) { return 'SYSTEM_UI' }
    if (/(?:^|[ \t{])com\.android\.launcher3\/(?:com\.android\.launcher3\.|\.)(?:Launcher|uioverrides\.QuickstepLauncher)(?=[ \t}'\]]|$)/.test(name)) { return 'LAUNCHER' }
    return 'OTHER'
}

function blocks (body, expression) {
    const matches = [...body.matchAll(expression)]
    return matches.map((match, index) => ({ value: match[1], body: body.slice(match.index + match[0].length, matches[index + 1]?.index) }))
}

function section (body, name) {
    const expression = new RegExp(`^([ \\t]*)${name}:[ \\t]*(<none>)?[ \\t]*$`, 'gm')
    const matches = [...body.matchAll(expression)]
    if (matches.length !== 1) { return '' }
    const match = matches[0]
    if (match[2]) { return '<none>' }
    const lines = body.slice(match.index + match[0].length).split('\n')
    const output = []
    for (const line of lines) {
        if (line.trim() && (line.match(/^[ \t]*/)?.[0].length || 0) <= match[1].length) { break }
        output.push(line)
    }
    return output.join('\n')
}

function inputRow (body, name, display) {
    const content = section(body, name)
    if (content === '<none>') { return { category: 'NONE', result: 'UNKNOWN' } }
    const expression = name === 'FocusedApplications'
        ? /^[ \t]*displayId=(\d+), name='(.*)', dispatchingTimeout=\d+ms[ \t]*$/gm
        : name === 'FocusRequests'
            ? /^[ \t]*displayId=(\d+), name='(.*)'[ \t]*,?[ \t]+result='([^']*)'[ \t]*$/gm
            : /^[ \t]*displayId=(\d+), name='(.*)'[ \t]*$/gm
    const rows = [...content.matchAll(expression)].filter(match => id(match[1]) === display)
    if (rows.length !== 1 || display === null) { return { category: 'UNKNOWN', result: 'UNKNOWN' } }
    return { category: category(rows[0][2]), name: rows[0][2],
        result: ['OK', 'NO_WINDOW', 'NOT_FOCUSABLE', 'NOT_VISIBLE'].includes(rows[0][3]) ? rows[0][3] : 'UNKNOWN' }
}

/** AOSP InputDispatcher::dump appends a second, historical dump after an ANR. */
function currentInput (dump) {
    const starts = [...dump.matchAll(/^[ \t]*Input Dispatcher State:[ \t]*$/gm)]
    const history = [...dump.matchAll(/^[ \t]*Input Dispatcher State at time of last ANR:[ \t]*$/gm)]
    if (starts.length !== 1 || history.length > 1 || (history.length && history[0].index <= starts[0].index)) { return '' }
    return dump.slice(starts[0].index + starts[0][0].length, history[0]?.index)
}

/** Only fixed categories, nullable booleans and bounded display IDs escape. */
export function bootStateResult ({ windows, displays, input, activities }) {
    windows = text(windows); displays = text(displays); input = currentInput(text(input))
    activities = text(activities)
    const displayBlocks = blocks(displays, /^[ \t]*Display: mDisplayId=(\d+)\b[^\n]*$/gm).filter(block => id(block.value) === 0)
    const display = displayBlocks.length === 1 ? displayBlocks[0].body : ''
    const focused = unique(display, /^[ \t]*mCurrentFocus=([^\n]*)$/gm)
    const focusedApp = unique(display, /^[ \t]*mFocusedApp=([^\n]*)$/gm)
    const records = [...windows.matchAll(/(?:^|\n)[ \t]*Window #\d+ (Window\{[^\n]*\}):([\s\S]*?)(?=\n[ \t]*Window #\d+ |$)/g)]
    const selected = records.filter(record => record[1] === focused?.trim())
    const record = selected.length === 1 ? selected[0] : undefined
    const body = record?.[2] || ''
    const recordID = id(unique(body, /^[ \t]*mDisplayId=(\d+)\b[^\n]*$/gm))
    const inputDisplay = id(unique(input, /^[ \t]*FocusedDisplayId:[ \t]*(\d+)[ \t]*$/gm))
    const inputWindow = inputRow(input, 'FocusedWindows', 0)
    const inputApp = inputRow(input, 'FocusedApplications', 0)
    const request = inputRow(input, 'FocusRequests', 0)
    // WindowState.getName() is its identity hash followed by its window tag.
    const name = /^Window\{([a-f0-9]+) u\d+ ([^{}]+)\}$/.exec(record?.[1] || '')
    const nativeName = name ? `${name[1]} ${name[2]}` : undefined
    const activityBlocks = blocks(activities, /^[ \t]*Display #(\d+) \(activities from top to bottom\):[ \t]*$/gm).filter(block => id(block.value) === recordID)
    const activity = activityBlocks.length === 1 ? activityBlocks[0].body : ''
    const resumed = unique(activity, /^[ \t]*Resumed: ([^\n]*)$/gm)
    const visibility = value => boolean(unique(value, /\bisVisible=(true|false)\b/g))
    const errorCategory = value => ['ANR', 'CRASH', 'ERROR'].includes(value)
    const visibleError = records.some(record => errorCategory(category(record[1]))
        && visibility(record[2]) === true)
    const focusCategories = [category(focused), category(focusedApp), inputWindow.category, inputApp.category, request.category, category(resumed)]
    const focusError = focusCategories.some(errorCategory)
    const errorsKnown = windows.startsWith('WINDOW MANAGER WINDOWS (dumpsys window windows)\n')
        && records.length > 0 && displayBlocks.length === 1 && input !== ''
        && focusCategories.every(value => value !== 'UNKNOWN')
        && records.filter(record => errorCategory(category(record[1]))).every(record => visibility(record[2]) !== null)
    const draw = unique(body, /\bmDrawState=([A-Z_]+)\b/g)
    const windowType = unique(body, /\bmAttrs=\{[^\n]*\bty=([A-Z_]+|\d+)\b/g)
    const state = {
        displayId: recordID,
        wmsWindow: category(focused), wmsApplication: category(focusedApp),
        inputWindow: inputWindow.category, inputApplication: inputApp.category,
        inputRequest: request.category, inputRequestResult: request.result,
        inputFocusedDisplayId: inputDisplay,
        inputDispatchEnabled: boolean(unique(input, /^[ \t]*DispatchEnabled:[ \t]*(true|false)[ \t]*$/gm)),
        inputDispatchFrozen: boolean(unique(input, /^[ \t]*DispatchFrozen:[ \t]*(true|false)[ \t]*$/gm)),
        sameInputWindow: nativeName === undefined ? null : inputWindow.name === nativeName && request.name === nativeName,
        activityResumed: category(resumed),
        windowMain: windowType === undefined ? null : ['BASE_APPLICATION', '1'].includes(windowType),
        windowSurface: boolean(unique(body, /\bmHasSurface=(true|false)\b/g)),
        windowReadyForDisplay: boolean(unique(body, /\bisReadyForDisplay\(\)=(true|false)\b/g)),
        windowVisible: visibility(body),
        surfaceShown: boolean(unique(body, /\bSurface: shown=(true|false)\b/g)),
        windowDrawState: ['NO_SURFACE', 'DRAW_PENDING', 'COMMIT_DRAW_PENDING', 'READY_TO_SHOW', 'HAS_DRAWN'].includes(draw) ? draw : 'UNKNOWN',
        currentError: visibleError || focusError ? true : errorsKnown ? false : null,
    }
    if (nativeName !== undefined) { identities.set(state, nativeName) }
    return state
}

export function launcherReady (state) {
    return state.displayId === 0 && state.inputFocusedDisplayId === 0 && state.currentError === false
        && ['wmsWindow', 'wmsApplication', 'inputWindow', 'inputApplication', 'inputRequest', 'activityResumed'].every(key => state[key] === 'LAUNCHER')
        && state.inputRequestResult === 'OK' && state.inputDispatchEnabled === true && state.inputDispatchFrozen === false
        && state.sameInputWindow === true && state.windowMain === true && state.windowSurface === true
        && state.windowReadyForDisplay === true && state.windowVisible === true && state.surfaceShown === true
        && state.windowDrawState === 'HAS_DRAWN'
}

/** AOSP KeyguardServiceDelegate.dump: unique delegate and direct fields only. */
function keyguardDirectFields (dump) {
    const body = text(dump)
    const headers = [...body.matchAll(/^([ \t]*)KeyguardServiceDelegate[ \t]*$/gm)]
    let direct = ''
    if (headers.length === 1) {
        const header = headers[0]
        const indent = header[1].length
        for (const line of body.slice(header.index + header[0].length).split('\n')) {
            const depth = line.match(/^[ \t]*/)?.[0].length || 0
            if (line.trim() && depth <= indent) { break }
            if (depth === indent + 2) { direct += line.trim() + '\n' }
        }
    }
    return direct
}

export function keyguardPolicyResult (dump) {
    const direct = keyguardDirectFields(dump)
    const value = name => unique(direct, new RegExp(`^${name}=([^\\n]*)$`, 'gm'))
    const result = Object.fromEntries(['showing', 'secure', 'occluded', 'deviceHasKeyguard', 'enabled', 'bootCompleted']
        .map(name => [name, boolean(value(name))]))
    const screen = value('screenState'); const interactive = value('interactiveState')
    result.screenState = ['SCREEN_STATE_OFF', 'SCREEN_STATE_TURNING_ON', 'SCREEN_STATE_ON', 'SCREEN_STATE_TURNING_OFF'].includes(screen) ? screen : 'UNKNOWN'
    result.interactiveState = ['INTERACTIVE_STATE_SLEEP', 'INTERACTIVE_STATE_WAKING', 'INTERACTIVE_STATE_AWAKE', 'INTERACTIVE_STATE_GOING_TO_SLEEP'].includes(interactive) ? interactive : 'UNKNOWN'
    return result
}

/** Read-only blank-emulator diagnostics; no raw component, title or policy value escapes. */
export function bootSchemaResult (policy, home) {
    const fields = keyguardDirectFields(policy)
    const fieldKind = name => {
        const values = [...fields.matchAll(new RegExp(`^${name}=([^\\n]*)$`, 'gm'))]
        return values.length === 0 ? 'MISSING' : values.length !== 1 ? 'DUPLICATE'
            : boolean(values[0][1]) === null ? 'OTHER' : 'BOOLEAN'
    }
    const knownHomes = new Map([
        ['com.android.launcher3/.Launcher', 'AOSP_LAUNCHER'],
        ['com.android.launcher3/com.android.launcher3.Launcher', 'AOSP_LAUNCHER'],
        ['com.android.launcher3/.uioverrides.QuickstepLauncher', 'AOSP_QUICKSTEP'],
        ['com.android.launcher3/com.android.launcher3.uioverrides.QuickstepLauncher', 'AOSP_QUICKSTEP'],
        ['com.google.android.apps.nexuslauncher/.NexusLauncherActivity', 'GOOGLE_LAUNCHER'],
        ['com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity', 'GOOGLE_LAUNCHER'],
    ])
    const components = text(home).split('\n').map(line => line.trim())
        .filter(line => /^[a-zA-Z][a-zA-Z0-9_.]*\/[a-zA-Z.][a-zA-Z0-9_.$]*$/.test(line))
    return { home: components.length !== 1 ? 'UNKNOWN' : knownHomes.get(components[0]) || 'OTHER',
        secureFields: Object.fromEntries(['secure', 'isSecure', 'mIsSecure', 'secureForCurrentUser'].map(name => [name, fieldKind(name)])) }
}

export function keyguardReady (state, policy) {
    // Only the exact SystemUI shade/status-bar titles are eligible. KEYGUARD
    // remains a diagnostic category, never permission to send this key.
    // The delegate reports cached policy; this is not a fresh secure-state query.
    // No focus request
    // or secure-lock dismissal is performed by this one ordinary MENU event.
    return policy.secure === false && policy.showing === true && policy.occluded === false
        && policy.deviceHasKeyguard === true && policy.enabled === true && policy.bootCompleted === true
        && policy.screenState === 'SCREEN_STATE_ON' && policy.interactiveState === 'INTERACTIVE_STATE_AWAKE'
        && state.displayId === 0 && state.inputFocusedDisplayId === 0 && state.currentError === false
        && ['wmsWindow', 'inputWindow', 'inputRequest'].every(key => state[key] === 'SYSTEM_UI')
        && ['wmsApplication', 'inputApplication', 'activityResumed'].every(key => ['LAUNCHER', 'KEYGUARD', 'SYSTEM_UI', 'NONE'].includes(state[key]))
        && state.inputRequestResult === 'OK' && state.inputDispatchEnabled === true && state.inputDispatchFrozen === false
        && state.sameInputWindow === true && state.windowSurface === true && state.windowReadyForDisplay === true
        && state.windowVisible === true && state.surfaceShown === true && state.windowDrawState === 'HAS_DRAWN'
}

export function preMenuTarget (state, policy) {
    const knownPolicy = ['showing', 'secure', 'occluded', 'deviceHasKeyguard', 'enabled', 'bootCompleted']
        .every(key => typeof policy[key] === 'boolean')
    // The cached secure flag can remain true after boot even with an unlocked
    // Launcher. Its full live focus/drawing checks and showing=false authorize
    // only the ordinary MENU event; the keyguard path still requires secure=false.
    if (knownPolicy && policy.showing === false && policy.bootCompleted === true
        && policy.screenState === 'SCREEN_STATE_ON' && policy.interactiveState === 'INTERACTIVE_STATE_AWAKE'
        && launcherReady(state)) { return 'LAUNCHER' }
    return keyguardReady(state, policy) ? 'KEYGUARD' : undefined
}

export function hostCapacity (cpus, meminfo) {
    const kib = name => {
        const value = unique(meminfo, new RegExp(`^${name}:[ \\t]*(\\d+)[ \\t]+kB[ \\t]*$`, 'gm'))
        const number = value === undefined ? NaN : Number(value)
        return Number.isSafeInteger(number) && number >= 0 ? Math.floor(number / 1024) : null
    }
    return { availableCPUs: Number.isSafeInteger(cpus) && cpus >= 0 ? cpus : null,
        totalMiB: kib('MemTotal'), availableMiB: kib('MemAvailable'), emulatorCPUs: 4, emulatorMiB: 4096 }
}

async function capacity () {
    const state = hostCapacity(availableParallelism(), await readFile('/proc/meminfo', 'utf8'))
    console.log(`Android emulator host capacity: ${JSON.stringify(state)}`)
    // Leave at least 2 GiB available for the host beside the 4 GiB guest.
    check(state.availableCPUs >= 4 && state.totalMiB >= 8192 && state.availableMiB >= 6144, 'ANDROID_EMULATOR_HOST_CAPACITY_INSUFFICIENT')
}

/** One original startup budget; unknown states never satisfy readiness. */
export async function waitForBoot (android, api, { now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), report = () => {}, isCancelled = () => false } = {}) {
    const started = now()
    const deadline = started + BUDGET_MS
    let booted = false
    let menuSent = false
    let stableSince
    let stableIdentity
    let lastState
    let lastPolicy
    let lastSchema
    let home = ''
    let beforeMenu
    let preMenuSince
    let preMenuIdentity
    const inTime = () => {
        check(!isCancelled(), 'ANDROID_BOOT_CANCELLED')
        check(now() < deadline, 'ANDROID_BOOT_READINESS_DEADLINE_EXCEEDED')
    }
    async function shell (command) {
        check(!isCancelled(), 'ANDROID_BOOT_CANCELLED')
        const remaining = Math.floor(deadline - now())
        check(remaining > 0, 'ANDROID_BOOT_READINESS_DEADLINE_EXCEEDED')
        const result = await android.shell(command, { timeout: Math.min(5000, remaining), maxOutputBytes: 1024 * 1024 })
        inTime()
        return result
    }
    try {
        inTime()
        while (now() < deadline) {
            if (!booted) {
                let complete
                try { complete = await shell('getprop sys.boot_completed') } catch (error) {
                    inTime()
                    if (!(error instanceof TestFailure)) { throw error }
                }
                if (complete === '1') {
                    check(await shell('getprop ro.build.version.sdk') === String(api), 'ANDROID_BOOT_API_MISMATCH')
                    check((await shell('getprop ro.boot.qemu') || await shell('getprop ro.kernel.qemu')) === '1', 'ANDROID_BOOT_REQUIRES_EMULATOR')
                    booted = true
                    // Observe the system HOME on this disposable emulator before
                    // installing any app. It does not alter readiness or input.
                    try { home = await shell('cmd package resolve-activity --brief --user 0 -a android.intent.action.MAIN -c android.intent.category.HOME') }
                    catch (error) { inTime(); if (!(error instanceof TestFailure)) { throw error } }
                }
            }
            if (booted) {
                const commands = { windows: 'dumpsys window windows', displays: 'dumpsys window displays',
                    input: 'dumpsys input', activities: 'dumpsys activity activities',
                    ...(!menuSent ? { policy: 'dumpsys window policy' } : {}) }
                const readings = await Promise.allSettled(Object.values(commands).map(shell))
                inTime()
                const dumps = Object.fromEntries(Object.keys(commands).map((name, index) => [name,
                    readings[index].status === 'fulfilled' ? readings[index].value : '']))
                lastState = bootStateResult(dumps)
                if (!menuSent) { lastPolicy = keyguardPolicyResult(dumps.policy); lastSchema = bootSchemaResult(dumps.policy, home) }
                check(lastState.currentError !== true, 'ANDROID_BOOT_CURRENT_ERROR_DIALOG')
                if (!menuSent) {
                    const target = preMenuTarget(lastState, lastPolicy)
                    const identity = target ? `${target}:${identities.get(lastState)}:${JSON.stringify(lastPolicy)}` : undefined
                    if (!target) { preMenuSince = undefined; preMenuIdentity = undefined }
                    else if (preMenuSince === undefined || preMenuIdentity !== identity) { preMenuSince = now(); preMenuIdentity = identity }
                    else if (now() - preMenuSince >= STABLE_MS) {
                        inTime()
                        beforeMenu = { elapsedMs: Math.min(BUDGET_MS, Math.max(0, Math.floor(now() - started))), target,
                            state: lastState, keyguard: lastPolicy }
                        // Readiness is proven before the existing single event;
                        // a no-focused-window startup cannot enqueue this key.
                        menuSent = true
                        await shell('input keyevent 82')
                        stableSince = undefined
                    }
                } else if (menuSent && launcherReady(lastState)) {
                    const identity = identities.get(lastState)
                    if (stableSince === undefined || stableIdentity !== identity) { stableSince = now(); stableIdentity = identity }
                    if (now() - stableSince >= STABLE_MS) {
                        inTime()
                        report({ status: 'READY', api, menuSent, beforeMenu, state: lastState, schema: lastSchema })
                        return
                    }
                } else { stableSince = undefined; stableIdentity = undefined }
            }
            inTime()
            const remaining = Math.floor(deadline - now())
            check(remaining > 0, 'ANDROID_BOOT_READINESS_DEADLINE_EXCEEDED')
            await sleep(Math.min(100, remaining))
            inTime()
        }
        throw new TestFailure('ANDROID_BOOT_READINESS_DEADLINE_EXCEEDED')
    } catch (error) {
        report({ status: 'FAILED', api, menuSent, beforeMenu: beforeMenu || null, state: lastState || null,
            keyguard: lastPolicy || null, schema: lastSchema || null })
        throw error
    }
}

async function main () {
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--check-capacity') { await capacity(); return }
    check(args.length === 4 && args[0] === '--serial' && /^emulator-\d+$/.test(args[1]) && args[2] === '--api' && /^(31|32|33|34|35|36|37)$/.test(args[3]), 'ANDROID_BOOT_INVALID_ARGUMENTS')
    let cancelled = false
    const cancel = () => { cancelled = true; cancelCommands() }
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
    try {
        await waitForBoot(new Android(args[1]), Number(args[3]), { isCancelled: () => cancelled,
            report: value => console.log(`Android emulator boot state: ${JSON.stringify(value)}`) })
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(`Android emulator preparation failed: ${error instanceof TestFailure ? error.code : 'ANDROID_BOOT_UNEXPECTED_FAILURE'}`)
        process.exitCode = 1
    })
}
