const express = require('express')
const { rateLimit } = require('express-rate-limit')
const { z } = require('zod')
const { AppError } = require('../lib/errors')
const { validate } = require('../middleware/validate')

const emailSchema = z.string().email().max(254).transform((email) => email.toLowerCase())
const loginBody = z.object({
  email: emailSchema,
  password: z.string().min(1).max(1024),
})
const resetRequestBody = z.object({ email: emailSchema })
const resetConfirmBody = z.object({
  token: z.string().min(32).max(256),
  password: z.string().min(12).max(128),
})
const invitationAcceptBody = z.object({
  token: z.string().min(32).max(256),
  password: z.string().min(12).max(128),
})
const profilePatch = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().regex(/^254[17]\d{8}$/).optional(),
}).strict().refine((value) => Object.keys(value).length > 0)

function success(data) {
  return { success: true, data, error: null }
}

function createAuthRouter({ authService, accountService, requireAuth, env }) {
  const router = express.Router()
  const limiter = (limit, windowMs) => rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res, next) => {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)))
      next(new AppError(429, 'RATE_LIMITED', 'Too many requests; try again later'))
    },
  })
  const loginLimiter = limiter(10, 15 * 60 * 1000)
  const refreshLimiter = limiter(60, 15 * 60 * 1000)
  const resetLimiter = limiter(5, 60 * 60 * 1000)
  const cookieOptions = {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/v1/auth',
  }

  function setRefreshCookie(res, token, expiresAt) {
    res.cookie('refresh_token', token, {
      ...cookieOptions,
      expires: new Date(expiresAt),
    })
  }

  function clearRefreshCookie(res) {
    res.clearCookie('refresh_token', cookieOptions)
  }

  router.post('/login', loginLimiter, validate(z.object({ body: loginBody })), async (req, res) => {
    const result = await authService.login(req.validated.body)
    setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt)
    res.setHeader('Cache-Control', 'no-store')
    res.json(success({ accessToken: result.accessToken, user: result.user }))
  })

  router.post('/refresh', refreshLimiter, async (req, res) => {
    try {
      const result = await authService.refresh(req.cookies?.refresh_token)
      setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt)
      res.setHeader('Cache-Control', 'no-store')
      res.json(success({ accessToken: result.accessToken }))
    } catch (error) {
      clearRefreshCookie(res)
      throw error
    }
  })

  router.post('/logout', async (req, res) => {
    await authService.logout(req.cookies?.refresh_token)
    clearRefreshCookie(res)
    res.setHeader('Cache-Control', 'no-store')
    res.json(success({ loggedOut: true }))
  })

  router.get('/me', requireAuth, (req, res) => res.json(success(req.user)))

  router.patch('/me', requireAuth, validate(z.object({ body: profilePatch })), async (req, res) => {
    res.json(success(await authService.updateCurrentUser(req.user.id, req.validated.body)))
  })

  router.post('/password-reset/request', resetLimiter, validate(z.object({ body: resetRequestBody })), async (req, res) => {
    await accountService.requestPasswordReset(req.validated.body.email)
    res.status(202).json(success({ accepted: true }))
  })

  router.post('/password-reset/confirm', resetLimiter, validate(z.object({ body: resetConfirmBody })), async (req, res) => {
    await accountService.confirmPasswordReset(req.validated.body)
    res.json(success({ accepted: true }))
  })

  router.post('/invitations/accept', validate(z.object({ body: invitationAcceptBody })), async (req, res) => {
    const user = await accountService.acceptInvitation(req.validated.body)
    res.json(success(user))
  })

  return router
}

module.exports = { createAuthRouter }
