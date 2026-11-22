const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
const { after, before, beforeEach, describe, it } = require('node:test')
const mongoose = require('mongoose')
const { configureTestEnvironment, startTestServer, testEnvironment, testLogger } = require('../test-support/helpers')
const authMigration = require('../migrations/20261122000000-auth-indexes')
const fleetMigration = require('../migrations/20261122000001-fleet-availability')
const bookingMigration = require('../migrations/20261122000002-booking-lifecycle')
const paymentMigration = require('../migrations/20261122000003-guest-checkout-payments')
const operationsMigration = require('../migrations/20261122000004-phase-five-operations')
const adminMigration = require('../migrations/20261122000005-phase-six-admin')

configureTestEnvironment()

let MongoMemoryReplSet
let User
let Vehicle
let Booking
let AuditEntry
let server
let mongo
let deliveredMessages

before(async () => {
  process.env.MONGOMS_VERSION ||= '4.4.29'
  ;({ MongoMemoryReplSet } = require('mongodb-memory-server-core'))
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger', launchTimeout: 60000 },
  })
  process.env.MONGODB_URI = mongo.getUri('autohire-phase6-test')
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'autohire-phase6-test' })
  await authMigration.up(mongoose.connection.db)
  await fleetMigration.up(mongoose.connection.db)
  await bookingMigration.up(mongoose.connection.db)
  await paymentMigration.up(mongoose.connection.db)
  await operationsMigration.up(mongoose.connection.db)
  await adminMigration.up(mongoose.connection.db)

  ;({ User, Vehicle, Booking, AuditEntry } = require('../src/models'))
  deliveredMessages = []
  const { createApp } = require('../src/app')
  server = await startTestServer(createApp({
    env: testEnvironment(),
    logger: testLogger(),
    mailer: {
      async sendInvitation() {},
      async sendPasswordReset() {},
      async sendContactMessage(message) { deliveredMessages.push(message) },
    },
    isDatabaseReady: () => mongoose.connection.readyState === 1,
  }))
})

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})))
  await mongoose.connection.collection('adminlocks').updateOne(
    { _id: 'owner-account-guard' },
    { $set: { revision: 0 } },
    { upsert: true },
  )
  deliveredMessages.length = 0
})

after(async () => {
  if (server) await server.close()
  await mongoose.disconnect()
  if (mongo) await mongo.stop()
})

async function createActor(role, suffix) {
  const password = 'Phase-six-password-123!'
  const user = await User.create({
    name: `${role} ${suffix}`,
    email: `${role}-${suffix}@example.test`,
    phone: '254712345678',
    passwordHash: await bcrypt.hash(password, 4),
    role,
    branch: 'Nairobi HQ',
    active: true,
  })
  const response = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password }),
  })
  assert.equal(response.status, 200)
  const { data } = await response.json()
  return { user, token: data.accessToken }
}

function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra }
}

async function createVehicle(overrides = {}) {
  return Vehicle.create({
    make: 'Toyota',
    model: 'Corolla',
    year: 2024,
    registration: `KDA ${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    registrationKey: `KDA-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    seats: 5,
    transmission: 'automatic',
    ratePerDay: 8000,
    status: 'available',
    ...overrides,
  })
}

async function createPendingBooking(actor, vehicle, overrides = {}) {
  const pickupAt = new Date(Date.now() + 86_400_000)
  return Booking.create({
    reference: `BK-${Math.random().toString(36).slice(2, 12).toUpperCase()}`,
    vehicleId: vehicle._id,
    customerId: `cus-${Math.random().toString(36).slice(2, 10)}`,
    customerName: 'Customer Example',
    customerPhone: '254712345679',
    customerEmail: 'customer@example.test',
    customerIdNumber: '12345678',
    status: 'reserved',
    pendingApproval: true,
    pickupAt,
    returnAt: new Date(pickupAt.getTime() + 86_400_000),
    totalKes: 18_560,
    mode: 'self_drive',
    paymentMethod: 'cash',
    holdExpiresAt: new Date(Date.now() + 15 * 60_000),
    createdById: actor._id,
    pricingSnapshot: { baseDays: 1, totalDueKes: 18_560 },
    payments: [],
    events: [],
    ...overrides,
  })
}

describe('Phase 6 admin API', () => {
  it('persists profile changes and creates an immutable server audit entry', async () => {
    const owner = await createActor('owner', 'profile')
    const response = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
      method: 'PATCH',
      headers: authHeaders(owner.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'Updated Owner', phone: '254712345679' }),
    })

    assert.equal(response.status, 200)
    assert.equal((await response.json()).data.name, 'Updated Owner')
    assert.equal((await User.findById(owner.user._id)).phone, '254712345679')
    const entry = await AuditEntry.findOne({ actorId: String(owner.user._id), action: 'PATCH /api/v1/auth/me' }).lean()
    assert.equal(entry.actor, 'owner profile (owner)')
    assert.equal(entry.entity, `auth:${String(owner.user._id)}`)
    assert.equal(entry.before, undefined)
    assert.equal(entry.after, undefined)
  })

  it('enforces staff role boundaries and revokes sessions on deactivation', async () => {
    const owner = await createActor('owner', 'staff')
    const manager = await createActor('manager', 'staff')
    const target = await createActor('agent', 'staff')

    const managerList = await fetch(`${server.baseUrl}/api/v1/staff`, { headers: authHeaders(manager.token) })
    assert.equal(managerList.status, 200)
    assert.equal((await managerList.json()).data.items.some((item) => item.role === 'owner'), false)

    const forbiddenUpdate = await fetch(`${server.baseUrl}/api/v1/staff/${owner.user._id}`, {
      method: 'PATCH',
      headers: authHeaders(manager.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ active: false }),
    })
    assert.equal(forbiddenUpdate.status, 403)

    const deactivated = await fetch(`${server.baseUrl}/api/v1/staff/${target.user._id}`, {
      method: 'PATCH',
      headers: authHeaders(owner.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ active: false }),
    })
    assert.equal(deactivated.status, 200)
    assert.equal((await User.findById(target.user._id)).active, false)
    assert.equal(await mongoose.model('RefreshSession').countDocuments({ userId: target.user._id, revokedAt: null }), 0)
  })

  it('audits lazy booking hold-expiry and overdue transitions', async () => {
    const owner = await createActor('owner', 'system-audit')
    const vehicle = await createVehicle()
    const expiredHold = await createPendingBooking(owner.user, vehicle, {
      holdExpiresAt: new Date(Date.now() - 60_000),
    })
    const overdueBooking = await createPendingBooking(owner.user, vehicle, {
      status: 'checked_out',
      pendingApproval: false,
      holdExpiresAt: new Date(Date.now() - 60_000),
      returnAt: new Date(Date.now() - 4 * 60 * 60_000),
    })

    const response = await fetch(`${server.baseUrl}/api/v1/bookings`, { headers: authHeaders(owner.token) })
    assert.equal(response.status, 200)
    assert.equal((await Booking.findById(expiredHold._id)).status, 'expired')
    const updatedOverdueBooking = await Booking.findById(overdueBooking._id)
    assert.equal(updatedOverdueBooking.status, 'overdue')
    assert.ok(updatedOverdueBooking.accruedLateFeeKes > 0)

    const entries = await AuditEntry.find({
      entity: { $in: [`booking:${expiredHold._id}`, `booking:${overdueBooking._id}`] },
    }).sort({ action: 1 }).lean()
    assert.deepEqual(entries.map(({ action, before, after }) => ({ action, before, after })), [
      {
        action: 'booking.hold.expired',
        before: { status: 'reserved', pendingApproval: true },
        after: { status: 'expired', pendingApproval: false },
      },
      {
        action: 'booking.overdue',
        before: { status: 'checked_out', accruedLateFeeKes: 0 },
        after: { status: 'overdue', accruedLateFeeKes: updatedOverdueBooking.accruedLateFeeKes },
      },
    ])
  })

  it('excludes self-created approvals, persists approvals, and serves database dashboard metrics', async () => {
    const owner = await createActor('owner', 'approval')
    const otherOwner = await createActor('owner', 'creator')
    const vehicle = await createVehicle()
    const ownBooking = await createPendingBooking(owner.user, vehicle)
    const otherBooking = await createPendingBooking(otherOwner.user, vehicle)

    const approvals = await fetch(`${server.baseUrl}/api/v1/approvals`, { headers: authHeaders(owner.token) })
    assert.equal(approvals.status, 200)
    const approvalRows = (await approvals.json()).data.items
    assert.deepEqual(approvalRows.map((booking) => booking.id), [String(otherBooking._id)])

    const approval = await fetch(`${server.baseUrl}/api/v1/bookings/${otherBooking._id}/offline-approval`, {
      method: 'POST',
      headers: authHeaders(owner.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ paymentMethod: 'cash', reference: 'RCPT-123' }),
    })
    assert.equal(approval.status, 200)
    assert.equal((await Booking.findById(otherBooking._id)).status, 'confirmed')
    assert.equal((await Booking.findById(ownBooking._id)).status, 'reserved')
    assert.equal(await AuditEntry.countDocuments({ action: 'POST /api/v1/bookings/:bookingId/offline-approval' }), 1)

    const dashboard = await fetch(`${server.baseUrl}/api/v1/dashboard`, { headers: authHeaders(owner.token) })
    assert.equal(dashboard.status, 200)
    assert.equal((await dashboard.json()).data.metrics.pendingApprovals, 1)

    const notifications = await fetch(`${server.baseUrl}/api/v1/notifications`, { headers: authHeaders(owner.token) })
    assert.equal(notifications.status, 200)
    assert.deepEqual((await notifications.json()).data, { pendingApprovals: 1, openIncidents: 0, pendingExtensions: 0 })

    const search = await fetch(`${server.baseUrl}/api/v1/search?q=Toyota`, { headers: authHeaders(owner.token) })
    assert.equal(search.status, 200)
    assert.ok((await search.json()).data.some((result) => result.type === 'vehicle' && result.subtitle === vehicle.registration))
  })

  it('rate limits public contact delivery and sends to the configured inbox', async () => {
    const body = JSON.stringify({
      name: 'Jane Doe',
      email: 'jane@example.test',
      phone: '254712345678',
      message: 'Please contact me about an upcoming booking.',
    })
    const submit = () => fetch(`${server.baseUrl}/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const first = await submit()
    assert.equal(first.status, 201)
    assert.deepEqual(deliveredMessages[0], {
      to: 'hello@autohire.ke',
      name: 'Jane Doe',
      email: 'jane@example.test',
      phone: '254712345678',
      message: 'Please contact me about an upcoming booking.',
    })
    for (let attempt = 0; attempt < 4; attempt += 1) assert.equal((await submit()).status, 201)
    const limited = await submit()
    assert.equal(limited.status, 429)
    assert.equal(deliveredMessages.length, 5)
  })
})
