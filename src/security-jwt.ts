import { constants, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { ConfigError } from './errors.js'
import type { SecurityEndpoint } from './security-config.js'

type Policy = NonNullable<SecurityEndpoint['jwt']>
const hashes = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512' } as const

export function jwtKey(policy?: Policy): KeyObject | undefined {
  if (!policy?.verification) return undefined
  const pem = process.env[policy.verification.publicKeyEnv]?.trim()
  if (!pem || pem.length > 16_384 || !/^-----BEGIN (?:RSA )?PUBLIC KEY-----[\s\S]+-----END (?:RSA )?PUBLIC KEY-----$/.test(pem)) {
    throw new ConfigError('JWT verification requires a PEM RSA public key in the configured environment variable.')
  }
  try {
    const key = createPublicKey(pem)
    if (key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) return key
  } catch {
    // Keep configuration errors independent of the supplied key bytes.
  }
  throw new ConfigError('JWT verification requires a valid RSA public key of at least 2048 bits.')
}

function objectPart(value: string): Record<string, unknown> | undefined {
  try {
    const data: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>
  } catch {
    // Invalid token input is represented by an empty result.
  }
  return undefined
}

export function jwtPolicy(token: unknown, policy: Policy, key?: KeyObject): string | undefined {
  if (typeof token !== 'string' || token.length > 8192) return 'The configured field did not contain bounded JWT metadata.'
  const parts = token.split('.')
  const [header, payload, signature] = parts
  if (parts.length !== 3 || !header || !payload || !signature ||
      !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part) && Buffer.from(part, 'base64url').toString('base64url') === part)) {
    return 'The configured field did not contain a compact JWT.'
  }
  const metadata = objectPart(header)
  const claims = objectPart(payload)
  if (!metadata || !claims) return 'The token header or claims were not valid JSON objects.'
  const algorithm = metadata.alg
  if (typeof algorithm !== 'string' || !algorithm || algorithm.toLowerCase() === 'none' ||
      (policy.algorithms && !policy.algorithms.some(value => value === algorithm))) {
    return 'The token algorithm did not match policy.'
  }
  if (metadata.crit !== undefined || metadata.b64 === false) return 'The token uses unsupported JOSE header extensions.'
  if (policy.verification && (!key || algorithm !== policy.verification.algorithm ||
      !verify(hashes[policy.verification.algorithm], Buffer.from(`${header}.${payload}`), {
        key, padding: constants.RSA_PKCS1_PADDING,
      }, Buffer.from(signature, 'base64url')))) return 'The signature did not verify with the configured public key and algorithm.'
  if (policy.requiredClaims.some(claim => !Object.hasOwn(claims, claim))) return 'Required token claims were absent.'
  if (policy.issuer !== undefined && claims.iss !== policy.issuer) return 'The issuer claim did not match policy.'
  const aud = claims.aud
  if (policy.audience !== undefined && aud !== policy.audience &&
      !(Array.isArray(aud) && aud.every(value => typeof value === 'string') && aud.includes(policy.audience))) {
    return 'The audience claim did not match policy.'
  }
  const { exp, nbf, iat } = claims
  const now = Date.now() / 1000
  if ((exp !== undefined || policy.verification) &&
      (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= now)) return 'Token expiration metadata was absent, invalid or expired.'
  if (nbf !== undefined && (typeof nbf !== 'number' || !Number.isFinite(nbf) || nbf > now)) return 'Token not-before metadata was invalid or in the future.'
  if (policy.maxLifetimeSeconds !== undefined &&
      (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isFinite(iat) || iat > now ||
       exp <= iat || exp - iat > policy.maxLifetimeSeconds)) return 'The token lifetime could not be established or exceeded policy.'
  return undefined
}
