#!/usr/bin/env node
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import { build as builder } from 'electron-builder'
import { readFileSync } from 'node:fs'
import jsYaml from 'js-yaml'
import * as vars from './vars.mjs'
import { linuxPortableOptions } from './linux-portable-options.mjs'
import afterLinuxPack from './linux-portable-after-pack.mjs'

const isTag = (process.env.GITHUB_REF || '').startsWith('refs/tags/')

process.env.ARCH = (process.env.ARCH || process.arch) === 'arm' ? 'armv7l' : process.env.ARCH || process.arch
const baseConfig = jsYaml.load(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
const options = linuxPortableOptions(process.env, process.env.ARCH, baseConfig.files, baseConfig.extraResources)

builder({
    dir: true,
    linux: options.targets,
    armv7l: process.env.ARCH === 'armv7l',
    arm64: process.env.ARCH === 'arm64',
    // Portable resources replace the YAML arrays in one explicit config source.
    // Merging object overrides into the auto-loaded YAML concatenates those
    // arrays and makes generic and filtered copies write the same destination.
    config: options.portable ? './scripts/linux-portable-config.mjs' : {
        npmRebuild: false,
        files: options.files,
        ...(options.extraResources ? { extraResources: options.extraResources } : {}),
        afterPack: afterLinuxPack,
        extraMetadata: {
            version: vars.version,
        },
        publish: !options.portable && process.env.KEYGEN_TOKEN ? [
            vars.keygenConfig,
            {
                provider: 'github',
                channel: `latest-${process.env.ARCH}`,
            },
        ] : undefined,
    },
    publish: (!options.portable && process.env.KEYGEN_TOKEN && isTag) ? 'always' : 'never',
}).catch(e => {
    console.error(e)
    process.exit(1)
})
