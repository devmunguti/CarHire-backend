const mongoose = require('mongoose')
const { Booking, Incident, Vehicle } = require('../models')
const { AppError } = require('../lib/errors')
const { bookingView } = require('./mongo-fleet-repository')

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function nairobiDayRange(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type) => parts.find((item) => item.type === type).value
  const start = Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day'))) - 3 * 60 * 60_000
  return { start: new Date(start), end: new Date(start + 24 * 60 * 60_000) }
}

function nairobiMonthRange(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now)
  const year = Number(parts.find((item) => item.type === 'year').value)
  const month = Number(parts.find((item) => item.type === 'month').value)
  const start = Date.UTC(year, month - 1, 1) - 3 * 60 * 60_000
  const end = Date.UTC(year, month, 1) - 3 * 60 * 60_000
  return { start: new Date(start), end: new Date(end) }
}

function encodeCursor(booking) {
  return Buffer.from(JSON.stringify({
    holdExpiresAt: booking.holdExpiresAt.toISOString(),
    id: String(booking._id),
  })).toString('base64url')
}

function decodeCursor(cursor) {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!value || !Number.isFinite(Date.parse(value.holdExpiresAt)) || !mongoose.Types.ObjectId.isValid(value.id)) {
      throw new Error('Invalid approvals cursor')
    }
    return value
  } catch {
    throw new AppError(400, 'INVALID_QUERY', 'Pagination cursor is invalid')
  }
}

function createMongoAdminRepository() {
  return {
    async dashboard(now = new Date()) {
      const today = nairobiDayRange(now)
      const month = nairobiMonthRange(now)
      const [
        activeBookings,
        pickups,
        returns,
        overdueVehicles,
        pendingApprovals,
        activeBreakdowns,
        completedBookings,
        vehicles,
        recentBookings,
        recentIncidents,
      ] = await Promise.all([
        Booking.find({ status: { $in: ['checked_out', 'overdue'] } }).select('vehicleId status').lean(),
        Booking.find({ status: 'confirmed', pickupAt: { $gte: today.start, $lt: today.end } })
          .populate({ path: 'vehicleId', select: 'make model registration' })
          .sort({ pickupAt: 1, _id: 1 })
          .limit(50)
          .lean(),
        Booking.find({ status: { $in: ['checked_out', 'overdue'] }, returnAt: { $gte: today.start, $lt: today.end } })
          .populate({ path: 'vehicleId', select: 'make model registration' })
          .sort({ returnAt: 1, _id: 1 })
          .limit(50)
          .lean(),
        Booking.countDocuments({ status: 'overdue' }),
        Booking.countDocuments({ status: 'reserved', pendingApproval: true, holdExpiresAt: { $gt: now } }),
        Incident.countDocuments({ status: { $ne: 'resolved' } }),
        Booking.find({ status: 'completed', pickupAt: { $gte: month.start, $lt: month.end } })
          .select('totalKes')
          .lean(),
        Vehicle.find({ status: { $ne: 'inactive' } }).select('status').lean(),
        Booking.find().sort({ updatedAt: -1, _id: -1 }).limit(5).select('reference updatedAt createdAt').lean(),
        Incident.find().sort({ createdAt: -1, _id: -1 }).limit(5).select('reference createdAt').lean(),
      ])

      const rentedIds = new Set(activeBookings.map((booking) => String(booking.vehicleId)))
      const reservedRows = await Booking.find({
        $or: [
          { status: 'confirmed' },
          { status: 'reserved', holdExpiresAt: { $gt: now } },
        ],
      }).select('vehicleId').lean()
      const reservedIds = new Set(reservedRows.map((booking) => String(booking.vehicleId)))
      const fleetStatus = { available: 0, rented: 0, reserved: 0, maintenance: 0 }
      for (const vehicle of vehicles) {
        if (vehicle.status === 'maintenance') fleetStatus.maintenance += 1
        else if (rentedIds.has(String(vehicle._id))) fleetStatus.rented += 1
        else if (reservedIds.has(String(vehicle._id)) || vehicle.status === 'booked') fleetStatus.reserved += 1
        else fleetStatus.available += 1
      }

      const recentActivity = [
        ...recentBookings.map((booking) => ({
          id: String(booking._id),
          kind: 'booking',
          reference: booking.reference,
          timestamp: (booking.updatedAt ?? booking.createdAt).toISOString(),
        })),
        ...recentIncidents.map((incident) => ({
          id: String(incident._id),
          kind: 'incident',
          reference: incident.reference,
          timestamp: incident.createdAt.toISOString(),
        })),
      ].sort((left, right) => right.timestamp.localeCompare(left.timestamp)).slice(0, 5)

      return {
        metrics: {
          vehiclesOutToday: activeBookings.length,
          pickupsDueToday: pickups.length,
          returnsDueToday: returns.length,
          overdueVehicles,
          pendingApprovals,
          activeBreakdowns,
          monthlyRevenue: completedBookings.reduce((total, booking) => total + booking.totalKes, 0),
        },
        pickups: pickups.map(bookingView),
        returns: returns.map(bookingView),
        fleetStatus,
        recentActivity,
      }
    },

    async notificationCounts(actor) {
      const canApprove = ['owner', 'manager', 'agent'].includes(actor.role)
      const canReadIncidents = ['owner', 'manager', 'agent', 'mechanic'].includes(actor.role)
      const [pendingApprovals, openIncidents] = await Promise.all([
        canApprove ? Booking.countDocuments({ status: 'reserved', pendingApproval: true, holdExpiresAt: { $gt: new Date() } }) : 0,
        canReadIncidents ? Incident.countDocuments({ status: { $ne: 'resolved' } }) : 0,
      ])
      return { pendingApprovals, openIncidents }
    },

    async search(query) {
      const pattern = new RegExp(escapeRegex(query), 'i')
      const [vehicles, bookings] = await Promise.all([
        Vehicle.find({ $or: [{ registration: pattern }, { make: pattern }, { model: pattern }] })
          .sort({ registration: 1, _id: 1 })
          .limit(8)
          .select('make model registration')
          .lean(),
        Booking.find({ $or: [{ reference: pattern }, { customerName: pattern }] })
          .sort({ createdAt: -1, _id: -1 })
          .limit(20)
          .select('reference customerId customerName')
          .lean(),
      ])
      const results = [
        ...vehicles.map((vehicle) => ({
          id: String(vehicle._id),
          type: 'vehicle',
          title: `${vehicle.make} ${vehicle.model}`,
          subtitle: vehicle.registration,
          href: `/admin/vehicles/${vehicle._id}`,
        })),
        ...bookings.filter((booking) => pattern.test(booking.reference)).map((booking) => ({
          id: String(booking._id),
          type: 'booking',
          title: booking.reference,
          subtitle: booking.customerName,
          href: `/admin/bookings/${booking._id}`,
        })),
        ...new Map(bookings.filter((booking) => pattern.test(booking.customerName))
          .map((booking) => [booking.customerId, {
            id: booking.customerId,
            type: 'customer',
            title: booking.customerName,
            subtitle: '',
            href: `/admin/bookings?customerId=${encodeURIComponent(booking.customerId)}`,
          }])).values(),
      ]
      return results.slice(0, 8)
    },

    async listPendingApprovals({ limit, cursor }, actorId, now = new Date()) {
      const position = decodeCursor(cursor)
      const filter = { status: 'reserved', pendingApproval: true, holdExpiresAt: { $gt: now }, createdById: { $ne: actorId } }
      if (position) {
        filter.$and = [{
          $or: [
            { holdExpiresAt: { $gt: new Date(position.holdExpiresAt) } },
            { holdExpiresAt: new Date(position.holdExpiresAt), _id: { $gt: new mongoose.Types.ObjectId(position.id) } },
          ],
        }]
      }
      const rows = await Booking.find(filter)
        .populate({ path: 'vehicleId', select: 'make model registration' })
        .sort({ holdExpiresAt: 1, _id: 1 })
        .limit(limit + 1)
        .lean()
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      return {
        items: page.map(bookingView),
        nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      }
    },
  }
}

module.exports = { createMongoAdminRepository }
