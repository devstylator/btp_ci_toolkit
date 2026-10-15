import crypto from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const DEV_FALLBACK_KEY = 'btp-ci-toolkit-local-development-key'

function getKey(): Buffer {
  let secret = process.env.SECRET_KEY
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SECRET_KEY environment variable is required in production')
    }
    secret = DEV_FALLBACK_KEY
  }
  return crypto.createHash('sha256').update(secret).digest()
}

/** Returns `iv.tag.ciphertext` (base64 parts). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.')
}

export function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split('.').map(p => Buffer.from(p, 'base64'))
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
