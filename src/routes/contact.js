const express = require('express')
const { rateLimit } = require('express-rate-limit')
const { z } = require('zod')
const { AppError } = require('../lib/errors')
const { validate } = require('../middleware/validate')

const contactBody = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  phone: z.string().regex(/^254[17][0-9]{8}$/),
  message: z.string().trim().min(10).max(5000),
  companyWebsite: z.string().max(0).optional(),
}).strict()

function success(data) {
  return { success: true, data, error: null }
}

function createContactRouter({ mailer, contactInbox }) {
  const router = express.Router()
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler(req, res, next) {
      res.setHeader('Retry-After', '900')
      next(new AppError(429, 'RATE_LIMITED', 'Too many contact messages; try again later'))
    },
  })

  router.post('/', limiter, validate(z.object({ body: contactBody })), async (req, res) => {
    const { companyWebsite, ...message } = req.validated.body
    if (!companyWebsite) {
      await mailer.sendContactMessage({ to: contactInbox, ...message })
    }
    res.status(201).json(success({ received: true }))
  })

  return router
}

module.exports = { createContactRouter }
