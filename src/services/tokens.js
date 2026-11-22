const { createHash, randomBytes } = require('node:crypto')
const jwt = require('jsonwebtoken')

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
const REFRESH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function createOpaqueToken() {
  return randomBytes(32).toString('base64url')
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function createAccessToken({ userId, sessionId, secret, now = Date.now }) {
  return jwt.sign(
    { sid: String(sessionId), iat: Math.floor(now() / 1000) },
    secret,
    {
      algorithm: 'HS256',
      audience: 'autohire-frontend',
      issuer: 'autohire-api',
      subject: String(userId),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      jwtid: randomBytes(16).toString('hex'),
    },
  )
}

function verifyAccessToken(token, secret, now = Date.now) {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: 'autohire-frontend',
      issuer: 'autohire-api',
      clockTimestamp: Math.floor(now() / 1000),
    })
    if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null
    return payload
  } catch {
    return null
  }
}

module.exports = {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_SESSION_TTL_MS,
  createOpaqueToken,
  hashToken,
  createAccessToken,
  verifyAccessToken,
}
