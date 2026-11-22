'use strict'

const { randomBytes } = require('node:crypto')

function objectId() {
  return randomBytes(12).toString('hex')
}

function createMemoryRepository(seedUsers = []) {
  const users = new Map(seedUsers.map((user) => [String(user.id), { ...user, _id: String(user.id) }]))
  const sessions = new Map()
  const invitations = new Map()
  const resets = new Map()

  return {
    users,
    sessions,
    invitations,
    resets,
    async findUserByEmail(email) {
      return [...users.values()].find((user) => user.email === email) ?? null
    },
    async findUserById(id) {
      return users.get(String(id)) ?? null
    },
    async createUser(user) {
      if ([...users.values()].some((current) => current.email === user.email)) {
        const error = new Error('duplicate email')
        error.code = 11000
        throw error
      }
      const saved = { ...user, _id: objectId() }
      users.set(saved._id, saved)
      return saved
    },
    async updateLastLogin(id, lastLoginAt) {
      const user = users.get(String(id))
      if (user) user.lastLoginAt = lastLoginAt
    },
    async createSession(session) {
      const saved = { ...session, _id: objectId() }
      sessions.set(saved._id, saved)
      return saved
    },
    async findActiveSession(id, now) {
      const session = sessions.get(String(id))
      return session && !session.revokedAt && new Date(session.expiresAt) > now ? session : null
    },
    async findSessionByRefreshHash(refreshTokenHash) {
      return [...sessions.values()].find((session) => session.refreshTokenHash === refreshTokenHash && !session.revokedAt) ?? null
    },
    async rotateSession({ id, currentHash, nextHash, now }) {
      const session = sessions.get(String(id))
      if (!session || session.refreshTokenHash !== currentHash || session.revokedAt || new Date(session.expiresAt) <= now) return null
      session.refreshTokenHash = nextHash
      return session
    },
    async revokeSessionByRefreshHash(refreshTokenHash, now) {
      const session = [...sessions.values()].find((item) => item.refreshTokenHash === refreshTokenHash)
      if (session) session.revokedAt = now
    },
    async revokeSession(id, now) {
      const session = sessions.get(String(id))
      if (session) session.revokedAt = now
    },
    async revokeSessionsForUser(userId, now) {
      for (const session of sessions.values()) {
        if (String(session.userId) === String(userId) && !session.revokedAt) session.revokedAt = now
      }
    },
    async createInvitation(invitation) {
      const saved = { ...invitation, _id: objectId() }
      invitations.set(saved._id, saved)
      return saved
    },
    async findPendingInvitationByEmail(email, now) {
      return [...invitations.values()].find((item) =>
        item.email === email && !item.acceptedAt && !item.revokedAt && new Date(item.expiresAt) > now,
      ) ?? null
    },
    async findInvitationByTokenHash(tokenHash) {
      return [...invitations.values()].find((item) => item.tokenHash === tokenHash && !item.acceptedAt && !item.revokedAt) ?? null
    },
    async findInvitationById(id) {
      return invitations.get(String(id)) ?? null
    },
    async replaceInvitationToken({ id, tokenHash, expiresAt }) {
      const invitation = invitations.get(String(id))
      if (!invitation || invitation.acceptedAt || invitation.revokedAt) return null
      invitation.tokenHash = tokenHash
      invitation.expiresAt = expiresAt
      return invitation
    },
    async acceptInvitation({ id, tokenHash, now }) {
      const invitation = invitations.get(String(id))
      if (!invitation || invitation.tokenHash !== tokenHash || invitation.acceptedAt || invitation.revokedAt || new Date(invitation.expiresAt) <= now) return null
      invitation.acceptedAt = now
      return invitation
    },
    async revokeInvitation(id, now) {
      const invitation = invitations.get(String(id))
      if (!invitation || invitation.acceptedAt || invitation.revokedAt) return { matchedCount: 0 }
      invitation.revokedAt = now
      return { matchedCount: 1 }
    },
    async reopenInvitation({ id, acceptedAt }) {
      const invitation = invitations.get(String(id))
      if (invitation?.acceptedAt?.getTime() === acceptedAt.getTime()) invitation.acceptedAt = null
    },
    async revokePendingInvitations(email, now) {
      for (const invitation of invitations.values()) {
        if (invitation.email === email && !invitation.acceptedAt && !invitation.revokedAt) invitation.revokedAt = now
      }
    },
    async createPasswordReset(reset) {
      const saved = { ...reset, _id: objectId() }
      resets.set(saved._id, saved)
      return saved
    },
    async findPasswordResetByTokenHash(tokenHash) {
      return [...resets.values()].find((item) => item.tokenHash === tokenHash && !item.usedAt) ?? null
    },
    async consumePasswordReset({ id, tokenHash, now }) {
      const reset = resets.get(String(id))
      if (!reset || reset.tokenHash !== tokenHash || reset.usedAt || new Date(reset.expiresAt) <= now) return null
      reset.usedAt = now
      return reset
    },
    async reopenPasswordReset({ id, usedAt }) {
      const reset = resets.get(String(id))
      if (reset?.usedAt?.getTime() === usedAt.getTime()) reset.usedAt = null
    },
    async revokePasswordResetsForUser(userId, now) {
      for (const reset of resets.values()) {
        if (String(reset.userId) === String(userId) && !reset.usedAt) reset.usedAt = now
      }
    },
    async updatePassword(userId, passwordHash) {
      const user = users.get(String(userId))
      if (user) user.passwordHash = passwordHash
    },
  }
}

function testEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'test',
    ACCESS_TOKEN_SECRET: 'test-secret-with-more-than-thirty-two-characters',
    FRONTEND_BASE_URL: 'http://localhost:5173',
    CORS_ORIGINS: ['http://localhost:5173'],
    smtpConfigured: true,
    SMTP_HOST: 'mail.example.test',
    SMTP_PORT: 2525,
    SMTP_SECURE: false,
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    MAIL_FROM: 'AutoHire Test <test@example.test>',
    CONTACT_INBOX: 'hello@autohire.ke',
    ...overrides,
  }
}

function configureTestEnvironment() {
  process.env.NODE_ENV = 'test'
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/autohire-test'
  process.env.ACCESS_TOKEN_SECRET = 'test-secret-with-more-than-thirty-two-characters'
}

function testLogger() {
  return { info() {}, warn() {}, error() {}, fatal() {} }
}

async function startTestServer(app) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

module.exports = { configureTestEnvironment, createMemoryRepository, startTestServer, testEnvironment, testLogger }
