const express = require('express')
const { z } = require('zod')
const { validate } = require('../middleware/validate')

const dateTime = z.string().datetime({ offset: true }).transform((value) => new Date(value))
const page = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
}
const auditQuery = z.object({
  ...page,
  actorId: z.string().min(1).max(120).optional(),
  action: z.string().trim().min(1).max(200).optional(),
  entity: z.string().trim().min(1).max(160).optional(),
  from: dateTime.optional(),
  to: dateTime.optional(),
  sort: z.enum(['createdAt:desc']).default('createdAt:desc'),
}).strict().refine((value) => !value.from || !value.to || value.to >= value.from, {
  path: ['to'],
  message: 'to must be on or after from',
})

function success(data) {
  return { success: true, data, error: null }
}

function createAdminRouter({ adminService, requireAuth, requirePermission, requireRole }) {
  const router = express.Router()

  router.get('/dashboard', requireAuth, requirePermission('dashboard:view'), async (req, res) => {
    res.json(success(await adminService.getDashboard()))
  })

  router.get('/notifications', requireAuth, async (req, res) => {
    res.json(success(await adminService.getNotificationCounts(req.user)))
  })

  router.get('/search', requireAuth, requirePermission('dashboard:view'), validate(z.object({
    query: z.object({ q: z.string().trim().min(2).max(100) }).strict(),
  })), async (req, res) => {
    res.json(success(await adminService.search(req.validated.query.q)))
  })

  router.get('/approvals', requireAuth, requirePermission('approvals:offline'), validate(z.object({
    query: z.object({
      ...page,
      sort: z.enum(['holdExpiresAt:asc']).default('holdExpiresAt:asc'),
    }).strict(),
  })), async (req, res) => {
    res.json(success(await adminService.listPendingApprovals(req.validated.query, req.user.id)))
  })

  router.get('/audit', requireAuth, requireRole('owner'), validate(z.object({
    query: auditQuery,
  })), async (req, res) => {
    res.json(success(await adminService.listAuditEntries(req.validated.query)))
  })

  return router
}

module.exports = { createAdminRouter }
