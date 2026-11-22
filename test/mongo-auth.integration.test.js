const bcrypt = require('bcryptjs')
const assert = require('node:assert/strict')
const { after, before, beforeEach, describe, it } = require('node:test')
const mongoose = require('mongoose')
const { configureTestEnvironment, startTestServer, testEnvironment, testLogger } = require('../test-support/helpers')
const migration = require('../migrations/20261122000000-auth-indexes')
const fleetMigration = require('../migrations/20261122000001-fleet-availability')
const bookingMigration = require('../migrations/20261122000002-booking-lifecycle')

configureTestEnvironment()

let MongoMemoryReplSet
let User
let Vehicle
let Booking
let createApp
let mongo
let appServer
let repository
let sentEmails

before(async () => {
  process.env.MONGOMS_VERSION ||= '4.4.29'
  ;({ MongoMemoryReplSet } = require('mongodb-memory-server-core'))
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instance: { launchTimeout: 60000 },
  })
  process.env.MONGODB_URI = mongo.getUri('autohire-phase1-test')
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'autohire-phase1-test' })
  await migration.up(mongoose.connection.db)
  await fleetMigration.up(mongoose.connection.db)
  await bookingMigration.up(mongoose.connection.db)

  ;({ User, Vehicle, Booking } = require('../src/models'))
  ;({ createApp } = require('../src/app'))
  repository = require('../src/repositories/mongo-auth-repository').authRepository
})

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})))
  sentEmails = []
})

after(async () => {
  if (appServer) await appServer.close()
  await mongoose.disconnect()
  if (mongo) await mongo.stop()
})

describe('MongoDB-backed authentication', () => {
  it('runs real login, current-user, refresh rotation, logout, and protected-route authorization', async () => {
    const passwordHash = await bcrypt.hash('Agent-password-123!', 4)
    await User.create({
      name: 'Wanjiku Kamau',
      email: 'agent@example.test',
      phone: '254712345678',
      passwordHash,
      role: 'agent',
      branch: 'Nairobi HQ',
      active: true,
    })

    const app = createApp({
      env: testEnvironment(),
      repository,
      logger: testLogger(),
      mailer: {
        async sendInvitation(email) { sentEmails.push(email) },
        async sendPasswordReset(email) { sentEmails.push(email) },
      },
      isDatabaseReady: () => mongoose.connection.readyState === 1,
    })
    appServer = await startTestServer(app)

    const loginResponse = await fetch(`${appServer.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'agent@example.test', password: 'Agent-password-123!' }),
    })
    assert.equal(loginResponse.status, 200)
    const login = await loginResponse.json()
    const firstCookie = loginResponse.headers.get('set-cookie').split(';', 1)[0]

    const currentResponse = await fetch(`${appServer.baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${login.data.accessToken}` },
    })
    assert.equal(currentResponse.status, 200)
    assert.equal((await currentResponse.json()).data.email, 'agent@example.test')

    const forbiddenResponse = await fetch(`${appServer.baseUrl}/api/v1/staff`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${login.data.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Grace Wanjiru',
        email: 'grace@example.test',
        phone: '254712345679',
        role: 'driver',
        branch: 'Nairobi HQ',
      }),
    })
    assert.equal(forbiddenResponse.status, 403)
    assert.equal((await forbiddenResponse.json()).error.code, 'FORBIDDEN')

    const refreshResponse = await fetch(`${appServer.baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: firstCookie },
    })
    assert.equal(refreshResponse.status, 200)
    const refreshed = await refreshResponse.json()
    const rotatedCookie = refreshResponse.headers.get('set-cookie').split(';', 1)[0]
    assert.notEqual(rotatedCookie, firstCookie)

    const logoutResponse = await fetch(`${appServer.baseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Cookie: rotatedCookie },
    })
    assert.equal(logoutResponse.status, 200)

    const revokedResponse = await fetch(`${appServer.baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${refreshed.data.accessToken}` },
    })
    assert.equal(revokedResponse.status, 401)
    assert.equal((await revokedResponse.json()).error.code, 'UNAUTHENTICATED')
  })

  it('applies the schema indexes through the migration', async () => {
    const indexes = await mongoose.connection.db.collection('users').indexes()
    assert.ok(indexes.some((index) => index.name === 'uniq_users_email' && index.unique))
    assert.ok(indexes.some((index) => index.name === 'uniq_initial_owner' && index.unique))
    const refreshIndexes = await mongoose.connection.db.collection('refreshsessions').indexes()
    assert.ok(refreshIndexes.some((index) => index.name === 'ttl_refresh_session_expiry' && index.expireAfterSeconds === 0))
    const vehicleIndexes = await mongoose.connection.db.collection('vehicles').indexes()
    assert.ok(vehicleIndexes.some((index) => index.name === 'uniq_vehicle_registration' && index.unique))
    const bookingIndexes = await mongoose.connection.db.collection('bookings').indexes()
    assert.ok(bookingIndexes.some((index) => index.name === 'idx_booking_vehicle_interval'))
    assert.ok(bookingIndexes.some((index) => index.name === 'idx_booking_hold_expiry'))
    assert.ok(bookingIndexes.some((index) => index.name === 'uniq_booking_actor_idempotency' && index.unique))
  })
})

describe('MongoDB-backed fleet and availability', () => {
  async function createStaffSession(role = 'manager') {
    const password = 'Fleet-password-123!'
    const user = await User.create({
      name: 'Fleet Manager',
      email: `${role}-${Math.random().toString(36).slice(2)}@fleet.example.test`,
      phone: '254712345678',
      passwordHash: await bcrypt.hash(password, 4),
      role,
      branch: 'Nairobi HQ',
      active: true,
    })
    const app = createApp({
      env: testEnvironment(),
      logger: testLogger(),
      mailer: { async sendInvitation() {}, async sendPasswordReset() {} },
      isDatabaseReady: () => mongoose.connection.readyState === 1,
    })
    const server = await startTestServer(app)
    const login = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password }),
    })
    assert.equal(login.status, 200)
    const { data } = await login.json()
    return { server, token: data.accessToken, user }
  }

  function vehicleInput(overrides = {}) {
    return {
      make: 'Toyota',
      model: 'Corolla',
      category: 'Sedan',
      year: 2024,
      registration: 'KDA 234A',
      seats: 5,
      transmission: 'automatic',
      ratePerDay: 8000,
      ...overrides,
    }
  }

  async function createVehicle(server, token, input = vehicleInput()) {
    const response = await fetch(`${server.baseUrl}/api/v1/vehicles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    assert.equal(response.status, 201)
    return (await response.json()).data
  }

  async function createBooking(server, token, input, idempotencyKey) {
    const response = await fetch(`${server.baseUrl}/api/v1/bookings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(input),
    })
    return { response, body: await response.json() }
  }

  function bookingInput(vehicleId, pickupAt, returnAt, overrides = {}) {
    return {
      vehicleId,
      pickupAt,
      returnAt,
      pickupLocation: 'Nairobi',
      mode: 'self_drive',
      extras: [],
      customerName: 'Grace Wanjiru',
      customerPhone: '254712345679',
      customerEmail: `${randomCustomerNumber()}@example.test`,
      customerIdNumber: '12345678',
      paymentMethod: 'mpesa_online',
      ...overrides,
    }
  }

  function randomCustomerNumber() {
    return Math.random().toString(36).slice(2)
  }

  it('creates, lists, and updates vehicles and maintenance with role checks', async () => {
    const { server, token } = await createStaffSession()
    try {
      const vehicle = await createVehicle(server, token)
      const list = await fetch(`${server.baseUrl}/api/v1/vehicles`)
      const vehicles = (await list.json()).data.items
      assert.equal(vehicles.find((item) => item.id === vehicle.id).status, 'available')

      const from = new Date(Date.now() + 2 * 86_400_000)
      const to = new Date(from.getTime() + 86_400_000)
      const maintenanceResponse = await fetch(`${server.baseUrl}/api/v1/maintenance-windows`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId: vehicle.id,
          startAt: from.toISOString(),
          endAt: to.toISOString(),
          reason: 'Scheduled service',
        }),
      })
      assert.equal(maintenanceResponse.status, 201)
      const maintenance = (await maintenanceResponse.json()).data

      const invalidMaintenanceUpdate = await fetch(`${server.baseUrl}/api/v1/maintenance-windows/${maintenance.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ endAt: from.toISOString() }),
      })
      assert.equal(invalidMaintenanceUpdate.status, 400)
      assert.equal((await invalidMaintenanceUpdate.json()).error.code, 'VALIDATION_ERROR')

      const unavailable = await fetch(`${server.baseUrl}/api/v1/vehicles?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      assert.deepEqual((await unavailable.json()).data.items, [])

      const updated = await fetch(`${server.baseUrl}/api/v1/vehicles/${vehicle.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ratePerDay: 9000 }),
      })
      assert.equal(updated.status, 200)
      assert.equal((await updated.json()).data.ratePerDay, 9000)

      const maintenanceList = await fetch(`${server.baseUrl}/api/v1/maintenance-windows?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal((await maintenanceList.json()).data.items[0].id, maintenance.id)

      const deletion = await fetch(`${server.baseUrl}/api/v1/maintenance-windows/${maintenance.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(deletion.status, 200)

      const noToken = await fetch(`${server.baseUrl}/api/v1/maintenance-windows?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      assert.equal(noToken.status, 401)
    } finally {
      await server.close()
    }
  })

  it('serializes competing reservations so overlapping requests cannot both succeed', async () => {
    const { server, token } = await createStaffSession()
    try {
      const vehicle = await createVehicle(server, token, vehicleInput({ registration: 'KDA 235A' }))
      const pickupAt = new Date(Date.now() + 10 * 86_400_000)
      const returnAt = new Date(pickupAt.getTime() + 2 * 86_400_000)
      const payloads = [
        bookingInput(vehicle.id, pickupAt.toISOString(), returnAt.toISOString()),
        bookingInput(vehicle.id, pickupAt.toISOString(), returnAt.toISOString()),
      ]
      const responses = await Promise.all(payloads.map((body) => fetch(`${server.baseUrl}/api/v1/bookings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })))

      assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409])
      assert.equal(await Booking.countDocuments({ vehicleId: vehicle.id }), 1)

      const available = await fetch(`${server.baseUrl}/api/v1/vehicles?from=${encodeURIComponent(pickupAt.toISOString())}&to=${encodeURIComponent(returnAt.toISOString())}`)
      assert.deepEqual((await available.json()).data.items, [])

      const statusChange = await fetch(`${server.baseUrl}/api/v1/vehicles/${vehicle.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'inactive' }),
      })
      assert.equal(statusChange.status, 409)

      const overlappingMaintenance = await fetch(`${server.baseUrl}/api/v1/maintenance-windows`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId: vehicle.id,
          startAt: pickupAt.toISOString(),
          endAt: returnAt.toISOString(),
          reason: 'Conflicts with the reservation',
        }),
      })
      assert.equal(overlappingMaintenance.status, 409)

      const nextPickup = returnAt
      const nextReturn = new Date(nextPickup.getTime() + 86_400_000)
      const adjacent = await fetch(`${server.baseUrl}/api/v1/bookings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(bookingInput(vehicle.id, nextPickup.toISOString(), nextReturn.toISOString())),
      })
      assert.equal(adjacent.status, 201)
    } finally {
      await server.close()
    }
  })

  it('calculates authoritative quotes and supports idempotent booking reads and filters', async () => {
    const { server, token } = await createStaffSession()
    try {
      const preflight = await fetch(`${server.baseUrl}/api/v1/bookings`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key',
        },
      })
      assert.equal(preflight.status, 204)
      assert.match(preflight.headers.get('access-control-allow-headers'), /idempotency-key/i)

      const vehicle = await createVehicle(server, token)
      const pickupAt = new Date(Date.now() + 8 * 86_400_000)
      const returnAt = new Date(pickupAt.getTime() + 2 * 86_400_000)
      const input = bookingInput(vehicle.id, pickupAt.toISOString(), returnAt.toISOString(), {
        paymentMethod: 'cash',
      })
      const quoteResponse = await fetch(`${server.baseUrl}/api/v1/quotes/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId: input.vehicleId,
          pickupAt: input.pickupAt,
          returnAt: input.returnAt,
          pickupLocation: input.pickupLocation,
          mode: input.mode,
          extras: input.extras,
        }),
      })
      assert.equal(quoteResponse.status, 200)
      const quote = (await quoteResponse.json()).data
      assert.equal(quote.pricingSnapshot.baseAmountKes, 16_000)
      assert.equal(quote.pricingSnapshot.totalDueKes, 18_560)

      const invalidDateQuote = await fetch(`${server.baseUrl}/api/v1/quotes/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId: input.vehicleId,
          pickupAt: input.pickupAt,
          returnAt: input.pickupAt,
          pickupLocation: input.pickupLocation,
          mode: input.mode,
          extras: input.extras,
        }),
      })
      assert.equal(invalidDateQuote.status, 400)
      assert.equal((await invalidDateQuote.json()).error.code, 'INVALID_DATE_RANGE')

      for (const forbiddenField of [{ totalKes: 1 }, { status: 'confirmed' }, { pricingSnapshot: quote.pricingSnapshot }]) {
        const rejectedInput = await createBooking(server, token, { ...input, ...forbiddenField })
        assert.equal(rejectedInput.response.status, 400)
        assert.equal(rejectedInput.body.error.code, 'VALIDATION_ERROR')
      }

      const key = 'phase-three-booking-key-001'
      const created = await createBooking(server, token, input, key)
      assert.equal(created.response.status, 201)
      assert.equal(created.body.data.totalKes, 18_560)
      assert.equal(created.body.data.pickupLocation, input.pickupLocation)
      assert.equal(created.body.data.events[0].type, 'booking.reserved')

      const replay = await createBooking(server, token, input, key)
      assert.equal(replay.response.status, 201)
      assert.equal(replay.body.data.id, created.body.data.id)

      const conflictingReplay = await createBooking(server, token, { ...input, customerName: 'Different Customer' }, key)
      assert.equal(conflictingReplay.response.status, 409)
      assert.equal(conflictingReplay.body.error.code, 'IDEMPOTENCY_CONFLICT')

      const list = await fetch(`${server.baseUrl}/api/v1/bookings?status=reserved&search=${encodeURIComponent(created.body.data.reference)}&vehicleId=${vehicle.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(list.status, 200)
      assert.deepEqual((await list.json()).data.items.map((item) => item.id), [created.body.data.id])

      const dateFiltered = await fetch(`${server.baseUrl}/api/v1/bookings?from=${encodeURIComponent(input.pickupAt)}&to=${encodeURIComponent(input.returnAt)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.deepEqual((await dateFiltered.json()).data.items.map((item) => item.id), [created.body.data.id])
      const invalidFilter = await fetch(`${server.baseUrl}/api/v1/bookings?from=${encodeURIComponent(input.returnAt)}&to=${encodeURIComponent(input.pickupAt)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(invalidFilter.status, 400)

      const laterPickup = new Date(returnAt.getTime() + 86_400_000)
      const later = await createBooking(server, token, bookingInput(
        vehicle.id,
        laterPickup.toISOString(),
        new Date(laterPickup.getTime() + 86_400_000).toISOString(),
      ))
      assert.equal(later.response.status, 201)
      const firstPageResponse = await fetch(`${server.baseUrl}/api/v1/bookings?limit=1&sort=pickupAt:asc`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const firstPage = (await firstPageResponse.json()).data
      assert.equal(firstPage.items.length, 1)
      assert.ok(firstPage.nextCursor)
      const secondPageResponse = await fetch(`${server.baseUrl}/api/v1/bookings?limit=1&sort=pickupAt:asc&cursor=${encodeURIComponent(firstPage.nextCursor)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const secondPage = (await secondPageResponse.json()).data
      assert.equal(secondPage.items.length, 1)
      assert.notEqual(firstPage.items[0].id, secondPage.items[0].id)

      const detail = await fetch(`${server.baseUrl}/api/v1/bookings/${created.body.data.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(detail.status, 200)
      assert.equal((await detail.json()).data.id, created.body.data.id)

      const unauthorizedList = await fetch(`${server.baseUrl}/api/v1/bookings`)
      assert.equal(unauthorizedList.status, 401)
      const driver = await createStaffSession('driver')
      try {
        const forbiddenList = await fetch(`${server.baseUrl}/api/v1/bookings`, {
          headers: { Authorization: `Bearer ${driver.token}` },
        })
        assert.equal(forbiddenList.status, 403)
        const forbiddenDetail = await fetch(`${server.baseUrl}/api/v1/bookings/${created.body.data.id}`, {
          headers: { Authorization: `Bearer ${driver.token}` },
        })
        assert.equal(forbiddenDetail.status, 403)
        await Booking.updateOne({ _id: created.body.data.id }, { $set: { driverId: driver.user.id } })
        const assignedDriverDetail = await fetch(`${server.baseUrl}/api/v1/bookings/${created.body.data.id}`, {
          headers: { Authorization: `Bearer ${driver.token}` },
        })
        assert.equal(assignedDriverDetail.status, 200)
      } finally {
        await driver.server.close()
      }

      const unavailableQuote = await fetch(`${server.baseUrl}/api/v1/quotes/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleId: input.vehicleId,
          pickupAt: input.pickupAt,
          returnAt: input.returnAt,
          pickupLocation: input.pickupLocation,
          mode: input.mode,
          extras: input.extras,
        }),
      })
      assert.equal(unavailableQuote.status, 409)
      assert.equal((await unavailableQuote.json()).error.code, 'VEHICLE_UNAVAILABLE')
    } finally {
      await server.close()
    }
  })

  it('expires holds lazily, releases availability, and rejects late approval', async () => {
    const { server, token } = await createStaffSession()
    try {
      const vehicle = await createVehicle(server, token)
      const pickupAt = new Date(Date.now() + 9 * 86_400_000)
      const returnAt = new Date(pickupAt.getTime() + 86_400_000)
      const input = bookingInput(vehicle.id, pickupAt.toISOString(), returnAt.toISOString(), { paymentMethod: 'cash' })
      const created = await createBooking(server, token, input)
      assert.equal(created.response.status, 201)
      await Booking.updateOne({ _id: created.body.data.id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } })

      const detail = await fetch(`${server.baseUrl}/api/v1/bookings/${created.body.data.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const expired = (await detail.json()).data
      assert.equal(expired.status, 'expired')
      assert.equal(expired.pendingApproval, false)
      assert.equal(expired.events.at(-1).type, 'hold.expired')

      const next = await createBooking(server, token, input)
      assert.equal(next.response.status, 201)

      const anotherPickup = new Date(Date.now() + 12 * 86_400_000)
      const another = await createBooking(server, token, bookingInput(
        vehicle.id,
        anotherPickup.toISOString(),
        new Date(anotherPickup.getTime() + 86_400_000).toISOString(),
        { paymentMethod: 'cash' },
      ))
      await Booking.updateOne({ _id: another.body.data.id }, { $set: { holdExpiresAt: new Date(Date.now() - 1000) } })
      const agent = await createStaffSession('agent')
      try {
        const approval = await fetch(`${server.baseUrl}/api/v1/bookings/${another.body.data.id}/offline-approval`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentMethod: 'cash', reference: 'RCPT-EXPIRED' }),
        })
        assert.equal(approval.status, 409)
        assert.equal((await approval.json()).error.code, 'HOLD_EXPIRED')
      } finally {
        await agent.server.close()
      }
    } finally {
      await server.close()
    }
  })

  it('enforces offline-approval, cancellation, and terminal-state transitions', async () => {
    const manager = await createStaffSession('manager')
    const agent = await createStaffSession('agent')
    try {
      const vehicle = await createVehicle(manager.server, manager.token)
      const pickupAt = new Date(Date.now() + 14 * 86_400_000)
      const returnAt = new Date(pickupAt.getTime() + 86_400_000)
      const created = await createBooking(manager.server, manager.token, bookingInput(
        vehicle.id,
        pickupAt.toISOString(),
        returnAt.toISOString(),
        { paymentMethod: 'cash' },
      ))
      const bookingId = created.body.data.id

      const selfApproval = await fetch(`${manager.server.baseUrl}/api/v1/bookings/${bookingId}/offline-approval`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${manager.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethod: 'cash', reference: 'RCPT-SELF' }),
      })
      assert.equal(selfApproval.status, 403)
      assert.equal((await selfApproval.json()).error.code, 'SELF_APPROVAL_FORBIDDEN')

      const approved = await fetch(`${manager.server.baseUrl}/api/v1/bookings/${bookingId}/offline-approval`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethod: 'cash', reference: 'RCPT-12345' }),
      })
      assert.equal(approved.status, 200)
      const confirmed = (await approved.json()).data
      assert.equal(confirmed.status, 'confirmed')
      assert.equal(confirmed.pendingApproval, false)
      assert.equal(confirmed.payments[0].status, 'paid')

      const paidCancellation = await fetch(`${manager.server.baseUrl}/api/v1/bookings/${bookingId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Customer request' }),
      })
      assert.equal(paidCancellation.status, 409)
      assert.equal((await paidCancellation.json()).error.code, 'REFUND_APPROVAL_REQUIRED')

      const anotherPickup = new Date(Date.now() + 17 * 86_400_000)
      const reserved = await createBooking(manager.server, manager.token, bookingInput(
        vehicle.id,
        anotherPickup.toISOString(),
        new Date(anotherPickup.getTime() + 86_400_000).toISOString(),
      ))
      const cancelled = await fetch(`${manager.server.baseUrl}/api/v1/bookings/${reserved.body.data.id}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${manager.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Duplicate request' }),
      })
      assert.equal(cancelled.status, 200)
      assert.equal((await cancelled.json()).data.status, 'cancelled')

      const repeatedCancellation = await fetch(`${manager.server.baseUrl}/api/v1/bookings/${reserved.body.data.id}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${manager.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      assert.equal(repeatedCancellation.status, 409)
      assert.equal((await repeatedCancellation.json()).error.code, 'INVALID_STATUS')
    } finally {
      await manager.server.close()
      await agent.server.close()
    }
  })

  it('rejects duplicate registrations and prevents agents from managing fleet records', async () => {
    const manager = await createStaffSession()
    const agent = await createStaffSession('agent')
    try {
      await createVehicle(manager.server, manager.token)
      const duplicate = await fetch(`${manager.server.baseUrl}/api/v1/vehicles`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${manager.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(vehicleInput({ registration: 'kda 234a' })),
      })
      assert.equal(duplicate.status, 409)

      const forbidden = await fetch(`${agent.server.baseUrl}/api/v1/vehicles`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(vehicleInput({ registration: 'KDA 236A' })),
      })
      assert.equal(forbidden.status, 403)
    } finally {
      await manager.server.close()
      await agent.server.close()
    }
  })
})
