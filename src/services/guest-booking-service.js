const { createHash, randomBytes, randomUUID } = require('node:crypto')
const mongoose = require('mongoose')
const { Booking, GuestAccess, Payment, Refund, Vehicle } = require('../models')
const { AppError } = require('../lib/errors')

const exchangeTokenLifetimeMs = 15 * 60_000
const licenceRetentionMs = 90 * 24 * 60 * 60_000

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function toBookingObject(booking) {
  return typeof booking.toObject === 'function' ? booking.toObject() : { ...booking }
}

function checkoutView(booking, vehicle) {
  return {
    booking: {
      id: String(booking._id),
      reference: booking.reference,
      vehicleId: String(booking.vehicleId),
      status: booking.status,
      pendingApproval: booking.pendingApproval,
      pickupAt: booking.pickupAt,
      returnAt: booking.returnAt,
      totalKes: booking.totalKes,
      mode: booking.mode,
      paymentMethod: booking.paymentMethod,
      holdExpiresAt: booking.holdExpiresAt,
      pricingSnapshot: booking.pricingSnapshot,
    },
    vehicle: {
      id: String(vehicle._id),
      make: vehicle.make,
      model: vehicle.model,
      registration: vehicle.registration,
      ratePerDay: vehicle.ratePerDay,
    },
  }
}

function guestSummary(booking, vehicle, now = new Date()) {
  return {
    booking: {
      id: String(booking._id),
      reference: booking.reference,
      vehicleId: String(booking.vehicleId),
      customerName: booking.customerName,
      customerPhone: booking.customerPhone,
      status: booking.status,
      pendingApproval: booking.pendingApproval,
      pickupAt: booking.pickupAt,
      returnAt: booking.returnAt,
      totalKes: booking.totalKes,
      mode: booking.mode,
      paymentMethod: booking.paymentMethod,
      pricingSnapshot: booking.pricingSnapshot,
      payments: booking.payments,
    },
    vehicle: {
      id: String(vehicle._id),
      make: vehicle.make,
      model: vehicle.model,
      registration: vehicle.registration,
    },
    cancellationAllowed: ['reserved', 'confirmed'].includes(booking.status)
      && booking.pickupAt.getTime() - now.getTime() >= 48 * 60 * 60_000,
  }
}

function bookingEvent(type, actor, note, now) {
  return { id: randomUUID(), type, actor, note, createdAt: now }
}

function createGuestBookingService({ fileStore }) {
  return {
    async getCheckout(bookingId, now = new Date()) {
      const booking = await Booking.findById(bookingId).lean()
      if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
      if (booking.status === 'reserved' && booking.holdExpiresAt <= now) {
        await Booking.updateOne(
          { _id: booking._id, status: 'reserved', holdExpiresAt: { $lte: now } },
          {
            $set: { status: 'expired', pendingApproval: false, 'licence.deleteAfter': new Date(now.getTime() + licenceRetentionMs) },
            $push: { events: bookingEvent('hold.expired', 'system', 'Reservation hold expired', now) },
          },
        )
        throw new AppError(409, 'HOLD_EXPIRED', 'The booking hold has expired')
      }
      if (booking.status !== 'reserved') throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
      const vehicle = await Vehicle.findById(booking.vehicleId).lean()
      if (!vehicle) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
      return checkoutView(booking, vehicle)
    },

    async submitCheckout(bookingId, input, file, now = new Date()) {
      const original = await Booking.findById(bookingId).select('+licence.storageKey').lean()
      if (!original) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
      if (original.status !== 'reserved') throw new AppError(409, 'INVALID_STATUS', 'This booking is not accepting checkout details')
      if (original.holdExpiresAt <= now) {
        await Booking.updateOne(
          { _id: original._id, status: 'reserved', holdExpiresAt: { $lte: now } },
          {
            $set: { status: 'expired', pendingApproval: false, 'licence.deleteAfter': new Date(now.getTime() + licenceRetentionMs) },
            $push: { events: bookingEvent('hold.expired', 'system', 'Reservation hold expired', now) },
          },
        )
        throw new AppError(409, 'HOLD_EXPIRED', 'The booking hold has expired')
      }
      if (original.mode === 'self_drive' && !file) {
        throw new AppError(400, 'INVALID_LICENCE', 'A driving licence is required for self-drive bookings')
      }
      if (original.mode === 'chauffeur' && file) {
        throw new AppError(400, 'INVALID_LICENCE', 'A driving licence upload is not accepted for chauffeur bookings')
      }

      let licence
      if (file) {
        licence = await fileStore.saveLicence(file)
        if (!licence || file.mimetype !== licence.mimeType) {
          if (licence) await fileStore.remove(licence.storageKey)
          throw new AppError(400, 'INVALID_LICENCE', 'The uploaded file content does not match an allowed licence type')
        }
        licence.uploadedAt = now
        licence.deleteAfter = new Date(original.returnAt.getTime() + licenceRetentionMs)
      }

      const accessToken = randomBytes(32).toString('base64url')
      const expiresAt = new Date(original.returnAt.getTime() + 30 * 24 * 60 * 60_000)
      const session = await mongoose.startSession()
      let updated
      try {
        await session.withTransaction(async () => {
          updated = await Booking.findOneAndUpdate(
            { _id: bookingId, status: 'reserved', holdExpiresAt: { $gt: now } },
            {
              $set: {
                customerName: input.name,
                customerPhone: input.phone,
                customerEmail: input.email,
                customerIdNumber: input.idNumber,
                paymentMethod: input.paymentMethod,
                pendingApproval: input.paymentMethod === 'cash',
                ...(licence ? { licence } : {}),
              },
              $push: { events: bookingEvent('guest.checkout_completed', input.name, 'Guest checkout details submitted', now) },
            },
            { new: true, session },
          ).lean()
          if (!updated) throw new AppError(409, 'HOLD_EXPIRED', 'The booking hold has expired')
          await GuestAccess.create([{
            bookingId: updated._id,
            reference: updated.reference,
            exchangeTokenHash: hashToken(accessToken),
            exchangeExpiresAt: new Date(now.getTime() + exchangeTokenLifetimeMs),
            expiresAt,
          }], { session })
        })
      } catch (error) {
        if (licence) await fileStore.remove(licence.storageKey)
        throw error
      } finally {
        await session.endSession()
      }

      const oldKey = original.licence?.storageKey
      if (oldKey && licence && oldKey !== licence.storageKey) await fileStore.remove(oldKey)
      const vehicle = await Vehicle.findById(updated.vehicleId).lean()
      if (!vehicle) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
      return { ...guestSummary(updated, vehicle, now), accessToken }
    },

    async exchangeAccess(reference, token, now = new Date()) {
      const tokenHash = hashToken(token)
      const access = await GuestAccess.findOne({
        reference,
        exchangeTokenHash: tokenHash,
        exchangeExpiresAt: { $gt: now },
        exchangedAt: null,
        revokedAt: null,
        expiresAt: { $gt: now },
      }).select('+exchangeTokenHash')
      if (!access) throw new AppError(401, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
      const sessionToken = randomBytes(32).toString('base64url')
      const updated = await GuestAccess.updateOne(
        { _id: access._id, exchangeTokenHash: tokenHash, exchangedAt: null, revokedAt: null },
        {
          $unset: { exchangeTokenHash: 1, exchangeExpiresAt: 1 },
          $set: { exchangedAt: now, sessionTokenHash: hashToken(sessionToken) },
        },
      )
      if (updated.modifiedCount !== 1) throw new AppError(401, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
      return { sessionToken, expiresAt: access.expiresAt }
    },

    async getGuestBooking(reference, sessionToken, now = new Date()) {
      const access = await GuestAccess.findOne({
        reference,
        sessionTokenHash: hashToken(sessionToken),
        expiresAt: { $gt: now },
        revokedAt: null,
      }).lean()
      if (!access) throw new AppError(404, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
      const booking = await Booking.findOne({ _id: access.bookingId, reference }).lean()
      if (!booking) throw new AppError(404, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
      const vehicle = await Vehicle.findById(booking.vehicleId).lean()
      if (!vehicle) throw new AppError(404, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
      return guestSummary(booking, vehicle, now)
    },

    async getAuthorizedGuestBooking(reference, sessionToken, now = new Date()) {
      const access = await GuestAccess.findOne({
        reference,
        sessionTokenHash: hashToken(sessionToken),
        expiresAt: { $gt: now },
        revokedAt: null,
      }).lean()
      if (!access) throw new AppError(401, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
      const booking = await Booking.findOne({ _id: access.bookingId, reference }).lean()
      if (!booking) throw new AppError(401, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
      return booking
    },

    async cancelGuestBooking(reference, sessionToken, now = new Date()) {
      const session = await mongoose.startSession()
      let refundPending = false
      let holdExpired = false
      try {
        await session.withTransaction(async () => {
          const access = await GuestAccess.findOne({
            reference,
            sessionTokenHash: hashToken(sessionToken),
            expiresAt: { $gt: now },
            revokedAt: null,
          }).session(session)
          if (!access) throw new AppError(401, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
          const booking = await Booking.findOne({ _id: access.bookingId, reference }).session(session)
          if (!booking) throw new AppError(404, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
          if (booking.status === 'reserved' && booking.holdExpiresAt <= now) {
            booking.status = 'expired'
            booking.pendingApproval = false
            if (booking.licence?.storageKey) booking.licence.deleteAfter = new Date(now.getTime() + licenceRetentionMs)
            booking.events.push(bookingEvent('hold.expired', 'system', 'Reservation hold expired', now))
            await booking.save({ session })
            holdExpired = true
            return
          }
          if (!['reserved', 'confirmed'].includes(booking.status)
            || booking.pickupAt.getTime() - now.getTime() < 48 * 60 * 60_000) {
            throw new AppError(409, 'CANCELLATION_UNAVAILABLE', 'This booking can no longer be cancelled online')
          }
          const paid = booking.payments.filter((payment) => payment.status === 'paid')
          for (const payment of paid) {
            await Refund.create([{
              refundId: randomUUID(),
              bookingId: booking._id,
              paymentId: payment.id,
              amountKes: payment.amountKes,
              status: 'pending',
              reason: 'Eligible guest cancellation',
              createdById: booking.createdById,
            }], { session })
            payment.status = 'refund_pending'
            await Payment.updateOne({ paymentId: payment.id, status: 'paid' }, { $set: { status: 'refund_pending' } }, { session })
          }
          refundPending = paid.length > 0
          booking.status = 'cancelled'
          booking.pendingApproval = false
          if (booking.licence) booking.licence.deleteAfter = new Date(now.getTime() + licenceRetentionMs)
          booking.events.push(bookingEvent(
            'booking.cancelled',
            'Guest',
            refundPending ? 'Guest cancelled; captured payments await manual refund processing' : 'Guest cancelled booking',
            now,
          ))
          await booking.save({ session })
          await GuestAccess.updateMany({ bookingId: booking._id, revokedAt: null }, { $set: { revokedAt: now } }, { session })
        })
      } finally {
        await session.endSession()
      }
      if (holdExpired) throw new AppError(409, 'HOLD_EXPIRED', 'The booking hold has expired')
      return { cancelled: true, refundPending }
    },

    async getLicence(bookingId, now = new Date()) {
      const booking = await Booking.findById(bookingId)
        .select('+licence.storageKey +licence.mimeType +licence.deleteAfter')
        .lean()
      if (!booking?.licence?.storageKey) return null
      if (booking.licence.deleteAfter && booking.licence.deleteAfter <= now) {
        await fileStore.remove(booking.licence.storageKey)
        await Booking.updateOne({ _id: booking._id, 'licence.storageKey': booking.licence.storageKey }, { $unset: { licence: 1 } })
        return null
      }
      return {
        buffer: await fileStore.read(booking.licence.storageKey),
        mimeType: booking.licence.mimeType,
      }
    },
  }
}

module.exports = { createGuestBookingService, hashGuestToken: hashToken, licenceRetentionMs }
