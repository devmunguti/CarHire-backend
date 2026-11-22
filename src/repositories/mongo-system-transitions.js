const { randomUUID } = require('node:crypto')
const mongoose = require('mongoose')
const { AuditEntry, Booking } = require('../models')

function bookingEvent(type, note, createdAt) {
  return { id: randomUUID(), type, actor: 'system', note, createdAt }
}

async function updateBookingWithAudit({ id, filter, update, audit }) {
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const result = await Booking.updateOne({ _id: id, ...filter }, update, { session })
      if (result.modifiedCount !== 1) return
      await AuditEntry.create([audit], { session })
    })
  } finally {
    await session.endSession()
  }
}

async function expireHolds(now = new Date(), exceptId) {
  const filter = { status: 'reserved', holdExpiresAt: { $lte: now } }
  if (exceptId) filter._id = { $ne: exceptId }
  const expired = await Booking.find(filter).select('_id pendingApproval').lean()

  for (const booking of expired) {
    const id = String(booking._id)
    await updateBookingWithAudit({
      id: booking._id,
      filter: { status: 'reserved', holdExpiresAt: { $lte: now } },
      update: {
        $set: {
          status: 'expired',
          pendingApproval: false,
          'licence.deleteAfter': new Date(now.getTime() + 90 * 24 * 60 * 60_000),
        },
        $push: { events: bookingEvent('hold.expired', 'Reservation hold expired', now) },
      },
      audit: {
        actor: 'System',
        action: 'booking.hold.expired',
        entity: `booking:${id}`,
        before: { status: 'reserved', pendingApproval: booking.pendingApproval },
        after: { status: 'expired', pendingApproval: false },
        createdAt: now,
      },
    })
  }
}

async function expireOverdueBookings(now = new Date()) {
  const cutoff = new Date(now.getTime() - 2 * 60 * 60_000)
  const overdue = await Booking.find({ status: 'checked_out', returnAt: { $lt: cutoff } })
    .select('_id returnAt accruedLateFeeKes')
    .lean()

  for (const booking of overdue) {
    const lateHours = Math.max(0, Math.ceil((now.getTime() - booking.returnAt.getTime() - 2 * 60 * 60_000) / (60 * 60_000)))
    const accruedLateFeeKes = lateHours * 1500
    const id = String(booking._id)
    await updateBookingWithAudit({
      id: booking._id,
      filter: { status: 'checked_out', returnAt: { $lt: cutoff } },
      update: {
        $set: { status: 'overdue', accruedLateFeeKes },
        $push: { events: bookingEvent('booking.overdue', 'Booking passed its return grace period', now) },
      },
      audit: {
        actor: 'System',
        action: 'booking.overdue',
        entity: `booking:${id}`,
        before: { status: 'checked_out', accruedLateFeeKes: booking.accruedLateFeeKes ?? 0 },
        after: { status: 'overdue', accruedLateFeeKes },
        createdAt: now,
      },
    })
  }
}

module.exports = { expireHolds, expireOverdueBookings }
