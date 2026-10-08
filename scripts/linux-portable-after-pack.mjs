import { chmod, lstat, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function linuxAppRun (executableName) {
    if (!/^[A-Za-z0-9._-]+$/.test(executableName)) {
        throw new Error('Unsafe Linux executable name')
    }
    // electron-builder 26.16 copies appOutDir over its generated AppRun. Its
    // automatic namespace failure => sandbox disablement is deliberately absent.
    return `#!/bin/sh
set -eu
tabby_app_dir=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)
if [ -n "\${APPIMAGE:-}" ] && [ -n "\${APPDIR:-}" ] && [ "$(readlink -f -- "$APPDIR" 2>/dev/null || true)" = "$tabby_app_dir" ]; then
    :
else
    APPIMAGE="$tabby_app_dir/AppRun"
fi
APPDIR="$tabby_app_dir"
export APPDIR APPIMAGE
exec "$APPDIR/${executableName}" "$@"
`
}

export default async function afterLinuxPack (context) {
    if (context.electronPlatformName !== 'linux') {
        return
    }
    // Only distributable copies are changed. Hardlinks could chmod source assets.
    if (process.env.USE_HARD_LINKS === 'true' || process.env.VITEST !== undefined) {
        throw new Error('Public Linux resources require normal copy mode')
    }
    const root = path.resolve(context.appOutDir)
    const notices = path.join(root, 'resources', 'font-notices')
    const publicFiles = []
    async function collect (directory) {
        const info = await lstat(directory)
        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error('Public Linux resources require real directories')
        }
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name)
            const isNotice = file === notices || file.startsWith(notices + path.sep)
            const isFont = /\.(ttf|otf|woff2?|eot|ttc)$/i.test(entry.name)
            if (entry.isSymbolicLink()) {
                if (isNotice || isFont) {
                    throw new Error('Public Linux resource symlinks are unsupported')
                }
            } else if (entry.isDirectory()) {
                await collect(file)
            } else if (entry.isFile() && (isNotice || isFont)) {
                if ((await lstat(file)).nlink !== 1) {
                    throw new Error('Public Linux resources must not be hardlinked')
                }
                publicFiles.push(file)
            }
        }
    }
    await collect(root)
    const directories = new Set()
    for (const file of publicFiles) {
        await chmod(file, 0o644)
        let directory = path.dirname(file)
        while (true) {
            directories.add(directory)
            if (directory === root) { break }
            directory = path.dirname(directory)
        }
    }
    for (const directory of directories) {
        await chmod(directory, 0o755)
    }
    const appRun = path.join(root, 'AppRun')
    await writeFile(appRun, linuxAppRun(context.packager.executableName), { mode: 0o755 })
    await chmod(appRun, 0o755)
}
