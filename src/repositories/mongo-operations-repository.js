const { randomBytes, randomUUID } = require('node:crypto')
const mongoose = require('mongoose')
const { Booking, Incident, MaintenanceWindow, Mechanic, User, Vehicle } = require('../models')
const { AppError } = require('../lib/errors')
const { expireOverdueBookings } = require('./mongo-system-transitions')

const activeTripStatuses = ['confirmed', 'checked_out', 'overdue']
const incidentCategories = ['flat_tyre', 'battery', 'overheating', 'accident', 'strange_noise']

function idOf(value) {
  return String(value?._id ?? value)
}

function cursorEncode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function cursorDecode(cursor) {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!value || typeof value.name !== 'string' || typeof value.id !== 'string'
      || !mongoose.Types.ObjectId.isValid(value.id)) throw new Error('Invalid cursor')
    return value
  } catch {
    throw new AppError(400, 'INVALID_QUERY', 'Pagination cursor is invalid')
  }
}

function timeCursorDecode(cursor) {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!value || typeof value.pickupAt !== 'string' || !Number.isFinite(Date.parse(value.pickupAt))
      || !mongoose.Types.ObjectId.isValid(value.id)) throw new Error('Invalid cursor')
    return value
  } catch {
    throw new AppError(400, 'INVALID_QUERY', 'Pagination cursor is invalid')
  }
}

function driverView(user, currentTrip) {
  const profile = user.driverProfile
  if (!profile) return null
  return {
    id: idOf(user),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: 'driver',
    branch: user.branch,
    active: user.active,
    status: currentTrip ? 'assigned' : (!user.active ? 'off_duty' : (profile.status ?? 'available')),
    languages: profile.languages ?? [],
    licenceClass: profile.licenceClass,
    licenceExpiresAt: new Date(profile.licenceExpiresAt).toISOString(),
    psvExpiresAt: new Date(profile.psvExpiresAt).toISOString(),
    rating: profile.rating ?? 0,
    ...(currentTrip ? {
      currentTrip: {
        bookingId: idOf(currentTrip),
        reference: currentTrip.reference,
        pickupAt: new Date(currentTrip.pickupAt).toISOString(),
      },
    } : {}),
  }
}

function bookingView(booking, driver) {
  const value = typeof booking.toObject === 'function' ? booking.toObject() : booking
  const { _id, __v, driverId, idempotencyKey, idempotencyRequestHash, pendingInspectionPhotos, ...fields } = value
  delete fields.licence
  for (const inspection of fields.inspections ?? []) {
    inspection.photos = (inspection.photos ?? []).map((photo) => photo.url)
  }
  const populatedDriver = driver ?? (driverId && typeof driverId === 'object' && driverId.name
    ? driverView(driverId, null)
    : undefined)
  return {
    id: idOf(_id),
    ...fields,
    vehicleId: idOf(fields.vehicleId),
    createdById: idOf(fields.createdById),
    ...(driverId ? { driverId: idOf(driverId) } : {}),
    ...(populatedDriver ? { driver: populatedDriver } : {}),
  }
}

function mechanicView(mechanic) {
  const value = typeof mechanic.toObject === 'function' ? mechanic.toObject() : mechanic
  const { _id, __v, active, ...fields } = value
  return { id: idOf(_id), ...fields }
}

function incidentView(incident) {
  const value = typeof incident.toObject === 'function' ? incident.toObject() : incident
  const { _id, __v, reporterId, ...fields } = value
  const dispatch = fields.dispatch ? {
    ...fields.dispatch,
    ...(fields.dispatch.mechanicId ? { mechanicId: idOf(fields.dispatch.mechanicId) } : {}),
    ...(fields.dispatch.vehicleId ? { vehicleId: idOf(fields.dispatch.vehicleId) } : {}),
  } : undefined
  return {
    id: idOf(_id),
    ...fields,
    ...(fields.vehicleId ? { vehicleId: idOf(fields.vehicleId) } : {}),
    ...(dispatch ? { dispatch } : {}),
    photos: (fields.photos ?? []).map((photo) => photo.url),
  }
}

function bookingEvent(type, actor, note, createdAt = new Date()) {
  return { id: randomUUID(), type, actor, note, createdAt }
}

function incidentEvent(type, actor, note, createdAt = new Date()) {
  return { id: randomUUID(), type, actor, note, createdAt }
}

function overlaps(from, to) {
  return { pickupAt: { $lt: to }, returnAt: { $gt: from } }
}

function blockingBookingQuery(from, to, exceptBookingId) {
  const query = {
    driverId: { $exists: true },
    status: { $in: activeTripStatuses },
    ...overlaps(from, to),
  }
  if (exceptBookingId) query._id = { $ne: exceptBookingId }
  return query
}

function driverEligible(user, vehicle, from, to, now) {
  const profile = user?.driverProfile
  return Boolean(user?.role === 'driver' && user.active && profile
    && profile.status !== 'off_duty'
    && profile.licenceClass
    && new Date(profile.licenceExpiresAt) >= to
    && new Date(profile.psvExpiresAt) >= to
    && (!vehicle || vehicle.seats <= 8 || profile.licenceClass === 'C1')
    && now <= to)
}

function photoReference(bookingId, type, value) {
  if (typeof value !== 'string') return null
  const escapedId = bookingId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^/(?:api/v1/)?bookings/${escapedId}/inspections/photos/([a-f\\d-]{36})$`, 'i').exec(value)
  return match ? { id: match[1], type } : null
}

function selectedPhotos(booking, bookingId, type, urls) {
  if (!Array.isArray(urls) || urls.length > 10 || new Set(urls).size !== urls.length) {
    throw new AppError(400, 'INVALID_INSPECTION', 'Inspection photos are invalid')
  }
  const expected = urls.map((url) => ({ url, reference: photoReference(bookingId, type, url) }))
  if (expected.some((item) => !item.reference)) throw new AppError(400, 'INVALID_INSPECTION', 'Inspection photos must be uploaded for this booking')
  const uploaded = (booking.pendingInspectionPhotos ?? []).filter((photo) => photo.type === type)
  if (uploaded.length !== expected.length
    || expected.some(({ url, reference }) => !uploaded.some((photo) => photo.id === reference.id && photo.url === url))) {
    throw new AppError(400, 'INVALID_INSPECTION', 'Uploaded photos do not match this inspection')
  }
  return uploaded.map((photo) => ({
    id: photo.id,
    url: photo.url,
    storageKey: photo.storageKey,
    mimeType: photo.mimeType,
    sizeBytes: photo.sizeBytes,
    sha256: photo.sha256,
  }))
}

function settlementFor(booking, checkout, odometer, now) {
  const graceHours = 2
  const lateHours = Math.max(0, Math.ceil((now.getTime() - new Date(booking.returnAt).getTime() - graceHours * 60 * 60_000) / (60 * 60_000)))
  const lateFeeKes = lateHours * 1500
  const odometerDifferenceKm = odometer - checkout.odometer
  const includedMileageKm = (booking.pricingSnapshot?.baseDays ?? 1) * 100
  const excessMileageKm = Math.max(0, odometerDifferenceKm - includedMileageKm)
  const excessMileageRateKes = 50
  const excessMileageChargeKes = excessMileageKm * excessMileageRateKes
  return {
    graceHours,
    lateHours,
    lateFeeKes,
    odometerDifferenceKm,
    includedMileageKm,
    excessMileageKm,
    excessMileageRateKes,
    excessMileageChargeKes,
    totalKes: lateFeeKes + excessMileageChargeKes,
  }
}

function driverAssignmentRepository() {
  return {
    async listDrivers({ limit, cursor }) {
      const position = cursorDecode(cursor)
      const filter = {
        role: 'driver',
        'driverProfile.licenceClass': { $exists: true, $ne: '' },
        'driverProfile.licenceExpiresAt': { $type: 'date' },
        'driverProfile.psvExpiresAt': { $type: 'date' },
      }
      if (position) {
        filter.$or = [
          { name: { $gt: position.name } },
          { name: position.name, _id: { $gt: new mongoose.Types.ObjectId(position.id) } },
        ]
      }
      const rows = await User.find(filter).sort({ name: 1, _id: 1 }).limit(limit + 1).lean()
      const more = rows.length > limit
      const page = more ? rows.slice(0, limit) : rows
      const ids = page.map((driver) => driver._id)
      const trips = await Booking.find({ driverId: { $in: ids }, status: { $in: activeTripStatuses } })
        .sort({ pickupAt: 1 }).lean()
      const tripByDriver = new Map()
      for (const trip of trips) if (!tripByDriver.has(String(trip.driverId))) tripByDriver.set(String(trip.driverId), trip)
      const items = page.map((driver) => driverView(driver, tripByDriver.get(String(driver._id))))
      const last = page[page.length - 1]
      return {
        items,
        nextCursor: more ? cursorEncode({ name: last.name, id: String(last._id) }) : null,
      }
    },

    async listAvailableDrivers({ from, to, vehicleId, now = new Date() }) {
      const [vehicle, users] = await Promise.all([
        Vehicle.findById(vehicleId).lean(),
        User.find({ role: 'driver', active: true, 'driverProfile.status': { $ne: 'off_duty' } }).lean(),
      ])
      if (!vehicle) throw new AppError(404, 'NOT_FOUND', 'Vehicle was not found')
      if (vehicle.status !== 'available') return { drivers: [], autoAssignDriverId: null }
      const candidates = users.filter((driver) => driverEligible(driver, vehicle, from, to, now))
      const assigned = await Booking.find({
        driverId: { $in: candidates.map((driver) => driver._id) },
        status: { $in: activeTripStatuses },
        ...overlaps(from, to),
      }).select('driverId').lean()
      const unavailable = new Set(assigned.map((booking) => String(booking.driverId)))
      const available = candidates.filter((driver) => !unavailable.has(String(driver._id)))
        .sort((left, right) => {
          const a = left.driverProfile.lastAssignedAt?.getTime?.() ?? 0
          const b = right.driverProfile.lastAssignedAt?.getTime?.() ?? 0
          return a - b || left.name.localeCompare(right.name) || idOf(left).localeCompare(idOf(right))
        })
      return {
        drivers: available.map((driver) => driverView(driver, null)),
        autoAssignDriverId: available.length ? idOf(available[0]) : null,
      }
    },

    async listMyDriverTrips(driverId, { limit, cursor }) {
      const position = timeCursorDecode(cursor)
      const filter = {
        driverId,
        status: { $in: [...activeTripStatuses, 'completed'] },
      }
      if (position) {
        filter.$or = [
          { pickupAt: { $gt: new Date(position.pickupAt) } },
          { pickupAt: new Date(position.pickupAt), _id: { $gt: new mongoose.Types.ObjectId(position.id) } },
        ]
      }
      const rows = await Booking.find(filter)
        .populate({ path: 'driverId', select: 'name email phone role branch active driverProfile' })
        .populate({ path: 'vehicleId', select: 'registration' })
        .sort({ pickupAt: 1, _id: 1 })
        .limit(limit + 1)
        .lean()
      const more = rows.length > limit
      const page = more ? rows.slice(0, limit) : rows
      const items = page.map((booking) => ({
        ...bookingView(booking),
        vehicleRegistration: booking.vehicleId?.registration,
      }))
      const last = page[page.length - 1]
      return {
        items,
        nextCursor: more ? cursorEncode({ pickupAt: last.pickupAt.toISOString(), id: String(last._id) }) : null,
      }
    },

    async assignDriver(bookingId, driverId, actor, now = new Date()) {
      const session = await mongoose.startSession()
      let result
      try {
        await session.withTransaction(async () => {
          const lockedDriver = await User.updateOne(
            { _id: driverId, role: 'driver' },
            { $inc: { 'driverProfile.assignmentRevision': 1 } },
            { session },
          )
          if (lockedDriver.matchedCount !== 1) throw new AppError(409, 'DRIVER_UNAVAILABLE', 'This driver is not available')
          const [booking, driver] = await Promise.all([
            Booking.findById(bookingId).session(session),
            User.findById(driverId).session(session).lean(),
          ])
          if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
          if (booking.status !== 'confirmed' || booking.mode !== 'chauffeur') {
            throw new AppError(409, 'INVALID_STATUS', 'A driver can only be assigned to a confirmed chauffeur booking')
          }
          if (booking.driverId && String(booking.driverId) !== String(driverId)) {
            throw new AppError(409, 'INVALID_STATUS', 'This booking already has an assigned driver')
          }
          const vehicle = await Vehicle.findById(booking.vehicleId).session(session).lean()
          if (!vehicle || !driverEligible(driver, vehicle, booking.pickupAt, booking.returnAt, now)) {
            throw new AppError(409, 'DRIVER_UNAVAILABLE', 'This driver is not eligible for the selected trip')
          }
          const conflict = await Booking.exists({
            driverId,
            status: { $in: activeTripStatuses },
            ...overlaps(booking.pickupAt, booking.returnAt),
            _id: { $ne: booking._id },
          }).session(session)
          if (conflict) throw new AppError(409, 'DRIVER_UNAVAILABLE', 'This driver is already assigned during the selected trip')
          if (!booking.driverId) {
            booking.driverId = driverId
            booking.driverTripStatus = undefined
            booking.events.push(bookingEvent('driver.assigned', actor.name, `Driver assigned: ${driver.name}`, now))
            await booking.save({ session })
          }
          await User.updateOne({ _id: driverId }, { $set: { 'driverProfile.lastAssignedAt': now } }, { session })
          result = bookingView(booking, driver)
        })
      } finally {
        await session.endSession()
      }
      return result
    },

    async updateDriverTripStatus(bookingId, status, actor, now = new Date()) {
      const expectedPrevious = {
        en_route_to_pickup: undefined,
        customer_onboard: 'en_route_to_pickup',
        trip_completed: 'customer_onboard',
      }
      const session = await mongoose.startSession()
      let result
      try {
        await session.withTransaction(async () => {
          const booking = await Booking.findOne({ _id: bookingId, driverId: actor.id }).session(session)
          if (!booking) {
            const exists = await Booking.exists({ _id: bookingId }).session(session)
            if (!exists) throw new AppError(404, 'NOT_FOUND', 'Trip was not found')
            throw new AppError(403, 'FORBIDDEN', 'Drivers may only update their assigned trips')
          }
          if (booking.status !== 'confirmed' || booking.driverTripStatus !== expectedPrevious[status]) {
            throw new AppError(409, 'INVALID_TRIP_STATUS', 'Trip status must advance in order')
          }
          booking.driverTripStatus = status
          if (status === 'trip_completed') booking.status = 'completed'
          booking.events.push(bookingEvent(`trip.${status}`, actor.name, `Driver trip status changed to ${status}`, now))
          await booking.save({ session })
          const populated = await Booking.findById(booking._id)
            .populate({ path: 'driverId', select: 'name email phone role branch active driverProfile' })
            .session(session)
            .lean()
          result = bookingView(populated)
        })
      } finally {
        await session.endSession()
      }
      return result
    },
  }
}

function createMongoOperationsRepository() {
  const drivers = driverAssignmentRepository()

  return {
    ...drivers,

    async findBookingForHandover(bookingId, actor, includePhotoKeys = false) {
      let query = Booking.findById(bookingId)
      if (includePhotoKeys) query = query.select('+inspections.photos.storageKey +pendingInspectionPhotos.storageKey')
      query = query.populate({ path: 'driverId', select: 'name email phone role branch active driverProfile' })
      const booking = await query.lean()
      if (!booking) return null
      if (actor.role === 'driver' && String(booking.driverId?._id ?? booking.driverId) !== actor.id) {
        throw new AppError(403, 'FORBIDDEN', 'Drivers may only access their assigned bookings')
      }
      return booking
    },

    async uploadInspectionPhoto(bookingId, type, fileMetadata) {
      const session = await mongoose.startSession()
      let url
      try {
        await session.withTransaction(async () => {
          const booking = await Booking.findById(bookingId).select('+pendingInspectionPhotos.storageKey').session(session)
          if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
          const correctState = type === 'check_out'
            ? booking.status === 'confirmed'
            : ['checked_out', 'overdue'].includes(booking.status)
          if (!correctState) throw new AppError(409, 'INVALID_STATUS', 'This photo does not match the booking state')
          const existingCount = (booking.inspections ?? [])
            .filter((inspection) => inspection.type === type)
            .reduce((count, inspection) => count + inspection.photos.length, 0)
          const pendingCount = booking.pendingInspectionPhotos.filter((photo) => photo.type === type).length
          if (existingCount + pendingCount >= 10) throw new AppError(400, 'PHOTO_LIMIT_EXCEEDED', 'An inspection can contain no more than 10 photos')
          const id = randomUUID()
          url = `/api/v1/bookings/${bookingId}/inspections/photos/${id}`
          booking.pendingInspectionPhotos.push({ ...fileMetadata, id, type, url })
          await booking.save({ session })
        })
      } finally {
        await session.endSession()
      }
      return url
    },

    async getInspectionPhoto(bookingId, photoId, actor) {
      const booking = await Booking.findById(bookingId)
        .select('+inspections.photos.storageKey +pendingInspectionPhotos.storageKey')
        .lean()
      if (!booking) return null
      if (actor.role === 'driver' && String(booking.driverId) !== actor.id) {
        throw new AppError(403, 'FORBIDDEN', 'Drivers may only access photos from their assigned bookings')
      }
      const photos = [
        ...(booking.pendingInspectionPhotos ?? []),
        ...(booking.inspections ?? []).flatMap((inspection) => inspection.photos),
      ]
      return photos.find((photo) => photo.id === photoId) ?? null
    },

    async checkOut(bookingId, input, actor, now = new Date()) {
      const session = await mongoose.startSession()
      let result
      try {
        await session.withTransaction(async () => {
          const booking = await Booking.findById(bookingId)
            .select('+pendingInspectionPhotos.storageKey')
            .session(session)
          if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
          if (booking.status !== 'confirmed') throw new AppError(409, 'INVALID_STATUS', 'Only confirmed bookings can be checked out')
          if (input.signatureConfirmed !== true) throw new AppError(400, 'INVALID_INSPECTION', 'Inspection confirmation is required')
          const photos = selectedPhotos(booking, bookingId, 'check_out', input.photos)
          booking.status = 'checked_out'
          booking.accruedLateFeeKes = 0
          booking.inspections.push({
            id: randomUUID(),
            type: 'check_out',
            odometer: input.odometer,
            fuelLevel: input.fuelLevel,
            notes: input.notes,
            photos,
            signatureConfirmed: true,
            criticalDefect: input.criticalDefect,
            createdAt: now,
          })
          booking.pendingInspectionPhotos = booking.pendingInspectionPhotos.filter((photo) => photo.type !== 'check_out')
          booking.events.push(bookingEvent('booking.checked_out', actor.name, input.notes || 'Vehicle checked out', now))
          await booking.save({ session })
          const populated = await Booking.findById(booking._id)
            .populate({ path: 'driverId', select: 'name email phone role branch active driverProfile' })
            .session(session)
            .lean()
          result = bookingView(populated)
        })
      } finally {
        await session.endSession()
      }
      return result
    },

    async previewSettlement(bookingId, odometer, actor, now = new Date()) {
      const booking = await this.findBookingForHandover(bookingId, actor)
      if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
      const checkout = booking.inspections?.find((inspection) => inspection.type === 'check_out')
      if (!checkout) throw new AppError(409, 'CHECK_OUT_REQUIRED', 'A check-out inspection is required first')
      if (odometer < checkout.odometer) throw new AppError(400, 'ODOMETER_INVALID', 'Check-in odometer must be at least the check-out reading')
      if (!['checked_out', 'overdue'].includes(booking.status)) throw new AppError(409, 'INVALID_STATUS', 'Only active trips can be checked in')
      return settlementFor(booking, checkout, odometer, now)
    },

    async checkIn(bookingId, input, actor, now = new Date()) {
      const initial = await Booking.findById(bookingId).select('vehicleId').lean()
      if (!initial) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
      const session = await mongoose.startSession()
      let result
      try {
        await session.withTransaction(async () => {
          const vehicleWrite = await Vehicle.updateOne(
            { _id: initial.vehicleId },
            { $inc: { availabilityRevision: 1 } },
            { session },
          )
          if (vehicleWrite.matchedCount !== 1) throw new AppError(404, 'NOT_FOUND', 'Vehicle was not found')
          const booking = await Booking.findById(bookingId)
            .select('+pendingInspectionPhotos.storageKey')
            .session(session)
          if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
          if (actor.role === 'driver' && String(booking.driverId) !== actor.id) {
            throw new AppError(403, 'FORBIDDEN', 'Drivers may only check in their assigned bookings')
          }
          const checkout = booking.inspections.find((inspection) => inspection.type === 'check_out')
          if (!checkout) throw new AppError(409, 'CHECK_OUT_REQUIRED', 'A check-out inspection is required first')
          if (!['checked_out', 'overdue'].includes(booking.status)) throw new AppError(409, 'INVALID_STATUS', 'Only active trips can be checked in')
          if (input.odometer < checkout.odometer) throw new AppError(400, 'ODOMETER_INVALID', 'Check-in odometer must be at least the check-out reading')
          if (input.signatureConfirmed !== true) throw new AppError(400, 'CONFIRMATION_REQUIRED', 'Check-in confirmation is required')
          const photos = selectedPhotos(booking, bookingId, 'check_in', input.photos)
          const settlement = settlementFor(booking, checkout, input.odometer, now)
          booking.status = 'completed'
          booking.accruedLateFeeKes = settlement.lateFeeKes
          booking.inspections.push({
            id: randomUUID(),
            type: 'check_in',
            odometer: input.odometer,
            fuelLevel: input.fuelLevel,
            notes: input.notes,
            photos,
            signatureConfirmed: true,
            criticalDefect: input.criticalDefect,
            settlement,
            createdAt: now,
          })
          booking.pendingInspectionPhotos = booking.pendingInspectionPhotos.filter((photo) => photo.type !== 'check_in')
          booking.events.push(bookingEvent('booking.checked_in', actor.name, input.notes || 'Vehicle checked in', now))
          await booking.save({ session })
          await Vehicle.updateOne(
            { _id: initial.vehicleId },
            { $set: { status: input.criticalDefect ? 'maintenance' : 'available' } },
            { session },
          )
          const populated = await Booking.findById(booking._id)
            .populate({ path: 'driverId', select: 'name email phone role branch active driverProfile' })
            .session(session)
            .lean()
          result = bookingView(populated)
        })
      } finally {
        await session.endSession()
      }
      return result
    },

    async markOverdue(now = new Date()) {
      await expireOverdueBookings(now)
    },

    async listMechanics({ limit, cursor }) {
      const position = cursorDecode(cursor)
      const filter = { active: true }
      if (position) {
        filter.$or = [
          { name: { $gt: position.name } },
          { name: position.name, _id: { $gt: new mongoose.Types.ObjectId(position.id) } },
        ]
      }
      const rows = await Mechanic.find(filter).sort({ name: 1, _id: 1 }).limit(limit + 1).lean()
      const more = rows.length > limit
      const page = more ? rows.slice(0, limit) : rows
      const last = page[page.length - 1]
      return {
        items: page.map(mechanicView),
        nextCursor: more ? cursorEncode({ name: last.name, id: String(last._id) }) : null,
      }
    },

    async createMechanic(input) {
      const mechanic = await Mechanic.create(input)
      return mechanicView(mechanic)
    },

    async findNearestMechanics({ latitude, longitude, radiusKm, limit, category }) {
      const filter = {
        active: true,
        ...(category ? { specialties: category } : {}),
        location: {
          $near: {
            $geometry: { type: 'Point', coordinates: [longitude, latitude] },
            $maxDistance: radiusKm * 1000,
          },
        },
      }
      const mechanics = await Mechanic.find(filter).limit(limit).lean()
      return mechanics.map((mechanic) => {
        const [mechanicLongitude, mechanicLatitude] = mechanic.location.coordinates
        const lat1 = latitude * Math.PI / 180
        const lat2 = mechanicLatitude * Math.PI / 180
        const dLat = lat2 - lat1
        const dLng = (mechanicLongitude - longitude) * Math.PI / 180
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
        return { ...mechanicView(mechanic), distanceKm: 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) }
      })
    },

    async createIncident(input, actor, photos, now = new Date(), incidentId) {
      if (input.vehicleId) {
        const vehicle = await Vehicle.exists({ _id: input.vehicleId })
        if (!vehicle) throw new AppError(400, 'INVALID_INCIDENT', 'The selected vehicle was not found')
        if (actor?.role === 'driver') {
          const assigned = await Booking.exists({
            driverId: actor.id,
            vehicleId: input.vehicleId,
            status: { $in: activeTripStatuses },
          })
          if (!assigned) throw new AppError(403, 'FORBIDDEN', 'Drivers may only report incidents for their assigned vehicles')
        }
      }
      const incident = await Incident.create({
        ...(incidentId ? { _id: incidentId } : {}),
        reference: `SOS-${now.getTime().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`,
        status: 'open',
        ...input,
        photos,
        source: actor?.role === 'driver' ? 'driver' : actor ? 'desk' : 'customer',
        ...(actor ? { reporterId: actor.id } : {}),
        events: [incidentEvent('incident.created', actor?.name ?? 'Guest', 'Incident reported', now)],
      })
      return incidentView(incident)
    },

    async listIncidents({ limit, cursor }) {
      let position = null
      if (cursor) {
        try {
          position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
          if (!position || !Number.isFinite(Date.parse(position.createdAt)) || !mongoose.Types.ObjectId.isValid(position.id)) {
            throw new Error('Invalid cursor')
          }
        } catch {
          throw new AppError(400, 'INVALID_QUERY', 'Pagination cursor is invalid')
        }
      }
      const filter = {}
      if (position) {
        const createdAt = new Date(position.createdAt)
        filter.$or = [
          { createdAt: { $lt: createdAt } },
          { createdAt, _id: { $lt: new mongoose.Types.ObjectId(position.id) } },
        ]
      }
      const rows = await Incident.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean()
      const more = rows.length > limit
      const page = more ? rows.slice(0, limit) : rows
      const last = page[page.length - 1]
      return {
        items: page.map(incidentView),
        nextCursor: more ? cursorEncode({ createdAt: last.createdAt.toISOString(), id: String(last._id) }) : null,
      }
    },

    async getIncidentPhoto(incidentId, photoId) {
      const incident = await Incident.findById(incidentId).select('+photos.storageKey').lean()
      if (!incident) return null
      return incident.photos.find((photo) => photo.id === photoId) ?? null
    },

    async dispatchIncident(incidentId, input, actor, now = new Date()) {
      const incident = await Incident.findById(incidentId)
      if (!incident) throw new AppError(404, 'NOT_FOUND', 'Incident was not found')
      if (incident.status !== 'open') throw new AppError(409, 'INVALID_STATUS', 'Only open incidents can be dispatched')
      let mechanicId
      let vehicleId
      let nextStatus = 'dispatched'
      if (input.type === 'closest_partner') {
        const nearest = await Mechanic.findOne({
          active: true,
          type: 'partner_garage',
          specialties: incident.category,
          location: {
            $near: {
              $geometry: incident.location,
              $maxDistance: 50_000,
            },
          },
        }).lean()
        if (!nearest) throw new AppError(409, 'NO_PARTNER_WITHIN_RANGE', 'No partner mechanic is available within 50 km')
        mechanicId = nearest._id
      } else if (input.type === 'in_house_rescue') {
        const nearest = await Mechanic.findOne({
          active: true,
          type: 'in_house',
          location: { $near: { $geometry: incident.location, $maxDistance: 50_000 } },
        }).lean()
        if (nearest) mechanicId = nearest._id
      } else {
        if (!input.vehicleId) throw new AppError(400, 'VEHICLE_REQUIRED', 'Select a replacement vehicle')
        vehicleId = input.vehicleId
        nextStatus = 'awaiting_replacement'
        const session = await mongoose.startSession()
        try {
          await session.withTransaction(async () => {
            const vehicleWrite = await Vehicle.updateOne(
              { _id: vehicleId },
              { $inc: { availabilityRevision: 1 } },
              { session },
            )
            if (vehicleWrite.matchedCount !== 1) throw new AppError(409, 'DRIVER_UNAVAILABLE', 'The replacement vehicle is unavailable')
            const vehicle = await Vehicle.findById(vehicleId).session(session).lean()
            const from = now
            const to = new Date(now.getTime() + 1)
            const [booking, maintenance, alreadyDispatched] = await Promise.all([
              Booking.exists({
                vehicleId,
                ...overlaps(from, to),
                $or: [
                  { status: { $in: activeTripStatuses } },
                  { status: 'reserved', holdExpiresAt: { $gt: now } },
                ],
              }).session(session),
              MaintenanceWindow.exists({
                vehicleId,
                startAt: { $lt: to },
                endAt: { $gt: from },
              }).session(session),
              Incident.exists({
                _id: { $ne: incident._id },
                'dispatch.vehicleId': vehicleId,
                status: { $in: ['awaiting_replacement', 'dispatched'] },
              }).session(session),
            ])
            if (vehicle.status !== 'available' || booking || maintenance || alreadyDispatched) {
              throw new AppError(409, 'DRIVER_UNAVAILABLE', 'The replacement vehicle is unavailable')
            }
            const current = await Incident.findOne({ _id: incidentId, status: 'open' }).session(session)
            if (!current) throw new AppError(409, 'INVALID_STATUS', 'Incident has already been dispatched')
            current.status = nextStatus
            current.dispatch = { type: input.type, vehicleId, createdAt: now }
            current.events.push(incidentEvent('incident.dispatched', actor.name, `Dispatch type: ${input.type}`, now))
            await current.save({ session })
            incident.status = current.status
            incident.dispatch = current.dispatch
            incident.events = current.events
          })
        } finally {
          await session.endSession()
        }
        return incidentView(incident)
      }
      const updated = await Incident.findOneAndUpdate(
        { _id: incidentId, status: 'open' },
        {
          $set: {
            status: nextStatus,
            dispatch: { type: input.type, ...(mechanicId ? { mechanicId } : {}), createdAt: now },
          },
          $push: { events: incidentEvent('incident.dispatched', actor.name, `Dispatch type: ${input.type}`, now) },
        },
        { returnDocument: 'after', runValidators: true },
      )
      if (!updated) throw new AppError(409, 'INVALID_STATUS', 'Incident has already been dispatched')
      return incidentView(updated)
    },

    async resolveIncident(incidentId, resolution, actor, now = new Date()) {
      const updated = await Incident.findOneAndUpdate(
        { _id: incidentId, status: { $in: ['dispatched', 'awaiting_replacement'] } },
        {
          $set: { status: 'resolved', resolution },
          $push: { events: incidentEvent('incident.resolved', actor.name, resolution, now) },
        },
        { returnDocument: 'after', runValidators: true },
      )
      if (!updated) {
        const exists = await Incident.exists({ _id: incidentId })
        if (!exists) throw new AppError(404, 'NOT_FOUND', 'Incident was not found')
        throw new AppError(409, 'INVALID_STATUS', 'Only dispatched incidents can be resolved')
      }
      return incidentView(updated)
    },
  }
}

module.exports = {
  createMongoOperationsRepository,
  settlementFor,
}
