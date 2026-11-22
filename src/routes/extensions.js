const express = require('express')
const rateLimit = require('express-rate-limit')
const { z } = require('zod')
const { AppError } = require('../lib/errors')
const { validate } = require('../middleware/validate')

const reference = z.string().regex(/^BK-[A-Z\d-]{4,80}$/i)
const objectId = z.string().regex(/^[a-f\d]{24}$/i)
const dateTime = z.string().datetime({ offset: true }).transform((value) => new Date(value))

function success(data) {
  return { success: true, data, error: null }
}

function createExtensionsRouter({ extensionService, requireAuth, requirePermission }) {
  const router = express.Router()
  const requestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 4,
    standardHeaders: true,
    legacyHeaders: false,
    handler(req, res, next) {
      next(new AppError(429, 'RATE_LIMITED', 'Too many extension requests; try again later'))
    },
  })
  const requestBody = z.object({
    requestedReturnAt: dateTime,
    reason: z.string().trim().min(1).max(1000),
  }).strict()
  const reviewBody = z.object({
    decision: z.enum(['approve', 'decline']),
    paymentMethod: z.enum(['cash', 'mpesa_manual', 'bank']).optional(),
    paymentReference: z.string().trim().min(1).max(120).optional(),
    reviewNote: z.string().trim().max(1000).optional(),
  }).strict().superRefine((body, context) => {
    if (Boolean(body.paymentMethod) !== Boolean(body.paymentReference)) {
      context.addIssue({ code: 'custom', path: ['paymentReference'], message: 'Payment method and offline payment reference must be supplied together' })
    }
  })

  router.post('/bookings/:reference/extensions', requestLimiter, validate(z.object({
    params: z.object({ reference }),
    body: requestBody,
  })), async (req, res) => {
    const result = await extensionService.requestGuestExtension(
      req.validated.params.reference,
      req.cookies?.booking_access,
      req.validated.body,
    )
    res.status(201).json(success(result))
  })

  router.get('/extensions', requireAuth, requirePermission('bookings:create'), validate(z.object({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().max(512).optional(),
      status: z.enum(['pending', 'approved', 'declined']).default('pending'),
    }).strict(),
  })), async (req, res) => {
    res.json(success(await extensionService.listRequests(req.validated.query)))
  })

  router.post('/extensions/:extensionId/decision', requireAuth, requirePermission('bookings:create'), validate(z.object({
    params: z.object({ extensionId: objectId }),
    body: reviewBody,
  })), async (req, res) => {
    const result = await extensionService.reviewRequest(
      req.validated.params.extensionId,
      req.validated.body,
      req.user,
    )
    res.json(success(result))
  })

  return router
}

module.exports = { createExtensionsRouter }
