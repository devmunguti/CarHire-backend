const mongoose = require('mongoose')
const { randomUUID } = require('node:crypto')
const { Booking, BookingExtension, GuestAccess, Incident, MaintenanceWindow, Vehicle } = require('../models')
const { AppError } = require('../lib/errors')
const { withVehicleTransaction } = require('./mongo-fleet-repository')
const { hashGuestToken } = require('../services/guest-booking-service')

const activeStatuses = ['confirmed', 'checked_out', 'overdue']

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeCursor(cursor) {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!mongoose.Types.ObjectId.isValid(value.id) || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Invalid cursor')
    return value
  } catch {
    throw new AppError(400, 'INVALID_QUERY', 'Extension request cursor is invalid')
  }
}

function extensionView(extension, booking) {
  const value = typeof extension.toObject === 'function' ? extension.toObject() : extension
  return {
    id: String(value._id),
    reference: value.reference,
    requestedReturnAt: value.requestedReturnAt,
    currentReturnAt: value.currentReturnAt,
    reason: value.reason,
    status: value.status,
    feeKes: value.feeKes,
    paymentReference: value.paymentReference,
    paymentMethod: value.paymentMethod,
    reviewNote: value.reviewNote,
    createdAt: value.createdAt,
    reviewedAt: value.reviewedAt,
    booking: booking ? {
      id: String(booking._id),
      reference: booking.reference,
      customerName: booking.customerName,
      vehicle: booking.vehicleName
        ?? `${booking.vehicleId?.make ?? ''} ${booking.vehicleId?.model ?? ''}`.trim(),
      currentReturnAt: booking.returnAt,
      status: booking.status,
    } : undefined,
  }
}

function createMongoExtensionRepository() {
  return {
    async createGuestRequest(reference, sessionToken, input, quoteForExtension, now = new Date()) {
      const session = await mongoose.startSession()
      let result
      try {
        await session.withTransaction(async () => {
          const access = await GuestAccess.findOne({
            reference,
            sessionTokenHash: hashGuestToken(sessionToken || ''),
            expiresAt: { $gt: now },
            revokedAt: null,
          }).session(session)
          if (!access) throw new AppError(401, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
          const booking = await Booking.findOne({ _id: access.bookingId, reference }).session(session)
          if (!booking) throw new AppError(404, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
          if (!['checked_out', 'overdue'].includes(booking.status)) {
            throw new AppError(409, 'EXTENSION_UNAVAILABLE', 'Extension requests are only available during an active rental')
          }
          if (input.requestedReturnAt <= now || input.requestedReturnAt <= booking.returnAt) {
            throw new AppError(400, 'INVALID_DATE_RANGE', 'The requested return time must be in the future and later than the current return time')
          }
          const [bookingConflict, maintenanceConflict, incidentConflict] = await Promise.all([
            Booking.exists({
              _id: { $ne: booking._id },
              vehicleId: booking.vehicleId,
              pickupAt: { $lt: input.requestedReturnAt },
              returnAt: { $gt: booking.returnAt },
              $or: [
                { status: { $in: activeStatuses } },
                { status: 'reserved', holdExpiresAt: { $gt: now } },
              ],
            }).session(session),
            MaintenanceWindow.exists({
              vehicleId: booking.vehicleId,
              startAt: { $lt: input.requestedReturnAt },
              endAt: { $gt: booking.returnAt },
            }).session(session),
            Incident.exists({
              'dispatch.vehicleId': booking.vehicleId,
              status: { $in: ['awaiting_replacement', 'dispatched'] },
            }).session(session),
          ])
          if (bookingConflict || maintenanceConflict || incidentConflict) {
            throw new AppError(409, 'EXTENSION_UNAVAILABLE', 'The vehicle is not available for the requested extension')
          }
          const vehicle = await Vehicle.findById(booking.vehicleId).session(session).lean()
          if (!vehicle) throw new AppError(404, 'NOT_FOUND', 'Vehicle was not found')
          const quote = quoteForExtension(booking, vehicle, input)
          const feeKes = quote.pricingSnapshot.totalDueKes - booking.totalKes
          if (!Number.isSafeInteger(feeKes) || feeKes <= 0) {
            throw new AppError(409, 'INVALID_EXTENSION_PRICE', 'The extension price could not be calculated')
          }
          const [extension] = await BookingExtension.create([{
            bookingId: booking._id,
            reference,
            currentReturnAt: booking.returnAt,
            requestedReturnAt: input.requestedReturnAt,
            reason: input.reason,
            feeKes,
            pricingSnapshot: quote.pricingSnapshot,
            status: 'pending',
          }], { session })
          result = extensionView(extension, booking)
        })
      } catch (error) {
        if (error.code === 11000) throw new AppError(409, 'EXTENSION_PENDING', 'A request is already awaiting review for this booking')
        throw error
      } finally {
        await session.endSession()
      }
      return result
    },

    async listRequests({ status = 'pending', limit, cursor }) {
      const position = decodeCursor(cursor)
      const filter = status ? { status } : {}
      if (position) {
        filter.$or = [
          { createdAt: { $lt: new Date(position.createdAt) } },
          { createdAt: new Date(position.createdAt), _id: { $lt: new mongoose.Types.ObjectId(position.id) } },
        ]
      }
      const rows = await BookingExtension.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .lean()
      const hasMore = rows.length > limit
      const items = hasMore ? rows.slice(0, limit) : rows
      const bookingIds = [...new Set(items.map((item) => String(item.bookingId)))]
      const bookings = await Booking.find({ _id: { $in: bookingIds } })
        .populate({ path: 'vehicleId', select: 'make model' })
        .lean()
      const bookingById = new Map(bookings.map((booking) => [String(booking._id), booking]))
      const last = items[items.length - 1]
      return {
        items: items.map((item) => extensionView(item, bookingById.get(String(item.bookingId)))),
        nextCursor: hasMore ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: String(last._id) }) : null,
      }
    },

    async reviewRequest(id, input, actor, now = new Date()) {
      const request = await BookingExtension.findById(id).select('bookingId').lean()
      if (!request) throw new AppError(404, 'NOT_FOUND', 'Extension request was not found')
      const initialBooking = await Booking.findById(request.bookingId).select('vehicleId').lean()
      if (!initialBooking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
      return withVehicleTransaction(initialBooking.vehicleId, async (vehicle, session) => {
        const extension = await BookingExtension.findById(id).session(session)
        if (!extension) throw new AppError(404, 'NOT_FOUND', 'Extension request was not found')
        if (extension.status !== 'pending') throw new AppError(409, 'EXTENSION_REVIEWED', 'This extension request has already been reviewed')
        const booking = await Booking.findById(extension.bookingId).session(session)
        if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
        if (!['checked_out', 'overdue'].includes(booking.status)
          || extension.currentReturnAt.getTime() !== booking.returnAt.getTime()
          || extension.requestedReturnAt <= booking.returnAt) {
          throw new AppError(409, 'EXTENSION_UNAVAILABLE', 'This rental can no longer be extended')
        }

        if (input.decision === 'decline') {
          extension.status = 'declined'
          extension.reviewNote = input.reviewNote
          extension.reviewedById = actor.id
          extension.reviewedAt = now
          await extension.save({ session })
          return extensionView(extension, booking)
        }

        const [bookingConflict, maintenanceConflict, incidentConflict] = await Promise.all([
          Booking.exists({
            _id: { $ne: booking._id },
            vehicleId: vehicle._id,
            pickupAt: { $lt: extension.requestedReturnAt },
            returnAt: { $gt: booking.returnAt },
            $or: [
              { status: { $in: activeStatuses } },
              { status: 'reserved', holdExpiresAt: { $gt: now } },
            ],
          }).session(session),
          MaintenanceWindow.exists({
            vehicleId: vehicle._id,
            startAt: { $lt: extension.requestedReturnAt },
            endAt: { $gt: booking.returnAt },
          }).session(session),
          Incident.exists({
            'dispatch.vehicleId': vehicle._id,
            status: { $in: ['awaiting_replacement', 'dispatched'] },
          }).session(session),
        ])
        if (bookingConflict || maintenanceConflict || incidentConflict) {
          throw new AppError(409, 'EXTENSION_UNAVAILABLE', 'The vehicle is no longer available for the requested extension')
        }

        const feeKes = extension.feeKes
        if (!Number.isSafeInteger(feeKes) || feeKes < 0 || !extension.pricingSnapshot) {
          throw new AppError(409, 'INVALID_EXTENSION_PRICE', 'The extension price could not be calculated')
        }
        if (feeKes > 0 && (!input.paymentMethod || !input.paymentReference)) {
          throw new AppError(400, 'INVALID_EXTENSION_PAYMENT', 'Offline payment details are required for this extension')
        }
        booking.returnAt = extension.requestedReturnAt
        booking.totalKes = extension.pricingSnapshot.totalDueKes
        booking.pricingSnapshot = extension.pricingSnapshot
        if (feeKes > 0) {
          booking.payments.push({
            id: randomUUID(),
            method: input.paymentMethod,
            amountKes: feeKes,
            status: 'paid',
            reference: input.paymentReference,
            createdAt: now,
          })
        }
        booking.events.push({
          id: randomUUID(),
          type: 'booking.extended',
          actor: actor.name,
          note: input.paymentReference
            ? `Rental extended; offline payment reference ${input.paymentReference}`
            : 'Rental extended without an additional charge',
          createdAt: now,
        })
        extension.status = 'approved'
        extension.feeKes = feeKes
        extension.paymentReference = input.paymentReference
        extension.paymentMethod = input.paymentMethod
        extension.reviewNote = input.reviewNote
        extension.reviewedById = actor.id
        extension.reviewedAt = now
        await booking.save({ session })
        await extension.save({ session })
        return extensionView(extension, booking)
      })
    },
  }
}

module.exports = { createMongoExtensionRepository }
