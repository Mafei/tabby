// Keep the Rocky-compatible payload separate from other desktop packaging jobs.
const FOREIGN_NATIVE = [
    // Linux listFonts never loads this Windows/macOS-only catalog addon.
    '!**/node_modules/fontmanager-redux/**/*',
    // Keep its Linux JS /proc wrapper; this package has native sources only on macOS/Windows.
    '!**/node_modules/native-process-working-directory/build/**/*',
    '!**/node_modules/**/prebuilds/{darwin-*,win32-*,linux-arm*,linux-ia32,android-*,freebsd-*}/**/*',
    '!**/node_modules/**/prebuilds/linux-x64/*musl*',
    '!**/node_modules/**/{*.darwin-*.node,*.win32-*.node,*.linux-arm*.node,*.linux-ia32*.node,*.linux-x64-musl.node}',
]

export function linuxPortableOptions (env, arch, baseFiles, baseResources = ['builtin-plugins', 'extras']) {
    const portable = env.TABBY_LINUX_PORTABLE === '1'
    if (env.TABBY_LINUX_PORTABLE && !portable) {
        throw new Error('TABBY_LINUX_PORTABLE must be 1 or unset')
    }
    if (portable && arch !== 'x64') {
        throw new Error('The Rocky portable baseline supports x64 only')
    }
    if (portable && (env.USE_HARD_LINKS === 'true' || env.VITEST !== undefined)) {
        throw new Error('Portable AppRun replacement requires normal copy mode')
    }
    if (!Array.isArray(baseFiles) || !baseFiles.every(x => typeof x === 'string')) {
        throw new Error('Expected the existing electron-builder file filters')
    }
    return {
        portable,
        targets: portable ? ['appimage', 'tar.gz'] : env.TABBY_ARTIFACT_ONLY ? ['tar.gz'] : ['deb', 'tar.gz', 'rpm', 'pacman', 'appimage'],
        files: portable ? [
            ...baseFiles,
            ...FOREIGN_NATIVE,
        ] : baseFiles,
        // extraResources bypasses the app's file filters. Preserve emitted
        // fonts/licenses while excluding other platforms' native prebuilds.
        extraResources: portable ? baseResources.map(resource => resource === 'builtin-plugins' ?
            { from: 'builtin-plugins', to: 'builtin-plugins', filter: ['**/*', ...FOREIGN_NATIVE,
                // Webpack emits the identical bytes under dist/fonts. Ship one copy.
                '!**/src/fonts/bundled/**/*'] } :
            resource === 'extras' ? { from: 'extras', to: 'extras', filter: ['**/*', '!**/*.{exe,dll}'] } : resource) : undefined,
    }
}
