const { createHash, randomUUID, randomBytes } = require('node:crypto')
const mongoose = require('mongoose')
const { Booking, Incident, MaintenanceWindow, Vehicle } = require('../models')
const { AppError } = require('../lib/errors')
const { expireHolds, expireOverdueBookings } = require('./mongo-system-transitions')

const blockingBookingStatuses = ['confirmed', 'checked_out', 'overdue']

function idString(value) {
  return String(value?._id ?? value)
}

function vehicleView(vehicle, status = vehicle.status) {
  const value = typeof vehicle.toObject === 'function' ? vehicle.toObject() : vehicle
  const { _id, __v, registrationKey, availabilityRevision, ...fields } = value
  return { id: idString(_id), ...fields, status }
}

function maintenanceView(window) {
  const value = typeof window.toObject === 'function' ? window.toObject() : window
  const { _id, __v, ...fields } = value
  return { id: idString(_id), ...fields, vehicleId: idString(fields.vehicleId) }
}

function bookingView(booking) {
  const value = typeof booking.toObject === 'function' ? booking.toObject() : booking
  const { _id, __v, driverId, idempotencyKey, idempotencyRequestHash, pendingInspectionPhotos, ...fields } = value
  delete fields.licence
  for (const inspection of fields.inspections ?? []) inspection.photos = (inspection.photos ?? []).map((photo) => photo.url)
  const driver = driverId && typeof driverId === 'object' && driverId.name
    ? {
        id: idString(driverId),
        name: driverId.name,
        email: driverId.email,
        phone: driverId.phone,
        role: driverId.role,
        branch: driverId.branch,
        active: driverId.active,
      }
    : undefined
  return {
    id: idString(_id),
    ...fields,
    vehicleId: idString(fields.vehicleId),
    ...(fields.vehicleId && typeof fields.vehicleId === 'object' && fields.vehicleId.make
      ? { vehicleName: `${fields.vehicleId.make} ${fields.vehicleId.model}` }
      : {}),
    createdById: idString(fields.createdById),
    ...(driverId ? { driverId: idString(driverId) } : {}),
    ...(driver ? { driver } : {}),
  }
}

function registrationKey(registration) {
  return registration.trim().replace(/\s+/g, ' ').toUpperCase()
}

function makeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function parseCursor(cursor, fields) {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!value || fields.some((field) => typeof value[field] !== 'string')) throw new Error('Invalid cursor')
    return value
  } catch {
    throw new AppError(400, 'INVALID_QUERY', 'Pagination cursor is invalid')
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function makeBookingCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function parseBookingCursor(cursor, sort) {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (value.sort !== sort || typeof value.value !== 'string' || !mongoose.Types.ObjectId.isValid(value.id)
      || !Number.isFinite(Date.parse(value.value))) throw new Error('Invalid booking cursor')
    return value
  } catch {
    throw new AppError(400, 'INVALID_QUERY', 'Pagination cursor is invalid')
  }
}

function requestHash(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function bookingEvent(type, actor, note, createdAt = new Date()) {
  return { id: randomUUID(), type, actor, note, createdAt }
}

function nairobiDayRange(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type) => parts.find((item) => item.type === type).value
  const start = Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day'))) - 3 * 60 * 60 * 1000
  return { start: new Date(start), end: new Date(start + 24 * 60 * 60 * 1000) }
}

function bookingOverlapQuery(from, to, now) {
  return {
    pickupAt: { $lt: to },
    returnAt: { $gt: from },
    $or: [
      { status: { $in: blockingBookingStatuses } },
      { status: 'reserved', holdExpiresAt: { $gt: now } },
    ],
  }
}

function activeBookingQuery(now) {
  return {
    $or: [
      { status: { $in: blockingBookingStatuses } },
      { status: 'reserved', holdExpiresAt: { $gt: now } },
    ],
  }
}

async function unavailableVehicleIds(from, to, now) {
  const [bookedIds, maintenanceIds, incidentVehicleIds] = await Promise.all([
    Booking.distinct('vehicleId', bookingOverlapQuery(from, to, now)),
    MaintenanceWindow.distinct('vehicleId', { startAt: { $lt: to }, endAt: { $gt: from } }),
    Incident.distinct('dispatch.vehicleId', {
      status: { $in: ['awaiting_replacement', 'dispatched'] },
      'dispatch.vehicleId': { $exists: true },
    }),
  ])
  return [...bookedIds, ...maintenanceIds, ...incidentVehicleIds]
}

async function vehicleStatus(vehicle, now) {
  if (vehicle.status !== 'available') return vehicle.status
  const to = new Date(now.getTime() + 1)
  const [booking, maintenance, incidentDispatch] = await Promise.all([
    Booking.exists({ vehicleId: vehicle._id, ...bookingOverlapQuery(now, to, now) }),
    MaintenanceWindow.exists({ vehicleId: vehicle._id, startAt: { $lt: to }, endAt: { $gt: now } }),
    Incident.exists({ 'dispatch.vehicleId': vehicle._id, status: { $in: ['awaiting_replacement', 'dispatched'] } }),
  ])
  if (maintenance) return 'maintenance'
  return booking || incidentDispatch ? 'booked' : 'available'
}

async function withVehicleTransaction(vehicleId, operation) {
  const session = await mongoose.startSession()
  let result
  try {
    await session.withTransaction(async () => {
      const vehicle = await Vehicle.findById(vehicleId).session(session)
      if (!vehicle) throw new AppError(404, 'NOT_FOUND', 'Vehicle was not found')
      const write = await Vehicle.updateOne({ _id: vehicleId }, { $inc: { availabilityRevision: 1 } }, { session })
      if (write.modifiedCount !== 1) throw new AppError(409, 'CONFLICT', 'Vehicle changed while this request was being processed')
      result = await operation(vehicle, session)
    })
    return result
  } finally {
    await session.endSession()
  }
}

const fleetRepository = {
  async listVehicles({ from, to, limit, cursor, now = new Date() }) {
    const position = parseCursor(cursor, ['registrationKey'])
    let filter = {}
    if (from && to) {
      const unavailableIds = await unavailableVehicleIds(from, to, now)
      filter = { status: 'available', _id: { $nin: unavailableIds } }
    }
    if (position) filter.registrationKey = { $gt: position.registrationKey }

    const rows = await Vehicle.find(filter)
      .select('+registrationKey')
      .sort({ registrationKey: 1 })
      .limit(limit + 1)
      .lean()
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const items = await Promise.all(pageRows.map(async (vehicle) => {
      const status = from && to ? 'available' : await vehicleStatus(vehicle, now)
      return vehicleView(vehicle, status)
    }))
    const nextCursor = hasMore
      ? makeCursor({ registrationKey: pageRows[pageRows.length - 1].registrationKey })
      : null
    return { items, nextCursor }
  },

  async findVehicleById(id, now = new Date()) {
    const vehicle = await Vehicle.findById(id).lean()
    return vehicle ? vehicleView(vehicle, await vehicleStatus(vehicle, now)) : null
  },

  async isVehicleAvailableForPeriod(id, from, to, now = new Date()) {
    const vehicle = await Vehicle.findById(id).lean()
    if (!vehicle || vehicle.status !== 'available') return false
    const overlap = {
      vehicleId: vehicle._id,
      pickupAt: { $lt: to },
      returnAt: { $gt: from },
      $or: [
        { status: { $in: blockingBookingStatuses } },
        { status: 'reserved', holdExpiresAt: { $gt: now } },
      ],
    }
    const [booking, maintenance, incidentDispatch] = await Promise.all([
      Booking.exists(overlap),
      MaintenanceWindow.exists({
        vehicleId: vehicle._id,
        startAt: { $lt: to },
        endAt: { $gt: from },
      }),
      Incident.exists({ 'dispatch.vehicleId': vehicle._id, status: { $in: ['awaiting_replacement', 'dispatched'] } }),
    ])
    return !booking && !maintenance && !incidentDispatch
  },

  async createVehicle(input) {
    const vehicle = await Vehicle.create({
      ...input,
      registrationKey: registrationKey(input.registration),
      status: input.status ?? 'available',
    })
    return vehicleView(vehicle)
  },

  async updateVehicle(id, patch, now = new Date()) {
    return withVehicleTransaction(id, async (vehicle, session) => {
      if (patch.status && patch.status !== 'available') {
        const [activeBooking, activeIncident] = await Promise.all([
          Booking.exists({ vehicleId: id, ...activeBookingQuery(now) }).session(session),
          Incident.exists({ 'dispatch.vehicleId': id, status: { $in: ['awaiting_replacement', 'dispatched'] } }).session(session),
        ])
        if (activeBooking || activeIncident) throw new AppError(409, 'VEHICLE_UNAVAILABLE', 'A vehicle with an active reservation or dispatch cannot be disabled')
      }

      const update = { ...patch }
      if (patch.registration !== undefined) update.registrationKey = registrationKey(patch.registration)
      const updated = await Vehicle.findByIdAndUpdate(
        id,
        { $set: update },
        { returnDocument: 'after', runValidators: true, session },
      )
      return vehicleView(updated)
    })
  },

  async listMaintenanceWindows({ from, to, limit, cursor }) {
    const position = parseCursor(cursor, ['startAt', 'id'])
    if (position && (!Number.isFinite(Date.parse(position.startAt)) || !mongoose.Types.ObjectId.isValid(position.id))) {
      throw new AppError(400, 'INVALID_QUERY', 'Pagination cursor is invalid')
    }
    const filter = { startAt: { $lt: to }, endAt: { $gt: from } }
    if (position) {
      filter.$or = [
        { startAt: { $gt: new Date(position.startAt) } },
        { startAt: new Date(position.startAt), _id: { $gt: new mongoose.Types.ObjectId(position.id) } },
      ]
    }
    const rows = await MaintenanceWindow.find(filter).sort({ startAt: 1, _id: 1 }).limit(limit + 1).lean()
    const hasMore = rows.length > limit
    const items = (hasMore ? rows.slice(0, limit) : rows).map(maintenanceView)
    const last = items[items.length - 1]
    return {
      items,
      nextCursor: hasMore ? makeCursor({ startAt: last.startAt.toISOString(), id: last.id }) : null,
    }
  },

  async createMaintenanceWindow(input, createdById, now = new Date()) {
    return withVehicleTransaction(input.vehicleId, async (vehicle, session) => {
      const [conflict, incidentConflict] = await Promise.all([Booking.exists({
        vehicleId: vehicle._id,
        ...bookingOverlapQuery(input.startAt, input.endAt, now),
      }).session(session), Incident.exists({
        'dispatch.vehicleId': vehicle._id,
        status: { $in: ['awaiting_replacement', 'dispatched'] },
      }).session(session)])
      if (conflict || incidentConflict) throw new AppError(409, 'VEHICLE_UNAVAILABLE', 'Maintenance overlaps an active reservation or dispatch')
      const [window] = await MaintenanceWindow.create([{ ...input, createdById }], { session })
      return maintenanceView(window)
    })
  },

  async updateMaintenanceWindow(id, patch, now = new Date()) {
    const initialWindow = await MaintenanceWindow.findById(id).lean()
    if (!initialWindow) return null
    return withVehicleTransaction(initialWindow.vehicleId, async (vehicle, session) => {
      const window = await MaintenanceWindow.findById(id).session(session).lean()
      if (!window) return null
      const startAt = patch.startAt ?? window.startAt
      const endAt = patch.endAt ?? window.endAt
      if (endAt <= startAt) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Maintenance end time must be after its start time')
      }
      const [conflict, incidentConflict] = await Promise.all([Booking.exists({
        vehicleId: vehicle._id,
        ...bookingOverlapQuery(startAt, endAt, now),
      }).session(session), Incident.exists({
        'dispatch.vehicleId': vehicle._id,
        status: { $in: ['awaiting_replacement', 'dispatched'] },
      }).session(session)])
      if (conflict || incidentConflict) throw new AppError(409, 'VEHICLE_UNAVAILABLE', 'Maintenance overlaps an active reservation or dispatch')
      const updated = await MaintenanceWindow.findByIdAndUpdate(id, { $set: patch }, { returnDocument: 'after', runValidators: true, session })
      return updated ? maintenanceView(updated) : null
    })
  },

  async deleteMaintenanceWindow(id) {
    const window = await MaintenanceWindow.findById(id).lean()
    if (!window) return false
    return withVehicleTransaction(window.vehicleId, async (_vehicle, session) => {
      const result = await MaintenanceWindow.deleteOne({ _id: id }, { session })
      return result.deletedCount === 1
    })
  },

  async createBooking(input, actor, quoteForVehicle, idempotencyKey, now = new Date()) {
    const payloadHash = idempotencyKey ? requestHash(input) : null
    try {
      return await withVehicleTransaction(input.vehicleId, async (vehicle, session) => {
        if (idempotencyKey) {
          const prior = await Booking.findOne({ createdById: actor.id, idempotencyKey })
            .select('+idempotencyRequestHash')
            .session(session)
            .lean()
          if (prior) {
            if (prior.idempotencyRequestHash !== payloadHash) {
              throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different request')
            }
            return bookingView(prior)
          }
        }

        if (vehicle.status !== 'available') {
          throw new AppError(409, 'VEHICLE_UNAVAILABLE', 'This vehicle is not available for reservation')
        }
        const overlap = bookingOverlapQuery(input.pickupAt, input.returnAt, now)
        const [bookingConflict, maintenanceConflict, incidentConflict] = await Promise.all([
          Booking.exists({ vehicleId: vehicle._id, ...overlap }).session(session),
          MaintenanceWindow.exists({
          vehicleId: vehicle._id,
          startAt: { $lt: input.returnAt },
          endAt: { $gt: input.pickupAt },
          }).session(session),
          Incident.exists({ 'dispatch.vehicleId': vehicle._id, status: { $in: ['awaiting_replacement', 'dispatched'] } }).session(session),
        ])
        if (bookingConflict || maintenanceConflict || incidentConflict) {
          throw new AppError(409, 'VEHICLE_UNAVAILABLE', 'This vehicle is not available for those dates')
        }

        const quote = quoteForVehicle(vehicle)
        const reference = `BK-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`
        const [booking] = await Booking.create([{
          reference,
          vehicleId: vehicle._id,
          customerId: `cus-${randomUUID()}`,
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          customerEmail: input.customerEmail,
          customerIdNumber: input.customerIdNumber,
          pickupLocation: input.pickupLocation,
          status: 'reserved',
          pendingApproval: input.paymentMethod !== 'mpesa_online',
          pickupAt: input.pickupAt,
          returnAt: input.returnAt,
          totalKes: quote.pricingSnapshot.totalDueKes,
          pricingSnapshot: quote.pricingSnapshot,
          mode: input.mode,
          paymentMethod: input.paymentMethod,
          holdExpiresAt: new Date(now.getTime() + 15 * 60_000),
          createdById: actor.id,
          payments: [],
          events: [bookingEvent('booking.reserved', actor.name, 'Booking hold created', now)],
          ...(idempotencyKey ? { idempotencyKey, idempotencyRequestHash: payloadHash } : {}),
        }], { session })
        return bookingView(booking)
      })
    } catch (error) {
      if (error.code !== 11000 || !idempotencyKey) throw error
      const prior = await Booking.findOne({ createdById: actor.id, idempotencyKey })
        .select('+idempotencyRequestHash')
        .lean()
      if (!prior) throw error
      if (prior.idempotencyRequestHash !== payloadHash) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different request')
      }
      return bookingView(prior)
    }
  },

  async listBookings(query, now = new Date()) {
    await expireHolds(now)
    await expireOverdueBookings(now)
    const { limit, cursor, sort = 'pickupAt:asc' } = query
    const position = parseBookingCursor(cursor, sort)
    const filter = {}
    const conditions = []
    if (query.status) {
      filter.status = query.status === 'cancelled' ? { $in: ['cancelled', 'expired'] } : query.status
    }
    if (query.paymentMethod) filter.paymentMethod = query.paymentMethod
    if (query.vehicleId) filter.vehicleId = query.vehicleId
    if (query.search) {
      const pattern = new RegExp(escapeRegex(query.search), 'i')
      filter.$or = [
        { reference: pattern },
        { customerName: pattern },
        { customerEmail: pattern },
        { customerPhone: pattern },
      ]
    }
    if (query.from || query.to) {
      const interval = {}
      if (query.from) interval.returnAt = { $gt: query.from }
      if (query.to) interval.pickupAt = { $lt: query.to }
      conditions.push(interval)
    }
    const today = nairobiDayRange(now)
    if (query.pickup === 'due-today') {
      conditions.push({ status: 'confirmed', pickupAt: { $gte: today.start, $lt: today.end } })
    }
    if (query.return === 'due-today') {
      conditions.push({ status: { $in: ['checked_out', 'overdue'] }, returnAt: { $gte: today.start, $lt: today.end } })
    }
    if (position) {
      const field = sort === 'createdAt:desc' ? 'createdAt' : 'pickupAt'
      const direction = sort === 'pickupAt:asc' ? 1 : -1
      const value = new Date(position.value)
      conditions.push({ $or: [
          { [field]: direction > 0 ? { $gt: value } : { $lt: value } },
          { [field]: value, _id: direction > 0 ? { $gt: new mongoose.Types.ObjectId(position.id) } : { $lt: new mongoose.Types.ObjectId(position.id) } },
        ] })
    }
    if (conditions.length) filter.$and = conditions
    const direction = sort === 'pickupAt:asc' ? 1 : -1
    const field = sort === 'createdAt:desc' ? 'createdAt' : 'pickupAt'
    const rows = await Booking.find(filter)
      .populate({ path: 'driverId', select: 'name email phone role branch active' })
      .sort({ [field]: direction, _id: direction })
      .limit(limit + 1)
      .lean()
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const last = pageRows[pageRows.length - 1]
    return {
      items: pageRows.map(bookingView),
      nextCursor: hasMore ? makeBookingCursor({ sort, value: last[field].toISOString(), id: String(last._id) }) : null,
    }
  },

  async findBookingById(id, actor, now = new Date()) {
    await expireHolds(now)
    await expireOverdueBookings(now)
    const booking = await Booking.findById(id)
      .populate({ path: 'driverId', select: 'name email phone role branch active' })
      .lean()
    if (!booking) return null
    if (actor.role === 'driver' && String(booking.driverId?._id ?? booking.driverId) !== actor.id) {
      throw new AppError(403, 'FORBIDDEN', 'Drivers may only view bookings assigned to them')
    }
    return bookingView(booking)
  },

  async approveOfflinePayment(id, input, actor, now = new Date()) {
    await expireHolds(now, id)
    const existing = await Booking.findById(id).select('vehicleId').lean()
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
    const result = await withVehicleTransaction(existing.vehicleId, async (_vehicle, session) => {
      const booking = await Booking.findById(id).session(session)
      if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
      if (booking.status === 'reserved' && booking.holdExpiresAt <= now) {
        booking.status = 'expired'
        booking.pendingApproval = false
        if (booking.licence?.storageKey) booking.licence.deleteAfter = new Date(now.getTime() + 90 * 24 * 60 * 60_000)
        booking.events.push(bookingEvent('hold.expired', 'system', 'Reservation hold expired', now))
        await booking.save({ session })
        return { holdExpired: true }
      }
      if (booking.status !== 'reserved' || !booking.pendingApproval) {
        throw new AppError(409, 'INVALID_STATUS', 'This booking is not awaiting offline approval')
      }
      if (booking.createdById.toString() === actor.id) {
        throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', 'You cannot approve your own booking')
      }
      if (input.paymentMethod !== booking.paymentMethod) {
        throw new AppError(409, 'PAYMENT_METHOD_MISMATCH', 'The approval method must match the booking')
      }
      if (input.paymentMethod === 'corporate' && actor.role === 'agent') {
        throw new AppError(403, 'FORBIDDEN', 'Agents cannot approve corporate credit')
      }
      if (input.paymentMethod === 'corporate' && !input.reason?.trim()) {
        throw new AppError(400, 'INVALID_APPROVAL', 'A reason is required for corporate credit')
      }
      booking.status = 'confirmed'
      booking.pendingApproval = false
      booking.payments.push({
        id: randomUUID(),
        method: input.paymentMethod,
        amountKes: booking.totalKes,
        status: 'paid',
        reference: input.reference.trim(),
        createdAt: now,
      })
      booking.events.push(bookingEvent(
        'offline_payment.approved',
        actor.name,
        input.reason?.trim() || `Payment reference ${input.reference.trim()}`,
        now,
      ))
      await booking.save({ session })
      return bookingView(booking)
    })
    if (result.holdExpired) throw new AppError(409, 'HOLD_EXPIRED', 'The booking hold has expired')
    return result
  },

  async cancelBooking(id, reason, actor, now = new Date()) {
    await expireHolds(now, id)
    const existing = await Booking.findById(id).select('vehicleId').lean()
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
    const result = await withVehicleTransaction(existing.vehicleId, async (_vehicle, session) => {
      const booking = await Booking.findById(id).session(session)
      if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
      if (booking.status === 'reserved' && booking.holdExpiresAt <= now) {
        booking.status = 'expired'
        booking.pendingApproval = false
        if (booking.licence?.storageKey) booking.licence.deleteAfter = new Date(now.getTime() + 90 * 24 * 60 * 60_000)
        booking.events.push(bookingEvent('hold.expired', 'system', 'Reservation hold expired', now))
        await booking.save({ session })
        return { holdExpired: true }
      }
      const capturedPayments = booking.payments.filter((payment) => ['paid', 'refund_pending', 'refunded'].includes(payment.status))
      const refundApproved = capturedPayments.length > 0
        && capturedPayments.every((payment) => ['refund_pending', 'refunded'].includes(payment.status))
      if ((booking.status === 'confirmed' || capturedPayments.length > 0) && !refundApproved) {
        throw new AppError(409, 'REFUND_APPROVAL_REQUIRED', 'A paid booking requires an owner-approved refund before cancellation')
      }
      if (!['reserved', 'confirmed'].includes(booking.status)) {
        throw new AppError(409, 'INVALID_STATUS', 'This booking cannot be cancelled from its current status')
      }
      booking.status = 'cancelled'
      booking.pendingApproval = false
      if (booking.licence?.storageKey) booking.licence.deleteAfter = new Date(now.getTime() + 90 * 24 * 60 * 60_000)
      booking.events.push(bookingEvent('booking.cancelled', actor.name, reason?.trim() || 'Staff cancellation', now))
      await booking.save({ session })
      return bookingView(booking)
    })
    if (result.holdExpired) throw new AppError(409, 'HOLD_EXPIRED', 'The booking hold has expired')
    return result
  },
}

module.exports = { fleetRepository, bookingOverlapQuery, bookingView }
