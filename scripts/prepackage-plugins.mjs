#!/usr/bin/env node
import { rebuild } from '@electron/rebuild'
import sh from 'shelljs'
import path from 'node:path'
import fs from 'node:fs'
import * as vars from './vars.mjs'
import log from 'npmlog'

import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))


let target = path.resolve(__dirname, '../builtin-plugins')
sh.mkdir('-p', target)
fs.writeFileSync(path.join(target, 'package.json'), '{}')
sh.cd(target)
for (const plugin of vars.builtinPlugins) {
    if (plugin === 'tabby-web') {
        continue
    }
    log.info('install', plugin)
    sh.cp('-r', path.join('..', plugin), '.')
    sh.rm('-rf', path.join(plugin, 'node_modules'))
    sh.cd(plugin)
    sh.exec(`yarn install --force --production${process.env.TABBY_LINUX_PORTABLE === '1' ? ' --frozen-lockfile --non-interactive' : ''}`, { fatal: true })


    log.info('rebuild', 'native')
    if (fs.existsSync('node_modules')) {
        await rebuild({
            buildPath: path.resolve('.'),
            electronVersion: vars.electronVersion,
            arch: process.env.ARCH ?? process.arch,
            force: true,
            useCache: false,
            ...(process.env.TABBY_LINUX_PORTABLE === '1' ? { ignoreModules: ['fontmanager-redux', 'native-process-working-directory'] } : {}),
        })
    }
    sh.cd('..')
}
fs.unlinkSync(path.join(target, 'package.json'), '{}')
