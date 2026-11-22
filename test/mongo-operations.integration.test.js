const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { after, before, beforeEach, describe, it } = require('node:test')
const mongoose = require('mongoose')
const { configureTestEnvironment, startTestServer, testEnvironment, testLogger } = require('../test-support/helpers')
const authMigration = require('../migrations/20261122000000-auth-indexes')
const fleetMigration = require('../migrations/20261122000001-fleet-availability')
const bookingMigration = require('../migrations/20261122000002-booking-lifecycle')
const paymentMigration = require('../migrations/20261122000003-guest-checkout-payments')
const operationsMigration = require('../migrations/20261122000004-phase-five-operations')
const publicBookingMigration = require('../migrations/20261123000000-public-booking-and-extensions')
const { hashGuestToken } = require('../src/services/guest-booking-service')

configureTestEnvironment()

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
let MongoMemoryReplSet
let User
let Vehicle
let Booking
let Mechanic
let Incident
let GuestAccess
let BookingExtension
let server
let mongo
let uploadDirectory

before(async () => {
  process.env.MONGOMS_VERSION ||= '4.4.29'
  ;({ MongoMemoryReplSet } = require('mongodb-memory-server-core'))
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger', launchTimeout: 60000 },
  })
  process.env.MONGODB_URI = mongo.getUri('autohire-phase5-test')
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'autohire-phase5-test' })
  await authMigration.up(mongoose.connection.db)
  await fleetMigration.up(mongoose.connection.db)
  await bookingMigration.up(mongoose.connection.db)
  await paymentMigration.up(mongoose.connection.db)
  await operationsMigration.up(mongoose.connection.db)
  await publicBookingMigration.up(mongoose.connection.db)

  ;({ User, Vehicle, Booking, Mechanic, Incident, GuestAccess, BookingExtension } = require('../src/models'))
  uploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'autohire-phase5-'))
  const { createApp } = require('../src/app')
  server = await startTestServer(createApp({
    env: testEnvironment({ PRIVATE_UPLOAD_DIR: uploadDirectory }),
    logger: testLogger(),
    mailer: { async sendInvitation() {}, async sendPasswordReset() {} },
    isDatabaseReady: () => mongoose.connection.readyState === 1,
  }))
})

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})))
})

after(async () => {
  if (server) await server.close()
  await mongoose.disconnect()
  if (mongo) await mongo.stop()
  if (uploadDirectory) await fs.rm(uploadDirectory, { recursive: true, force: true })
})

async function createActor(role, suffix, driverProfile) {
  const password = 'Phase-five-password-123!'
  const user = await User.create({
    name: `${role} ${suffix}`,
    email: `${role}-${suffix}@example.test`,
    phone: '254712345678',
    passwordHash: await bcrypt.hash(password, 4),
    role,
    branch: 'Nairobi HQ',
    active: true,
    ...(driverProfile ? { driverProfile } : {}),
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

async function createBooking(actor, vehicle, overrides = {}) {
  const pickupAt = new Date(Date.now() + 86_400_000)
  return Booking.create({
    reference: `BK-${Math.random().toString(36).slice(2, 12).toUpperCase()}`,
    vehicleId: vehicle._id,
    customerId: `cus-${Math.random().toString(36).slice(2, 10)}`,
    customerName: 'Customer Example',
    customerPhone: '254712345679',
    customerEmail: 'customer@example.test',
    customerIdNumber: '12345678',
    status: 'confirmed',
    pendingApproval: false,
    pickupAt,
    returnAt: new Date(pickupAt.getTime() + 86_400_000),
    totalKes: 18_560,
    mode: 'chauffeur',
    paymentMethod: 'cash',
    holdExpiresAt: new Date(Date.now() + 15 * 60_000),
    createdById: actor._id,
    pricingSnapshot: { baseDays: 1, totalDueKes: 18_560 },
    payments: [],
    events: [],
    ...overrides,
  })
}

async function json(response) {
  return response.json()
}

describe('Phase 5 operations API', () => {
  it('creates a public guest hold with authoritative quote, expiry, and idempotent replay', async () => {
    const vehicle = await createVehicle()
    const pickupAt = new Date(Date.now() + 2 * 86_400_000)
    const returnAt = new Date(pickupAt.getTime() + 2 * 86_400_000)
    const key = '2a5ded88-6380-4b6c-a7cf-946fc87956d1'
    const body = {
      vehicleId: String(vehicle._id),
      pickupAt: pickupAt.toISOString(),
      returnAt: returnAt.toISOString(),
      pickupLocation: 'Nairobi CBD',
      mode: 'self_drive',
      extras: [],
    }
    const create = () => fetch(`${server.baseUrl}/api/v1/bookings/guest-holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    })
    const response = await create()
    assert.equal(response.status, 201)
    const result = await json(response)
    const expiresAt = Date.parse(result.data.holdExpiresAt)
    assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 15 * 60_000 + 1_000)

    const checkout = await fetch(`${server.baseUrl}/api/v1/bookings/${result.data.bookingId}/checkout`)
    assert.equal(checkout.status, 200)
    const checkoutData = (await json(checkout)).data
    assert.equal(checkoutData.booking.paymentMethod, 'mpesa_online')
    assert.equal(checkoutData.booking.totalKes, 18_560)
    assert.equal(checkoutData.vehicle.id, String(vehicle._id))

    const replay = await create()
    assert.equal(replay.status, 201)
    assert.equal((await json(replay)).data.bookingId, result.data.bookingId)

    const conflict = await fetch(`${server.baseUrl}/api/v1/bookings/guest-holds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ ...body, pickupLocation: 'Westlands' }),
    })
    assert.equal(conflict.status, 409)
    assert.equal((await json(conflict)).error.code, 'IDEMPOTENCY_CONFLICT')
  })

  it('lets active guests request an extension and requires staff payment proof to approve it', async () => {
    const manager = await createActor('manager', 'extension')
    const vehicle = await createVehicle()
    const now = Date.now()
    const pickupAt = new Date(now - 23 * 60 * 60_000)
    const returnAt = new Date(now + 60 * 60_000)
    const booking = await createBooking(manager.user, vehicle, {
      status: 'checked_out',
      pickupAt,
      returnAt,
      mode: 'self_drive',
      totalKes: 9_280,
      pricingSnapshot: {
        baseDays: 1,
        baseRateKes: 8_000,
        baseAmountKes: 8_000,
        chauffeurFeeKes: 0,
        driverLocation: 'in_town',
        extras: [],
        vatRate: 16,
        vatAmountKes: 1_280,
        totalDueKes: 9_280,
        refundableDepositKes: 15_000,
      },
    })
    const sessionToken = 'test-guest-session-token-with-sufficient-entropy'
    await GuestAccess.create({
      bookingId: booking._id,
      reference: booking.reference,
      sessionTokenHash: hashGuestToken(sessionToken),
      expiresAt: new Date(now + 30 * 86_400_000),
      revokedAt: null,
    })
    const requestedReturnAt = new Date(now + 25 * 60 * 60_000)
    const requestResponse = await fetch(`${server.baseUrl}/api/v1/bookings/${booking.reference}/extensions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `booking_access=${sessionToken}` },
      body: JSON.stringify({ requestedReturnAt: requestedReturnAt.toISOString(), reason: 'Travel plans changed' }),
    })
    assert.equal(requestResponse.status, 201)
    const extension = (await json(requestResponse)).data
    assert.equal(extension.feeKes, 9_280)

    const notifications = await fetch(`${server.baseUrl}/api/v1/notifications`, { headers: authHeaders(manager.token) })
    assert.equal((await json(notifications)).data.pendingExtensions, 1)

    const approvals = await fetch(`${server.baseUrl}/api/v1/extensions?status=pending`, { headers: authHeaders(manager.token) })
    assert.equal(approvals.status, 200)
    assert.equal((await json(approvals)).data.items[0].id, extension.id)
    const missingPayment = await fetch(`${server.baseUrl}/api/v1/extensions/${extension.id}/decision`, {
      method: 'POST',
      headers: authHeaders(manager.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ decision: 'approve' }),
    })
    assert.equal(missingPayment.status, 400)

    const decision = await fetch(`${server.baseUrl}/api/v1/extensions/${extension.id}/decision`, {
      method: 'POST',
      headers: authHeaders(manager.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ decision: 'approve', paymentMethod: 'cash', paymentReference: 'RCPT-EXT-100' }),
    })
    assert.equal(decision.status, 200)
    assert.equal((await json(decision)).data.status, 'approved')
    const updatedBooking = await Booking.findById(booking._id).lean()
    assert.equal(updatedBooking.returnAt.toISOString(), requestedReturnAt.toISOString())
    assert.equal(updatedBooking.totalKes, 18_560)
    assert.equal(updatedBooking.payments[0].reference, 'RCPT-EXT-100')
    assert.equal((await BookingExtension.findById(extension.id).lean()).feeKes, 9_280)
    const clearedNotifications = await fetch(`${server.baseUrl}/api/v1/notifications`, { headers: authHeaders(manager.token) })
    assert.equal((await json(clearedNotifications)).data.pendingExtensions, 0)
  })

  it('serializes driver assignment, enforces assigned-trip ownership, and validates trip transitions', async () => {
    const manager = await createActor('manager', 'assign')
    const driver = await createActor('driver', 'assign', {
      languages: ['English', 'Kiswahili'],
      licenceClass: 'B',
      licenceExpiresAt: new Date(Date.now() + 365 * 86_400_000),
      psvExpiresAt: new Date(Date.now() + 365 * 86_400_000),
      rating: 4.5,
    })
    const otherDriver = await createActor('driver', 'other', {
      languages: ['English'],
      licenceClass: 'B',
      licenceExpiresAt: new Date(Date.now() + 365 * 86_400_000),
      psvExpiresAt: new Date(Date.now() + 365 * 86_400_000),
      rating: 4,
    })
    const firstVehicle = await createVehicle()
    const secondVehicle = await createVehicle()
    const firstBooking = await createBooking(manager.user, firstVehicle)
    const secondBooking = await createBooking(manager.user, secondVehicle)
    const assign = (bookingId) => fetch(`${server.baseUrl}/api/v1/bookings/${bookingId}/driver`, {
      method: 'POST',
      headers: authHeaders(manager.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ driverId: String(driver.user._id) }),
    })

    const assignments = await Promise.all([assign(firstBooking._id), assign(secondBooking._id)])
    assert.deepEqual(assignments.map((response) => response.status).sort(), [200, 409])
    const assigned = await Booking.find({ driverId: driver.user._id }).lean()
    assert.equal(assigned.length, 1)

    const bookingId = String(assigned[0]._id)
    const forbiddenUpdate = await fetch(`${server.baseUrl}/api/v1/bookings/${bookingId}/driver-status`, {
      method: 'POST',
      headers: authHeaders(otherDriver.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ status: 'en_route_to_pickup' }),
    })
    assert.equal(forbiddenUpdate.status, 403)
    assert.equal((await json(forbiddenUpdate)).error.code, 'FORBIDDEN')

    const skippedTransition = await fetch(`${server.baseUrl}/api/v1/bookings/${bookingId}/driver-status`, {
      method: 'POST',
      headers: authHeaders(driver.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ status: 'customer_onboard' }),
    })
    assert.equal(skippedTransition.status, 409)
    assert.equal((await json(skippedTransition)).error.code, 'INVALID_TRIP_STATUS')

    for (const status of ['en_route_to_pickup', 'customer_onboard', 'trip_completed']) {
      const response = await fetch(`${server.baseUrl}/api/v1/bookings/${bookingId}/driver-status`, {
        method: 'POST',
        headers: authHeaders(driver.token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status }),
      })
      assert.equal(response.status, 200)
    }
    assert.equal((await Booking.findById(bookingId)).status, 'completed')

    const ownTrips = await fetch(`${server.baseUrl}/api/v1/drivers/me/trips`, { headers: authHeaders(driver.token) })
    assert.equal((await json(ownTrips)).data.items.length, 1)
    const otherTrips = await fetch(`${server.baseUrl}/api/v1/drivers/me/trips`, { headers: authHeaders(otherDriver.token) })
    assert.equal((await json(otherTrips)).data.items.length, 0)
  })

  it('stores authorized inspection photos and persists server-calculated settlement', async () => {
    const manager = await createActor('manager', 'handover')
    const otherDriver = await createActor('driver', 'handover-other', {
      languages: ['English'],
      licenceClass: 'B',
      licenceExpiresAt: new Date(Date.now() + 365 * 86_400_000),
      psvExpiresAt: new Date(Date.now() + 365 * 86_400_000),
      rating: 4,
    })
    const vehicle = await createVehicle()
    const now = Date.now()
    const booking = await createBooking(manager.user, vehicle, {
      mode: 'self_drive',
      pickupAt: new Date(now - 2 * 86_400_000),
      returnAt: new Date(now - 3.25 * 60 * 60_000),
    })

    async function upload(type) {
      const form = new FormData()
      form.set('type', type)
      form.set('file', new Blob([png], { type: 'image/png' }), `${type}.png`)
      const response = await fetch(`${server.baseUrl}/api/v1/bookings/${booking._id}/inspections/photos`, {
        method: 'POST',
        headers: authHeaders(manager.token),
        body: form,
      })
      assert.equal(response.status, 201)
      return (await json(response)).data.url
    }

    const checkoutPhoto = await upload('check_out')
    const checkout = await fetch(`${server.baseUrl}/api/v1/bookings/${booking._id}/check-out`, {
      method: 'POST',
      headers: authHeaders(manager.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        odometer: 100,
        fuelLevel: 'half',
        notes: 'Pickup inspection',
        photos: [checkoutPhoto],
        signatureConfirmed: true,
        criticalDefect: false,
      }),
    })
    assert.equal(checkout.status, 200)

    const unauthorizedPhoto = await fetch(`${server.baseUrl}${checkoutPhoto}`, {
      headers: authHeaders(otherDriver.token),
    })
    assert.equal(unauthorizedPhoto.status, 403)

    const preview = await fetch(`${server.baseUrl}/api/v1/bookings/${booking._id}/check-in/settlement`, {
      method: 'POST',
      headers: authHeaders(manager.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ odometer: 250 }),
    })
    const settlement = (await json(preview)).data
    assert.equal(settlement.lateHours, 2)
    assert.equal(settlement.lateFeeKes, 3000)
    assert.equal(settlement.excessMileageKm, 50)
    assert.equal(settlement.excessMileageChargeKes, 2500)
    assert.equal(settlement.totalKes, 5500)

    const checkinPhoto = await upload('check_in')
    const checkin = await fetch(`${server.baseUrl}/api/v1/bookings/${booking._id}/check-in`, {
      method: 'POST',
      headers: authHeaders(manager.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        odometer: 250,
        fuelLevel: 'quarter',
        notes: 'Critical defect found',
        photos: [checkinPhoto],
        signatureConfirmed: true,
        criticalDefect: true,
      }),
    })
    assert.equal(checkin.status, 200)
    const savedBooking = (await json(checkin)).data
    assert.equal(savedBooking.status, 'completed')
    assert.equal(savedBooking.inspections[1].settlement.totalKes, 5500)
    assert.deepEqual(savedBooking.inspections[1].photos, [checkinPhoto])
    assert.equal((await Vehicle.findById(vehicle._id)).status, 'maintenance')
    const retrievedPhoto = await fetch(`${server.baseUrl}${checkinPhoto}`, { headers: authHeaders(manager.token) })
    assert.equal(retrievedPhoto.status, 200)
    assert.equal(retrievedPhoto.headers.get('content-type'), 'image/png')
  })

  it('stores private incident photos, finds nearby mechanics, dispatches, and records resolution', async () => {
    const manager = await createActor('manager', 'incident')
    const mechanicActor = await createActor('mechanic', 'incident')
    const mechanicResponse = await fetch(`${server.baseUrl}/api/v1/mechanics`, {
      method: 'POST',
      headers: authHeaders(manager.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: 'Nairobi Partner Garage',
        phone: '254712345670',
        whatsapp: '254712345670',
        county: 'Nairobi',
        town: 'Nairobi',
        type: 'partner_garage',
        specialties: ['flat_tyre'],
        callOutRateKes: 1200,
        location: { type: 'Point', coordinates: [36.8172, -1.2864] },
      }),
    })
    assert.equal(mechanicResponse.status, 201)
    const mechanicId = (await json(mechanicResponse)).data.id

    const form = new FormData()
    form.set('category', 'flat_tyre')
    form.set('description', 'A flat tyre on the roadside')
    form.set('location', JSON.stringify({ type: 'Point', coordinates: [36.8173, -1.2865] }))
    form.set('locationText', 'Nairobi CBD')
    form.set('immobilising', 'true')
    form.append('photos', new Blob([png], { type: 'image/png' }), 'incident.png')
    const createIncident = await fetch(`${server.baseUrl}/api/v1/incidents/breakdown`, {
      method: 'POST',
      body: form,
    })
    assert.equal(createIncident.status, 201)
    const incident = (await json(createIncident)).data
    assert.equal(incident.source, 'customer')
    assert.equal(incident.photos.length, 1)

    const nearby = await fetch(`${server.baseUrl}/api/v1/mechanics/nearest?lat=-1.2865&lng=36.8173&radiusKm=50&limit=5&category=flat_tyre`, {
      headers: authHeaders(manager.token),
    })
    assert.equal((await json(nearby)).data[0].id, mechanicId)

    const photo = await fetch(`${server.baseUrl}/api/v1${incident.photos[0]}`, { headers: authHeaders(manager.token) })
    assert.equal(photo.status, 200)

    const dispatch = await fetch(`${server.baseUrl}/api/v1/incidents/${incident.id}/dispatch`, {
      method: 'PATCH',
      headers: authHeaders(manager.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ type: 'closest_partner' }),
    })
    assert.equal(dispatch.status, 200)
    const dispatched = (await json(dispatch)).data
    assert.equal(dispatched.status, 'dispatched')
    assert.equal(dispatched.dispatch.mechanicId, mechanicId)

    const resolve = await fetch(`${server.baseUrl}/api/v1/incidents/${incident.id}/resolve`, {
      method: 'POST',
      headers: authHeaders(mechanicActor.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ resolution: 'Tyre replaced and vehicle is safe to continue.' }),
    })
    assert.equal(resolve.status, 200)
    const resolved = (await json(resolve)).data
    assert.equal(resolved.status, 'resolved')
    assert.equal(resolved.resolution, 'Tyre replaced and vehicle is safe to continue.')
    assert.equal(await Incident.countDocuments({ status: 'resolved' }), 1)
  })

  it('requires driver qualifications when inviting a driver', async () => {
    const manager = await createActor('manager', 'invite')
    const response = await fetch(`${server.baseUrl}/api/v1/staff`, {
      method: 'POST',
      headers: authHeaders(manager.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: 'Grace Driver',
        email: 'grace-driver@example.test',
        phone: '254712345679',
        role: 'driver',
        branch: 'Nairobi HQ',
        driverProfile: {
          languages: ['English', 'Kiswahili'],
          licenceClass: 'B',
          licenceExpiresAt: '2028-04-30T00:00:00.000Z',
          psvExpiresAt: '2028-04-30T00:00:00.000Z',
        },
      }),
    })
    assert.equal(response.status, 201)
    const invitation = await mongoose.connection.db.collection('staffinvitations').findOne({ email: 'grace-driver@example.test' })
    assert.deepEqual(invitation.driverProfile.languages, ['English', 'Kiswahili'])
    assert.equal(invitation.driverProfile.licenceClass, 'B')
  })
})
