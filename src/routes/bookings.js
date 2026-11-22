const express = require('express')
const { z } = require('zod')
const { validate } = require('../middleware/validate')
const { AppError } = require('../lib/errors')

const objectId = z.string().regex(/^[a-f\d]{24}$/i)
const dateTime = z.string().datetime({ offset: true }).transform((value) => new Date(value))
const quoteFields = {
  vehicleId: objectId,
  pickupAt: dateTime,
  returnAt: dateTime,
  pickupLocation: z.string().trim().min(1).max(300),
  mode: z.enum(['self_drive', 'chauffeur']),
  driverLocation: z.enum(['in_town', 'upcountry']).optional(),
  extras: z.array(z.enum(['baby_seat', 'rooftop_tent', 'cooler_box', 'airport_pickup'])).max(10),
}
const quoteBody = z.object(quoteFields).strict()
const bookingBody = z.object({
  ...quoteFields,
  customerName: z.string().trim().min(2).max(120),
  customerPhone: z.string().regex(/^254[17]\d{8}$/),
  customerEmail: z.string().email().max(254).transform((email) => email.toLowerCase()),
  customerIdNumber: z.string().trim().min(4).max(50),
  paymentMethod: z.enum(['mpesa_online', 'mpesa_manual', 'cash', 'bank', 'corporate']),
}).strict()
const bookingStatus = z.enum(['reserved', 'confirmed', 'checked_out', 'overdue', 'completed', 'cancelled', 'expired'])
const listQuery = z.object({
  status: bookingStatus.optional(),
  paymentMethod: z.enum(['mpesa_online', 'mpesa_manual', 'cash', 'bank', 'corporate']).optional(),
  vehicleId: objectId.optional(),
  search: z.string().trim().max(100).optional(),
  from: dateTime.optional(),
  to: dateTime.optional(),
  pickup: z.enum(['due-today']).optional(),
  return: z.enum(['due-today']).optional(),
  sort: z.enum(['pickupAt:asc', 'pickupAt:desc', 'createdAt:desc']).default('pickupAt:asc'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
}).strict().refine((query) => !query.from || !query.to || query.to > query.from, {
  path: ['to'],
  message: 'to must be after from',
})
const approvalBody = z.object({
  paymentMethod: z.enum(['cash', 'mpesa_manual', 'bank', 'corporate']),
  reference: z.string().trim().min(1).max(120),
  reason: z.string().trim().max(1000).optional(),
}).strict()
function success(data) {
  return { success: true, data, error: null }
}

function createBookingsRouter({ bookingService, requireAuth, requirePermission, requireAnyPermission }) {
  const router = express.Router()

  router.post('/quotes/calculate', validate(z.object({ body: quoteBody })), async (req, res) => {
    res.json(success(await bookingService.calculateQuote(req.validated.body)))
  })

  router.get('/bookings', requireAuth, requirePermission('bookings:create'), validate(z.object({ query: listQuery })), async (req, res) => {
    res.json(success(await bookingService.listBookings(req.validated.query)))
  })

  router.post('/bookings', requireAuth, requirePermission('bookings:create'), validate(z.object({ body: bookingBody })), async (req, res) => {
    const rawKey = req.get('Idempotency-Key')
    const parsedKey = rawKey === undefined ? undefined : z.string().min(16).max(128).safeParse(rawKey)
    if (parsedKey && !parsedKey.success) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key must contain 16 to 128 characters')
    }
    const booking = await bookingService.createBooking(req.validated.body, req.user, parsedKey?.data)
    res.status(201).json(success(booking))
  })

  router.get('/bookings/:bookingId', requireAuth, requireAnyPermission('bookings:create', 'trips:read-own'), validate(z.object({
    params: z.object({ bookingId: objectId }),
  })), async (req, res) => {
    res.json(success(await bookingService.getBooking(req.validated.params.bookingId, req.user)))
  })

  router.post('/bookings/:bookingId/offline-approval', requireAuth, requirePermission('approvals:offline'), validate(z.object({
    params: z.object({ bookingId: objectId }),
    body: approvalBody,
  })), async (req, res) => {
    res.json(success(await bookingService.approveOfflinePayment(
      req.validated.params.bookingId,
      req.validated.body,
      req.user,
    )))
  })

  return router
}

module.exports = { createBookingsRouter }
