const express = require('express')
const { z } = require('zod')
const { AppError } = require('../lib/errors')
const { validate } = require('../middleware/validate')

const objectId = z.string().regex(/^[a-f\d]{24}$/i)
const paymentId = z.string().uuid()
const bookingReference = z.string().regex(/^BK-[A-Z\d-]{4,80}$/i)
const phone = z.string().regex(/^254[17]\d{8}$/)
const refundBody = z.object({
  paymentId: paymentId,
  reason: z.string().trim().min(1).max(1000),
}).strict()
const refundSettlementBody = z.object({
  status: z.enum(['refunded', 'failed']),
  providerReference: z.string().trim().min(1).max(120),
}).strict()
const callbackBody = z.object({
  status: z.boolean(),
  response: z.object({
    Amount: z.number().int().positive(),
    CheckoutRequestID: z.string().min(1).max(200),
    ExternalReference: z.string().uuid(),
    MerchantRequestID: z.string().min(1).max(200),
    MpesaReceiptNumber: z.string().max(120).optional(),
    Phone: z.string().min(10).max(20),
    ResultCode: z.number().int(),
    ResultDesc: z.string().max(1000),
    Status: z.enum(['Success', 'Failed']),
  }).strict(),
}).strict()

function success(data) {
  return { success: true, data, error: null }
}

function parseIdempotencyKey(req) {
  const raw = req.get('Idempotency-Key')
  if (raw === undefined) return undefined
  const result = z.string().min(16).max(128).safeParse(raw)
  if (!result.success) throw new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key must contain 16 to 128 characters')
  return result.data
}

function createPaymentsRouter({ paymentService, requireAuth, optionalAuth, requirePermission, requireRole }) {
  const router = express.Router()

  router.post('/bookings/:reference/payments/stk', optionalAuth, (req, res, next) => {
    if (req.user) return requirePermission('bookings:create')(req, res, next)
    return next()
  }, validate(z.object({
    params: z.object({ reference: bookingReference }),
    body: z.object({ phone }).strict(),
  })), async (req, res) => {
    const access = req.user
      ? { actor: req.user }
      : { sessionToken: req.cookies?.booking_access }
    const result = await paymentService.initiate(
      req.validated.params.reference,
      req.validated.body.phone,
      access,
      parseIdempotencyKey(req),
    )
    res.status(201).json(success(result))
  })

  router.get('/bookings/:reference/payments/:paymentId/status', optionalAuth, (req, res, next) => {
    if (req.user) return requirePermission('bookings:create')(req, res, next)
    return next()
  }, validate(z.object({
    params: z.object({ reference: bookingReference, paymentId }),
  })), async (req, res) => {
    const access = req.user
      ? { actor: req.user, reference: req.validated.params.reference }
      : { sessionToken: req.cookies?.booking_access, reference: req.validated.params.reference }
    res.json(success(await paymentService.getStatus(req.validated.params.paymentId, access)))
  })

  router.post('/webhooks/payhero', validate(z.object({ body: callbackBody })), async (req, res) => {
    res.json(success(await paymentService.receiveCallback(req.validated.body)))
  })

  router.post('/bookings/:bookingId/refunds', requireAuth, requireRole('owner'), validate(z.object({
    params: z.object({ bookingId: objectId }),
    body: refundBody,
  })), async (req, res) => {
    const refund = await paymentService.createRefund(
      req.validated.params.bookingId,
      req.validated.body.paymentId,
      req.validated.body.reason,
      req.user,
      parseIdempotencyKey(req),
    )
    res.status(201).json(success({
      id: refund.refundId,
      paymentId: refund.paymentId,
      amountKes: refund.amountKes,
      status: refund.status,
      reason: refund.reason,
      createdAt: refund.createdAt,
    }))
  })

  router.post('/bookings/:bookingId/refunds/:refundId/settlement', requireAuth, requireRole('owner'), validate(z.object({
    params: z.object({ bookingId: objectId, refundId: paymentId }),
    body: refundSettlementBody,
  })), async (req, res) => {
    const refund = await paymentService.recordRefundOutcome(
      req.validated.params.bookingId,
      req.validated.params.refundId,
      req.validated.body.status,
      req.validated.body.providerReference,
      req.user,
    )
    res.json(success({
      id: refund.refundId,
      paymentId: refund.paymentId,
      amountKes: refund.amountKes,
      status: refund.status,
      reason: refund.reason,
      createdAt: refund.createdAt,
    }))
  })

  return router
}

module.exports = { createPaymentsRouter }
