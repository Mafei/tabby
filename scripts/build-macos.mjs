#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import { build as builder } from 'electron-builder'
import * as vars from './vars.mjs'
import path from 'node:path'
import { signMacNativeSources, signMacArtifactApp } from './macos-artifact.mjs'
import { isMacArtifactMode } from './macos-signing-policy.mjs'

const artifactOnly = isMacArtifactMode(process.env)
if (artifactOnly) { process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false' }

const isTag = (process.env.GITHUB_REF || '').startsWith('refs/tags/')

process.env.ARCH = process.env.ARCH || process.arch

if (process.env.GITHUB_HEAD_REF) {
    delete process.env.CSC_LINK
    delete process.env.CSC_KEY_PASSWORD
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
}

process.env.APPLE_ID ??= process.env.APPSTORE_USERNAME
process.env.APPLE_APP_SPECIFIC_PASSWORD ??= process.env.APPSTORE_PASSWORD

const options = {
    dir: true,
    mac: ['dmg', 'zip'],
    x64: process.env.ARCH === 'x86_64',
    arm64: process.env.ARCH === 'arm64',
    config: {
        extraMetadata: {
            version: vars.version,
            teamId: process.env.APPLE_TEAM_ID,
        },
        forceCodeSigning: !!process.env.CSC_LINK,
        mac: {
            identity: artifactOnly ? null : (!process.env.CI || process.env.CSC_LINK ? undefined : null),
            notarize: artifactOnly ? false : !!process.env.APPLE_TEAM_ID,
        },
        npmRebuild: process.env.ARCH !== 'arm64',
        publish: process.env.KEYGEN_TOKEN ? [
            vars.keygenConfig,
            {
                provider: 'github',
                channel: `latest-${process.env.ARCH}`,
            },
        ] : undefined,
    },
    publish: (process.env.KEYGEN_TOKEN && isTag) ? 'always' : 'never',
}

try {
    if (artifactOnly) {
        const entitlements = path.resolve('build/mac/entitlements.plist')
        const hostEntitlements = path.resolve('build/mac/entitlements.adhoc-host.plist')
        signMacNativeSources(['app/node_modules', 'builtin-plugins', 'extras'].map(root => path.resolve(root)), entitlements)
        // The directory build completes all bundle edits, including fuse changes.
        // PR builds skip electron-builder's normal signer, so sign explicitly
        // before creating archives. prepackaged prevents any later bundle edits.
        await builder({ ...options, mac: ['dir'] })
        const app = path.resolve(`dist/mac${process.env.ARCH === 'arm64' ? '-arm64' : ''}/Tabby.app`)
        signMacArtifactApp(app, entitlements, hostEntitlements)
        await builder({ ...options, prepackaged: app })
    } else {
        await builder(options)
    }
} catch (e) {
    console.error(e)
    process.exit(1)
}
