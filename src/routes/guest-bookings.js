const express = require('express')
const multer = require('multer')
const { z } = require('zod')
const { AppError } = require('../lib/errors')
const { validate } = require('../middleware/validate')

const objectId = z.string().regex(/^[a-f\d]{24}$/i)
const reference = z.string().regex(/^BK-[A-Z\d-]{4,80}$/i)
const checkoutBody = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().regex(/^254[17]\d{8}$/),
  email: z.string().email().max(254).transform((email) => email.toLowerCase()),
  idNumber: z.string().trim().min(4).max(50),
  paymentMethod: z.enum(['mpesa_online', 'cash']),
  termsAccepted: z.literal('true'),
  rulesAccepted: z.literal('true'),
}).strict()
const accessBody = z.object({ accessToken: z.string().min(32).max(256) }).strict()
const cancellationBody = z.object({ reason: z.string().trim().max(1000).optional() }).strict().optional()

function success(data) {
  return { success: true, data, error: null }
}

function createLicenceUpload() {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 7, fieldSize: 4096 },
  }).single('licence')
  return (req, res, next) => upload(req, res, (error) => {
    if (!error) return next()
    if (error.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'PAYLOAD_TOO_LARGE', 'Driving licence file exceeds 5 MiB'))
    if (error.code === 'LIMIT_UNEXPECTED_FILE') return next(new AppError(400, 'INVALID_FILE', 'Only one licence file may be uploaded'))
    return next(error)
  })
}

function createGuestBookingsRouter({
  guestBookingService,
  bookingService,
  requireAuth,
  optionalAuth,
  requirePermission,
  env,
}) {
  const router = express.Router()
  const uploadLicence = createLicenceUpload()

  router.get('/bookings/:bookingId/checkout', validate(z.object({
    params: z.object({ bookingId: objectId }),
  })), async (req, res) => {
    res.json(success(await guestBookingService.getCheckout(req.validated.params.bookingId)))
  })

  router.post('/bookings/:bookingId/checkout', uploadLicence, validate(z.object({
    params: z.object({ bookingId: objectId }),
    body: checkoutBody,
  })), async (req, res) => {
    const data = await guestBookingService.submitCheckout(
      req.validated.params.bookingId,
      req.validated.body,
      req.file,
    )
    res.status(201).json(success(data))
  })

  router.get('/bookings/:reference/guest', validate(z.object({
    params: z.object({ reference }),
  })), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(success(await guestBookingService.getGuestBooking(
      req.validated.params.reference,
      req.cookies?.booking_access,
    )))
  })

  router.post('/bookings/:reference/guest', validate(z.object({
    params: z.object({ reference }),
    body: accessBody,
  })), async (req, res) => {
    const { sessionToken, expiresAt } = await guestBookingService.exchangeAccess(
      req.validated.params.reference,
      req.validated.body.accessToken,
    )
    res.cookie('booking_access', sessionToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: `/api/v1/bookings/${encodeURIComponent(req.validated.params.reference)}`,
      expires: expiresAt,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.json(success({ accepted: true }))
  })

  router.post('/bookings/:bookingKey/cancel', optionalAuth, (req, res, next) => {
    if (req.user) return requirePermission('bookings:create')(req, res, next)
    return next()
  }, validate(z.object({
    params: z.object({ bookingKey: z.string().min(1).max(100) }),
    body: cancellationBody,
  })), async (req, res) => {
    if (req.user) {
      const bookingId = objectId.safeParse(req.validated.params.bookingKey)
      if (!bookingId.success) throw new AppError(400, 'VALIDATION_ERROR', 'Staff cancellation requires a booking ID')
      return res.json(success(await bookingService.cancelBooking(
        bookingId.data,
        req.validated.body?.reason,
        req.user,
      )))
    }
    const bookingRef = reference.safeParse(req.validated.params.bookingKey)
    if (!bookingRef.success) throw new AppError(401, 'GUEST_ACCESS_INVALID', 'Booking link unavailable')
    const result = await guestBookingService.cancelGuestBooking(
      bookingRef.data,
      req.cookies?.booking_access,
    )
    res.json(success({ cancelled: result.cancelled }))
  })

  router.get('/bookings/:bookingId/licence', requireAuth, requirePermission('bookings:create'), validate(z.object({
    params: z.object({ bookingId: objectId }),
  })), async (req, res) => {
    const file = await guestBookingService.getLicence(req.validated.params.bookingId)
    if (!file) throw new AppError(404, 'NOT_FOUND', 'Driving licence was not found')
    res.setHeader('Content-Type', file.mimeType)
    res.setHeader('Content-Disposition', `attachment; filename="driving-licence.${file.mimeType === 'application/pdf' ? 'pdf' : file.mimeType === 'image/png' ? 'png' : file.mimeType === 'image/webp' ? 'webp' : 'jpg'}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(file.buffer)
  })

  return router
}

module.exports = { createGuestBookingsRouter }
