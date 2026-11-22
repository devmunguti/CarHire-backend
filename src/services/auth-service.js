const bcrypt = require('bcryptjs')
const { AppError, unauthorized } = require('../lib/errors')
const {
  REFRESH_SESSION_TTL_MS,
  createAccessToken,
  createOpaqueToken,
  hashToken,
} = require('./tokens')

function idOf(record) {
  return String(record._id ?? record.id)
}

function toPublicUser(user) {
  return {
    id: idOf(user),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    branch: user.branch,
    active: user.active,
    lastLogin: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : undefined,
  }
}

function createAuthService({ repository, accessTokenSecret, now = () => new Date() }) {
  function accessToken(userId, sessionId) {
    return createAccessToken({ userId, sessionId, secret: accessTokenSecret, now: () => now().getTime() })
  }

  async function login({ email, password }) {
    const user = await repository.findUserByEmail(email.toLowerCase(), true)
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect')
    }
    if (!user.active) throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated')

    const currentTime = now()
    const refreshToken = createOpaqueToken()
    const session = await repository.createSession({
      userId: user._id ?? user.id,
      refreshTokenHash: hashToken(refreshToken),
      expiresAt: new Date(currentTime.getTime() + REFRESH_SESSION_TTL_MS),
      revokedAt: null,
    })
    await repository.updateLastLogin(idOf(user), currentTime)
    user.lastLoginAt = currentTime

    return {
      user: toPublicUser(user),
      accessToken: accessToken(idOf(user), idOf(session)),
      refreshToken,
      refreshExpiresAt: session.expiresAt,
    }
  }

  async function authenticate(token) {
    const user = await repository.findUserById(token.sub)
    if (!user) throw unauthorized()
    if (!user.active) {
      await repository.revokeSession(token.sid, now())
      throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated')
    }
    const session = await repository.findActiveSession(token.sid, now())
    if (!session || String(session.userId) !== idOf(user)) throw unauthorized()
    return toPublicUser(user)
  }

  async function updateCurrentUser(userId, patch) {
    const updated = await repository.updateCurrentUser(userId, patch)
    if (!updated) throw new AppError(404, 'NOT_FOUND', 'User account was not found')
    return toPublicUser(updated)
  }

  async function refresh(rawToken) {
    if (!rawToken) throw unauthorized('Refresh session is missing or expired')
    const currentHash = hashToken(rawToken)
    const session = await repository.findSessionByRefreshHash(currentHash)
    if (!session || new Date(session.expiresAt) <= now() || session.revokedAt) {
      throw unauthorized('Refresh session is missing or expired')
    }

    const nextToken = createOpaqueToken()
    const rotated = await repository.rotateSession({
      id: idOf(session),
      currentHash,
      nextHash: hashToken(nextToken),
      now: now(),
    })
    if (!rotated) throw unauthorized('Refresh session is missing or expired')

    const user = await repository.findUserById(session.userId)
    if (!user) {
      await repository.revokeSession(idOf(session), now())
      throw unauthorized()
    }
    if (!user.active) {
      await repository.revokeSession(idOf(session), now())
      throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated')
    }

    return {
      accessToken: accessToken(idOf(user), idOf(session)),
      refreshToken: nextToken,
      refreshExpiresAt: session.expiresAt,
    }
  }

  async function logout(rawToken) {
    if (rawToken) await repository.revokeSessionByRefreshHash(hashToken(rawToken), now())
  }

  return { login, authenticate, refresh, logout, updateCurrentUser }
}

module.exports = { createAuthService, toPublicUser }
