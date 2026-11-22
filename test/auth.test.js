const bcrypt = require('bcryptjs')
const { after, before, describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { configureTestEnvironment, createMemoryRepository, startTestServer, testEnvironment, testLogger } = require('../test-support/helpers')
configureTestEnvironment()
const { createApp } = require('../src/app')

const ownerPassword = 'Owner-password-123!'
let passwordHash

before(async () => {
  passwordHash = await bcrypt.hash(ownerPassword, 4)
})

function seedUser(role = 'owner') {
  return {
    id: '000000000000000000000001',
    name: 'Amina Njeri',
    email: `${role}@example.test`,
    phone: '254712345678',
    role,
    branch: 'Nairobi HQ',
    active: true,
    passwordHash,
  }
}

async function setup({ role = 'owner', mailer, isDatabaseReady = () => true } = {}) {
  const repository = createMemoryRepository([seedUser(role)])
  const sentEmails = []
  const auditEntries = []
  const emailService = mailer ?? {
    async sendInvitation(message) { sentEmails.push({ type: 'invitation', ...message }) },
    async sendPasswordReset(message) { sentEmails.push({ type: 'reset', ...message }) },
  }
  const app = createApp({
    env: testEnvironment(),
    repository,
    auditRepository: {
      async record(entry) { auditEntries.push(entry); return entry },
      async list() { return { items: auditEntries, nextCursor: null } },
    },
    mailer: emailService,
    logger: testLogger(),
    isDatabaseReady,
  })
  const server = await startTestServer(app)
  return { ...server, repository, sentEmails, auditEntries }
}

async function jsonRequest(baseUrl, path, { method = 'GET', body, token, cookie, origin = 'http://localhost:5173' } = {}) {
  const headers = { Origin: origin }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  if (cookie) headers.Cookie = cookie
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { response, envelope: await response.json() }
}

function cookiePair(response) {
  const value = response.headers.get('set-cookie')
  assert.ok(value)
  return value.split(';', 1)[0]
}

describe('authentication API', () => {
  it('authenticates, returns the current user, rotates refresh cookies, and revokes on logout', async () => {
    const server = await setup()
    try {
      const login = await jsonRequest(server.baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        body: { email: 'owner@example.test', password: ownerPassword },
      })
      assert.equal(login.response.status, 200)
      assert.equal(login.envelope.success, true)
      assert.equal(login.envelope.data.user.role, 'owner')
      assert.equal('passwordHash' in login.envelope.data.user, false)
      assert.match(login.response.headers.get('set-cookie'), /HttpOnly/i)
      assert.match(login.response.headers.get('set-cookie'), /SameSite=Lax/i)
      assert.match(login.response.headers.get('access-control-allow-credentials'), /true/i)
      assert.equal(login.response.headers.get('access-control-allow-origin'), 'http://localhost:5173')
      const firstCookie = cookiePair(login.response)

      const currentUser = await jsonRequest(server.baseUrl, '/api/v1/auth/me', { token: login.envelope.data.accessToken })
      assert.equal(currentUser.response.status, 200)
      assert.equal(currentUser.envelope.data.email, 'owner@example.test')

      const refresh = await jsonRequest(server.baseUrl, '/api/v1/auth/refresh', { method: 'POST', cookie: firstCookie })
      assert.equal(refresh.response.status, 200)
      const rotatedCookie = cookiePair(refresh.response)
      assert.notEqual(rotatedCookie, firstCookie)

      const replay = await jsonRequest(server.baseUrl, '/api/v1/auth/refresh', { method: 'POST', cookie: firstCookie })
      assert.equal(replay.response.status, 401)

      const logout = await jsonRequest(server.baseUrl, '/api/v1/auth/logout', { method: 'POST', cookie: rotatedCookie })
      assert.equal(logout.response.status, 200)
      assert.equal(logout.envelope.data.loggedOut, true)
      const revokedAccess = await jsonRequest(server.baseUrl, '/api/v1/auth/me', { token: refresh.envelope.data.accessToken })
      assert.equal(revokedAccess.response.status, 401)
    } finally {
      await server.close()
    }
  })

  it('returns a consistent 401 envelope for missing or incorrect credentials', async () => {
    const server = await setup()
    try {
      const missing = await jsonRequest(server.baseUrl, '/api/v1/auth/me')
      assert.equal(missing.response.status, 401)
      assert.deepEqual(missing.envelope.error, {
        code: 'UNAUTHENTICATED',
        message: 'Authentication is required',
      })

      const invalid = await jsonRequest(server.baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        body: { email: 'owner@example.test', password: 'wrong-password' },
      })
      assert.equal(invalid.response.status, 401)
      assert.equal(invalid.envelope.error.code, 'INVALID_CREDENTIALS')
      assert.equal(invalid.envelope.data, null)
    } finally {
      await server.close()
    }
  })

  it('returns 403 for a valid agent session attempting staff management', async () => {
    const server = await setup({ role: 'agent' })
    try {
      const login = await jsonRequest(server.baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        body: { email: 'agent@example.test', password: ownerPassword },
      })
      const result = await jsonRequest(server.baseUrl, '/api/v1/staff', {
        method: 'POST',
        token: login.envelope.data.accessToken,
        body: {
          name: 'Grace Wanjiru',
          email: 'grace@example.test',
          phone: '254712345679',
          role: 'driver',
          branch: 'Nairobi HQ',
        },
      })
      assert.equal(result.response.status, 403)
      assert.equal(result.envelope.error.code, 'FORBIDDEN')
      assert.equal(server.repository.invitations.size, 0)
    } finally {
      await server.close()
    }
  })

  it('rejects invalid input and reports database readiness through health', async () => {
    const server = await setup({ isDatabaseReady: () => false })
    try {
      const invalid = await jsonRequest(server.baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        body: { email: 'not-an-email', password: '' },
      })
      assert.equal(invalid.response.status, 400)
      assert.equal(invalid.envelope.error.code, 'VALIDATION_ERROR')
      assert.ok(invalid.envelope.error.details.length >= 1)

      const health = await jsonRequest(server.baseUrl, '/api/v1/health')
      assert.equal(health.response.status, 503)
      assert.equal(health.envelope.error.code, 'SERVICE_UNAVAILABLE')
    } finally {
      await server.close()
    }
  })

  it('accepts staff invitations and resets passwords with one-time tokens', async () => {
    const server = await setup()
    try {
      const login = await jsonRequest(server.baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        body: { email: 'owner@example.test', password: ownerPassword },
      })
      const token = login.envelope.data.accessToken
      const invitation = await jsonRequest(server.baseUrl, '/api/v1/staff', {
        method: 'POST',
        token,
        body: {
          name: 'Grace Wanjiru',
          email: 'grace@example.test',
          phone: '254712345679',
          role: 'agent',
          branch: 'Nairobi HQ',
        },
      })
      assert.equal(invitation.response.status, 201)
      const inviteEmail = server.sentEmails.find((email) => email.type === 'invitation')
      const inviteToken = new URL(inviteEmail.link).searchParams.get('token')
      const accepted = await jsonRequest(server.baseUrl, '/api/v1/auth/invitations/accept', {
        method: 'POST',
        body: { token: inviteToken, password: 'Staff-password-123!' },
      })
      assert.equal(accepted.response.status, 200)
      assert.equal(accepted.envelope.data.role, 'agent')
      assert.equal('passwordHash' in accepted.envelope.data, false)

      const resetRequest = await jsonRequest(server.baseUrl, '/api/v1/auth/password-reset/request', {
        method: 'POST',
        body: { email: 'grace@example.test' },
      })
      assert.equal(resetRequest.response.status, 202)
      const resetEmail = server.sentEmails.find((email) => email.type === 'reset')
      const resetToken = new URL(resetEmail.link).searchParams.get('token')
      const reset = await jsonRequest(server.baseUrl, '/api/v1/auth/password-reset/confirm', {
        method: 'POST',
        body: { token: resetToken, password: 'Another-password-456!' },
      })
      assert.equal(reset.response.status, 200)
      const replay = await jsonRequest(server.baseUrl, '/api/v1/auth/password-reset/confirm', {
        method: 'POST',
        body: { token: resetToken, password: 'Another-password-456!' },
      })
      assert.equal(replay.response.status, 400)
      assert.equal(replay.envelope.error.code, 'INVALID_RESET_TOKEN')

      const loginAfterReset = await jsonRequest(server.baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        body: { email: 'grace@example.test', password: 'Another-password-456!' },
      })
      assert.equal(loginAfterReset.response.status, 200)

      const unknownReset = await jsonRequest(server.baseUrl, '/api/v1/auth/password-reset/request', {
        method: 'POST',
        body: { email: 'unknown@example.test' },
      })
      assert.equal(unknownReset.response.status, 202)
      assert.deepEqual(unknownReset.envelope.data, resetRequest.envelope.data)
    } finally {
      await server.close()
    }
  })
})
