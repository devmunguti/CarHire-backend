const { createHash, randomUUID } = require('node:crypto')
const mongoose = require('mongoose')
const { Booking, GuestAccess, Payment, PaymentEvent, Refund } = require('../models')
const { AppError } = require('../lib/errors')
const { hashGuestToken } = require('./guest-booking-service')

function hashPayload(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function maskedPhone(phone) {
  return `${phone.slice(0, 4)}XX XXX ${phone.slice(-3)}`
}

function event(type, actor, note, now) {
  return { id: randomUUID(), type, actor, note, createdAt: now }
}

function normalizePhone(phone) {
  return String(phone).replace(/^\+/, '')
}

function paymentOutput(payment, booking) {
  const paidAmountKes = (booking.payments ?? [])
    .filter((item) => item.status === 'paid')
    .reduce((sum, item) => sum + item.amountKes, 0)
  const balanceDueKes = Math.max(0, booking.totalKes - paidAmountKes)
  let outcome = 'pending'
  let message
  if (payment.status === 'failed') {
    outcome = 'failed'
    message = 'The payment was not completed.'
  } else if (payment.status === 'refund_pending') {
    outcome = 'manual_refund'
    message = 'Payment received after the hold expired or with an amount requiring refund review.'
  } else if (payment.status === 'paid') {
    outcome = booking.status === 'confirmed' ? 'confirmed' : 'partial'
    if (outcome === 'partial') message = 'A partial payment was received. Pay the remaining balance before the hold expires.'
  }
  return { outcome, amountDueKes: booking.totalKes, paidAmountKes, balanceDueKes, message }
}

function createPaymentService({ provider }) {
  async function getOwnedBooking(payment, access, now) {
    if (access.actor) {
      if (!['owner', 'manager', 'agent'].includes(access.actor.role)) {
        throw new AppError(403, 'FORBIDDEN', 'Payment access is restricted to booking staff')
      }
      const booking = await Booking.findById(payment.bookingId)
      if (!booking || booking.reference !== access.reference) throw new AppError(404, 'NOT_FOUND', 'Payment attempt was not found')
      return booking
    }
    if (!access.sessionToken) throw new AppError(401, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
    const booking = await Booking.findById(payment.bookingId)
    const guest = booking && booking.reference === access.reference && await GuestAccess.exists({
      bookingId: booking._id,
      reference: access.reference,
      sessionTokenHash: hashGuestToken(access.sessionToken),
      expiresAt: { $gt: now },
      revokedAt: null,
    })
    if (!guest) throw new AppError(404, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
    return booking
  }

  async function updateEmbeddedPayment(booking, payment, now) {
    const embedded = booking.payments.find((item) => item.id === payment.paymentId)
    if (!embedded) {
      booking.payments.push({
        id: payment.paymentId,
        method: 'mpesa_online',
        amountKes: payment.amountKes,
        status: payment.status,
        reference: payment.receipt || payment.providerReference || payment.paymentId,
        createdAt: payment.createdAt || now,
      })
      return
    }
    embedded.amountKes = payment.amountKes
    embedded.status = payment.status
    embedded.reference = payment.receipt || payment.providerReference || payment.paymentId
  }

  async function settle({ paymentId, providerStatus, amountKes, eventId, payloadHash, receipt, now = new Date() }) {
    if (!['SUCCESS', 'FAILED'].includes(providerStatus)) return { duplicate: false }
    const session = await mongoose.startSession()
    let result
    try {
      await session.withTransaction(async () => {
        const existingEvent = await PaymentEvent.findOne({ providerEventId: eventId }).session(session)
        if (existingEvent) {
          if (existingEvent.payloadHash !== payloadHash) {
            throw new AppError(409, 'INVALID_PROVIDER_EVENT', 'A provider event identifier was reused with different contents')
          }
          result = { duplicate: true }
          return
        }

        const payment = await Payment.findOne({ paymentId }).session(session)
        if (!payment) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment attempt was not found')
        const booking = await Booking.findById(payment.bookingId).session(session)
        if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
        await PaymentEvent.create([{
          providerEventId: eventId,
          paymentId,
          payloadHash,
          processedAt: now,
        }], { session })

        if (payment.status !== 'pending') {
          result = { duplicate: true, payment, booking }
          return
        }

        if (providerStatus === 'FAILED') {
          payment.status = 'failed'
          payment.settledAt = now
          await updateEmbeddedPayment(booking, payment, now)
          booking.events.push(event('payment.failed', 'PayHero', 'PayHero reported an unsuccessful payment', now))
          await payment.save({ session })
          await booking.save({ session })
          result = { duplicate: false, payment, booking }
          return
        }

        const actualAmount = amountKes ?? payment.requestedAmountKes
        if (!Number.isSafeInteger(actualAmount) || actualAmount < 1) {
          throw new AppError(400, 'INVALID_PROVIDER_EVENT', 'PayHero returned an invalid payment amount')
        }
        const capturedBefore = booking.payments
          .filter((item) => item.status === 'paid')
          .reduce((sum, item) => sum + item.amountKes, 0)
        const holdExpired = booking.status === 'reserved' && booking.holdExpiresAt <= now
        if (holdExpired) {
          booking.status = 'expired'
          booking.pendingApproval = false
          booking.events.push(event('hold.expired', 'system', 'Reservation hold expired', now))
        }

        payment.amountKes = actualAmount
        payment.receipt = receipt
        payment.settledAt = now
        const exceedsRequest = actualAmount > payment.requestedAmountKes
        const exceedsDue = actualAmount + capturedBefore > booking.totalKes
        if (holdExpired || !['reserved', 'confirmed'].includes(booking.status) || exceedsRequest || exceedsDue) {
          payment.status = 'refund_pending'
          await Refund.create([{
            refundId: randomUUID(),
            bookingId: booking._id,
            paymentId: payment.paymentId,
            amountKes: actualAmount,
            status: 'pending',
            reason: holdExpired || booking.status === 'expired'
              ? 'Late payment after booking hold expiry'
              : 'Payment amount requires owner refund review',
            createdById: booking.createdById,
          }], { session })
          booking.events.push(event(
            'payment.refund_pending',
            'PayHero',
            'Payment received but requires manual refund review',
            now,
          ))
        } else {
          payment.status = 'paid'
          const paidAfter = capturedBefore + actualAmount
          if (paidAfter >= booking.totalKes && booking.status === 'reserved') {
            booking.status = 'confirmed'
            booking.pendingApproval = false
            booking.events.push(event('booking.confirmed', 'PayHero', 'Full booking amount confirmed', now))
          } else {
            booking.events.push(event('payment.partial', 'PayHero', 'Partial payment received; balance remains due', now))
          }
        }
        await updateEmbeddedPayment(booking, payment, now)
        await payment.save({ session })
        await booking.save({ session })
        result = { duplicate: false, payment, booking }
      })
    } catch (error) {
      if (error.code === 11000) {
        const existing = await PaymentEvent.findOne({ providerEventId: eventId }).lean()
        if (existing?.payloadHash === payloadHash) return { duplicate: true }
        if (existing) throw new AppError(409, 'INVALID_PROVIDER_EVENT', 'A provider event identifier was reused with different contents')
      }
      throw error
    } finally {
      await session.endSession()
    }
    return result
  }

  async function reconcilePayment(payment, now = new Date()) {
    if (payment.status !== 'pending' || !payment.providerReference) return
    const status = await provider.getStatus(payment.providerReference)
    if (status.reference !== payment.providerReference) {
      throw new AppError(409, 'INVALID_PROVIDER_EVENT', 'PayHero transaction reference did not match')
    }
    if (status.checkoutRequestId && status.checkoutRequestId !== payment.checkoutRequestId) {
      throw new AppError(409, 'INVALID_PROVIDER_EVENT', 'PayHero transaction identifiers did not match')
    }
    if (!['SUCCESS', 'FAILED'].includes(status.status)) return
    if (status.status === 'SUCCESS' && status.amountKes === undefined) return
    const providerEventId = `status:${payment.paymentId}:${status.status}`
    await settle({
      paymentId: payment.paymentId,
      providerStatus: status.status,
      amountKes: status.amountKes ?? payment.requestedAmountKes,
      eventId: providerEventId,
      payloadHash: hashPayload(status),
      now,
    })
  }

  return {
    async initiate(bookingKey, phone, access, idempotencyKey, now = new Date()) {
      const booking = access.guestBooking
        ?? await Booking.findOne({ reference: bookingKey })
      if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
      if (access.actor) {
        if (!['owner', 'manager', 'agent'].includes(access.actor.role)) throw new AppError(403, 'FORBIDDEN', 'Payment initiation is restricted to booking staff')
      } else {
        const guest = await GuestAccess.exists({
          bookingId: booking._id,
          reference: booking.reference,
          sessionTokenHash: hashGuestToken(access.sessionToken || ''),
          expiresAt: { $gt: now },
          revokedAt: null,
        })
        if (!guest) throw new AppError(401, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
      }
      if (booking.paymentMethod !== 'mpesa_online') throw new AppError(409, 'PAYMENT_NOT_DUE', 'This booking is not configured for online M-Pesa payment')
      if (booking.status !== 'reserved' || booking.holdExpiresAt <= now) {
        if (booking.status === 'reserved') {
          await Booking.updateOne(
            { _id: booking._id, status: 'reserved', holdExpiresAt: { $lte: now } },
            { $set: { status: 'expired', pendingApproval: false }, $push: { events: event('hold.expired', 'system', 'Reservation hold expired', now) } },
          )
          throw new AppError(409, 'HOLD_EXPIRED', 'The booking hold has expired')
        }
        throw new AppError(409, 'PAYMENT_NOT_DUE', 'This booking cannot accept another payment')
      }

      const requestHash = hashPayload({ phone })
      if (idempotencyKey) {
        const prior = await Payment.findOne({ bookingId: booking._id, idempotencyKey })
          .select('+idempotencyRequestHash +phone')
          .lean()
        if (prior) {
          if (prior.idempotencyRequestHash !== requestHash) {
            throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different request')
          }
          if (prior.providerReference || prior.status !== 'pending') {
            return { paymentId: prior.paymentId, maskedPhone: maskedPhone(prior.phone), amountKes: prior.requestedAmountKes }
          }
          throw new AppError(409, 'PAYMENT_PENDING', 'This payment request is still being processed')
        }
      }

      const paidAmount = booking.payments.filter((item) => item.status === 'paid')
        .reduce((sum, item) => sum + item.amountKes, 0)
      const amountKes = booking.totalKes - paidAmount
      if (amountKes <= 0) throw new AppError(409, 'PAYMENT_NOT_DUE', 'No balance is due for this booking')
      const existingPending = await Payment.findOne({ bookingId: booking._id, status: 'pending' })
        .select('+phone')
        .lean()
      if (existingPending) {
        if (existingPending.providerReference) {
          if (normalizePhone(existingPending.phone) !== normalizePhone(phone)) {
            throw new AppError(409, 'PAYMENT_PENDING', 'A payment request is already in progress for another phone number')
          }
          return {
            paymentId: existingPending.paymentId,
            maskedPhone: maskedPhone(existingPending.phone),
            amountKes: existingPending.requestedAmountKes,
          }
        }
        throw new AppError(409, 'PAYMENT_PENDING', 'Another payment request is still being processed')
      }

      const paymentId = randomUUID()
      const session = await mongoose.startSession()
      try {
        await session.withTransaction(async () => {
          const current = await Booking.findById(booking._id).session(session)
          if (!current || current.status !== 'reserved' || current.holdExpiresAt <= now) {
            throw new AppError(409, 'HOLD_EXPIRED', 'The booking hold has expired')
          }
          const pending = await Payment.exists({ bookingId: current._id, status: 'pending' }).session(session)
          if (pending) throw new AppError(409, 'PAYMENT_PENDING', 'Another payment request is still being processed')
          const [created] = await Payment.create([{
            paymentId,
            bookingId: current._id,
            amountKes,
            requestedAmountKes: amountKes,
            phone,
            status: 'pending',
            externalReference: paymentId,
            ...(idempotencyKey ? { idempotencyKey, idempotencyRequestHash: requestHash } : {}),
            createdAt: now,
          }], { session })
          current.payments.push({
            id: created.paymentId,
            method: 'mpesa_online',
            amountKes,
            status: 'pending',
            reference: paymentId,
            createdAt: now,
          })
          current.events.push(event('payment.initiated', access.actor?.name || 'Guest', 'PayHero STK request created', now))
          await current.save({ session })
        })
      } finally {
        await session.endSession()
      }

      let providerResult
      try {
        providerResult = await provider.initiate({
          amountKes,
          phone,
          externalReference: paymentId,
          customerName: booking.customerName,
        })
      } catch (error) {
        await Payment.updateOne({ paymentId, status: 'pending' }, { $set: { status: 'failed', settledAt: now } })
        await Booking.updateOne(
          { _id: booking._id, 'payments.id': paymentId },
          { $set: { 'payments.$.status': 'failed' }, $push: { events: event('payment.failed', 'PayHero', 'Payment request could not be initiated', now) } },
        )
        throw error
      }
      await Payment.updateOne(
        { paymentId, status: 'pending' },
        { $set: { providerReference: providerResult.reference, checkoutRequestId: providerResult.checkoutRequestId } },
      )
      await Booking.updateOne(
        { _id: booking._id, 'payments.id': paymentId },
        { $set: { 'payments.$.reference': providerResult.reference } },
      )
      return { paymentId, maskedPhone: maskedPhone(phone), amountKes }
    },

    async getStatus(paymentId, access, now = new Date()) {
      let payment = await Payment.findOne({ paymentId }).select('+phone').lean()
      if (!payment) throw new AppError(404, 'NOT_FOUND', 'Payment attempt was not found')
      await getOwnedBooking(payment, access, now)
      await reconcilePayment(payment, now)
      payment = await Payment.findOne({ paymentId }).lean()
      const booking = await Booking.findById(payment.bookingId).lean()
      return paymentOutput(payment, booking)
    },

    async receiveCallback(callback, now = new Date()) {
      const payload = callback.response
      const payment = await Payment.findOne({ externalReference: payload.ExternalReference }).select('+phone').lean()
      if (!payment || !payment.providerReference) {
        throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment attempt was not found')
      }
      if (payload.CheckoutRequestID !== payment.checkoutRequestId) {
        throw new AppError(400, 'INVALID_PROVIDER_EVENT', 'PayHero checkout request did not match')
      }
      if (normalizePhone(payload.Phone) !== normalizePhone(payment.phone)) {
        throw new AppError(400, 'INVALID_PROVIDER_EVENT', 'PayHero payer phone did not match')
      }
      if (!Number.isSafeInteger(payload.Amount) || payload.Amount < 1 || payload.Amount > payment.requestedAmountKes) {
        throw new AppError(400, 'INVALID_PROVIDER_EVENT', 'PayHero payment amount is invalid')
      }
      const claimedStatus = payload.ResultCode === 0 && String(payload.Status).toLowerCase() === 'success'
        ? 'SUCCESS'
        : String(payload.Status).toLowerCase() === 'failed' ? 'FAILED' : null
      if (!claimedStatus || callback.status !== (claimedStatus === 'SUCCESS')) {
        throw new AppError(400, 'INVALID_PROVIDER_EVENT', 'PayHero callback outcome is invalid')
      }
      const verified = await provider.getStatus(payment.providerReference)
      if (verified.reference !== payment.providerReference
        || verified.status !== claimedStatus
        || (verified.checkoutRequestId && verified.checkoutRequestId !== payment.checkoutRequestId)
        || (verified.providerReference && payload.MpesaReceiptNumber
          && verified.providerReference !== payload.MpesaReceiptNumber)
        || (verified.amountKes !== undefined && verified.amountKes !== payload.Amount)) {
        throw new AppError(400, 'INVALID_PROVIDER_EVENT', 'PayHero transaction status did not match the callback')
      }
      const eventId = payload.MpesaReceiptNumber || `${payload.CheckoutRequestID}:${payload.ResultCode}`
      const result = await settle({
        paymentId: payment.paymentId,
        providerStatus: claimedStatus,
        amountKes: payload.Amount,
        eventId,
        payloadHash: hashPayload(callback),
        receipt: payload.MpesaReceiptNumber,
        now,
      })
      return { accepted: true, duplicate: result.duplicate === true }
    },

    async createRefund(bookingId, paymentId, reason, actor, idempotencyKey, now = new Date()) {
      const booking = await Booking.findById(bookingId)
      if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
      const payment = await Payment.findOne({ paymentId, bookingId: booking._id })
      if (!payment || payment.status !== 'paid') throw new AppError(409, 'INVALID_REFUND', 'Only a captured payment can be refunded')
      const requestHash = hashPayload({ paymentId, reason })
      if (idempotencyKey) {
        const prior = await Refund.findOne({ bookingId: booking._id, idempotencyKey })
          .select('+idempotencyRequestHash')
          .lean()
        if (prior) {
          if (prior.idempotencyRequestHash !== requestHash) {
            throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different refund request')
          }
          return prior
        }
      }
      const session = await mongoose.startSession()
      let refund
      try {
        await session.withTransaction(async () => {
          const currentPayment = await Payment.findOne({ paymentId, bookingId: booking._id }).session(session)
          const currentBooking = await Booking.findById(booking._id).session(session)
          if (!currentPayment || !currentBooking || currentPayment.status !== 'paid') {
            throw new AppError(409, 'INVALID_REFUND', 'Only a captured payment can be refunded')
          }
          const [created] = await Refund.create([{
            refundId: randomUUID(),
            bookingId: currentBooking._id,
            paymentId,
            amountKes: currentPayment.amountKes,
            status: 'pending',
            reason,
            createdById: actor.id,
            ...(idempotencyKey ? { idempotencyKey, idempotencyRequestHash: requestHash } : {}),
          }], { session })
          currentPayment.status = 'refund_pending'
          await currentPayment.save({ session })
          const embedded = currentBooking.payments.find((item) => item.id === paymentId)
          if (embedded) embedded.status = 'refund_pending'
          currentBooking.events.push(event('refund.requested', actor.name, reason, now))
          await currentBooking.save({ session })
          refund = created.toObject()
        })
      } finally {
        await session.endSession()
      }
      return refund
    },

    async recordRefundOutcome(bookingId, refundId, status, providerReference, actor, now = new Date()) {
      const session = await mongoose.startSession()
      let output
      try {
        await session.withTransaction(async () => {
          const refund = await Refund.findOne({ refundId, bookingId }).session(session)
          if (!refund) throw new AppError(404, 'NOT_FOUND', 'Refund was not found')
          const booking = await Booking.findById(bookingId).session(session)
          const payment = await Payment.findOne({ paymentId: refund.paymentId, bookingId }).session(session)
          if (!booking || !payment) throw new AppError(404, 'NOT_FOUND', 'Refund was not found')
          if (refund.status !== 'pending') {
            if (refund.status === status && refund.providerReference === providerReference) {
              output = refund.toObject()
              return
            }
            throw new AppError(409, 'INVALID_REFUND', 'This refund already has a final outcome')
          }
          refund.status = status
          refund.providerReference = providerReference
          refund.processedById = actor.id
          refund.settledAt = now
          payment.status = status === 'refunded' ? 'refunded' : 'failed'
          const embedded = booking.payments.find((item) => item.id === payment.paymentId)
          if (embedded) embedded.status = payment.status
          booking.events.push(event(`refund.${status}`, actor.name, `Manual PayHero refund marked ${status}`, now))
          await Promise.all([refund.save({ session }), payment.save({ session }), booking.save({ session })])
          output = refund.toObject()
        })
      } finally {
        await session.endSession()
      }
      return output
    },
  }
}

module.exports = { createPaymentService, paymentOutput }
