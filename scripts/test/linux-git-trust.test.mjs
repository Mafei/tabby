import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('exact process-scoped checkout trust permits real build version and diff guards without trusting neighboring repositories', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tabby-git-trust-'))
    try {
        const globalConfig = path.join(directory, 'empty-global-config')
        writeFileSync(globalConfig, '# private fixture; must remain unchanged\n')
        const configBefore = readFileSync(globalConfig)
        const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
        Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig })
        function run (program, args, cwd, env = environment) {
            const result = spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout: 10000 })
            assert.ifError(result.error)
            return result
        }
        const git = (repository, args, env) => run('git', args, repository, env)
        function fixture (name) {
            const repository = path.join(directory, name)
            mkdirSync(repository)
            writeFileSync(path.join(repository, 'tracked.txt'), 'public build fixture\n')
            for (const args of [
                ['init', '--quiet'],
                ['add', '--', 'tracked.txt'],
                ['-c', 'user.name=Tabby Test', '-c', 'user.email=tabby-ci@example.invalid', 'commit', '--quiet', '-m', 'Public build fixture'],
                ['tag', 'v1.0.0'],
            ]) {
                assert.equal(git(repository, args).status, 0)
            }
            return repository
        }
        const checkout = fixture('checkout')
        const neighbor = fixture('neighbor')
        // Git's upstream test hook forces its ownership checks without changing
        // filesystem owners, capabilities, kernel policy or user configuration.
        const mismatched = { ...environment, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }
        const trusted = { ...mismatched, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: checkout }
        const rejected = git(checkout, ['describe', '--tags'], mismatched)
        assert.equal(rejected.status, 128)
        assert.match(rejected.stderr, /dubious ownership/)
        assert.equal(git(checkout, ['describe', '--tags'], trusted).stdout.trim(), 'v1.0.0')
        // The actual build import runs git describe in its child process and must
        // inherit the same command-scope trust; no fallback version is accepted.
        const version = run(process.execPath, ['--input-type=module', '-e',
            'const { version } = await import(process.argv[1]); process.stdout.write(version)',
            new URL('../vars.mjs', import.meta.url).href,
        ], checkout, trusted)
        assert.equal(version.status, 0)
        assert.equal(version.stdout, '1.0.0')
        assert.equal(git(checkout, ['diff', '--exit-code'], trusted).status, 0)
        writeFileSync(path.join(checkout, 'tracked.txt'), 'changed public fixture\n')
        assert.equal(git(checkout, ['diff', '--exit-code'], trusted).status, 1)
        const outside = git(neighbor, ['describe', '--tags'], trusted)
        assert.equal(outside.status, 128)
        assert.match(outside.stderr, /dubious ownership/)
        assert.equal(git(checkout, ['describe', '--tags'], mismatched).status, 128)
        assert.deepEqual(readFileSync(globalConfig), configBefore)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
