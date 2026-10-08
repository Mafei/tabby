import { readFileSync } from 'node:fs'
import jsYaml from 'js-yaml'
import * as vars from './vars.mjs'
import { linuxPortableOptions } from './linux-portable-options.mjs'
import afterLinuxPack from './linux-portable-after-pack.mjs'

// electron-builder reads this as its sole portable configuration file. Replace
// array fields before its normal merge, so every resource has one copy owner.
export default function linuxPortableConfig () {
    const base = jsYaml.load(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
    const options = linuxPortableOptions(process.env, process.env.ARCH || process.arch, base.files, base.extraResources)
    if (!options.portable) {
        throw new Error('LINUX_PORTABLE_CONFIG_REQUIRED')
    }
    return {
        ...base,
        npmRebuild: false,
        files: options.files,
        extraResources: options.extraResources,
        afterPack: afterLinuxPack,
        extraMetadata: { ...base.extraMetadata, version: vars.version },
        publish: null,
    }
}
