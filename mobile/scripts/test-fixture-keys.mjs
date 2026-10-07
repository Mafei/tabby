/** Test-only OpenSSH serialization; preserves all 32 Ed25519 public bytes. */
import { createRequire } from 'node:module'
import { createCipheriv, createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const { pbkdf } = require('bcrypt-pbkdf') // Existing locked ssh2 dependency.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const uint32 = value => {
    const bytes = Buffer.alloc(4)
    bytes.writeUInt32BE(value)
    return bytes
}
const sshString = value => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    return Buffer.concat([uint32(bytes.length), bytes])
}

/** Optional seed is only for a deterministic, public test-key regression. */
export function generateFixtureEd25519 ({ passphrase, seed } = {}) {
    if (seed !== undefined && (!Buffer.isBuffer(seed) || seed.length !== 32)) { throw new Error('FIXTURE_INVALID_KEY_SEED') }
    if (passphrase !== undefined && (typeof passphrase !== 'string' || !passphrase.length)) { throw new Error('FIXTURE_INVALID_KEY_PASSPHRASE') }
    let privateKey
    if (seed) {
        const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed])
        try { privateKey = createPrivateKey({ key: der, type: 'pkcs8', format: 'der' }) } finally { der.fill(0) }
    } else {
        privateKey = generateKeyPairSync('ed25519').privateKey
    }
    const jwk = privateKey.export({ format: 'jwk' })
    const publicBytes = Buffer.from(jwk.x, 'base64url')
    const seedBytes = Buffer.from(jwk.d, 'base64url')
    jwk.d = ''
    if (publicBytes.length !== 32 || seedBytes.length !== 32) { seedBytes.fill(0); throw new Error('FIXTURE_INVALID_ED25519_WIDTH') }
    const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(publicBytes)])
    const secret = Buffer.concat([seedBytes, publicBytes])
    const check = randomBytes(4)
    const body = Buffer.concat([check, check, sshString('ssh-ed25519'), sshString(publicBytes), sshString(secret), sshString('')])
    secret.fill(0)
    seedBytes.fill(0)
    const blockSize = passphrase ? 16 : 8
    const padding = Buffer.from(Array.from({ length: (blockSize - body.length % blockSize) % blockSize }, (_, index) => index + 1))
    const padded = Buffer.concat([body, padding])
    body.fill(0)
    let payload = padded
    let kdfOptions = Buffer.alloc(0)
    if (passphrase) {
        const salt = randomBytes(16)
        const rounds = 16
        const keyAndIV = Buffer.alloc(48)
        const password = Buffer.from(passphrase)
        try {
            if (pbkdf(password, password.length, salt, salt.length, keyAndIV, keyAndIV.length, rounds) !== 0) {
                throw new Error('FIXTURE_KEY_ENCRYPTION_FAILED')
            }
            const cipher = createCipheriv('aes-256-cbc', keyAndIV.subarray(0, 32), keyAndIV.subarray(32))
            cipher.setAutoPadding(false)
            payload = Buffer.concat([cipher.update(padded), cipher.final()])
            kdfOptions = Buffer.concat([sshString(salt), uint32(rounds)])
        } finally { password.fill(0); keyAndIV.fill(0); padded.fill(0) }
    }
    const wire = Buffer.concat([Buffer.from('openssh-key-v1\0'), sshString(passphrase ? 'aes256-cbc' : 'none'),
        sshString(passphrase ? 'bcrypt' : 'none'), sshString(kdfOptions), uint32(1), sshString(publicBlob), sshString(payload)])
    const base64 = wire.toString('base64')
    wire.fill(0)
    payload.fill(0)
    return { public: `ssh-ed25519 ${publicBlob.toString('base64')}`,
        private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64.match(/.{1,64}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n` }
}
