const express = require('express')
const { z } = require('zod')
const { validate } = require('../middleware/validate')

const objectId = z.string().regex(/^[a-f\d]{24}$/i)
const dateTime = z.string().datetime({ offset: true }).transform((value) => new Date(value))
const windowCreate = z.object({
  vehicleId: objectId,
  startAt: dateTime,
  endAt: dateTime,
  reason: z.string().trim().min(1).max(1000),
}).strict().refine((value) => value.endAt > value.startAt, {
  path: ['endAt'],
  message: 'endAt must be after startAt',
})
const windowPatch = z.object({
  startAt: dateTime.optional(),
  endAt: dateTime.optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0)
const listQuery = z.object({
  from: dateTime,
  to: dateTime,
  sort: z.enum(['startAt:asc']).default('startAt:asc'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
}).strict().refine((query) => query.to > query.from, {
  path: ['to'],
  message: 'to must be after from',
})

function success(data) {
  return { success: true, data, error: null }
}

function createMaintenanceWindowsRouter({ fleetService, requireAuth, requireAnyPermission, requirePermission }) {
  const router = express.Router()
  const canRead = requireAnyPermission('maintenance:read', 'timeline:view')

  router.get('/', requireAuth, canRead, validate(z.object({ query: listQuery })), async (req, res) => {
    res.json(success(await fleetService.listMaintenanceWindows(req.validated.query)))
  })

  router.post('/', requireAuth, requirePermission('vehicles:manage'), validate(z.object({ body: windowCreate })), async (req, res) => {
    res.status(201).json(success(await fleetService.createMaintenanceWindow(req.validated.body, req.user.id)))
  })

  router.patch('/:windowId', requireAuth, requirePermission('vehicles:manage'), validate(z.object({
    params: z.object({ windowId: objectId }),
    body: windowPatch,
  })), async (req, res) => {
    res.json(success(await fleetService.updateMaintenanceWindow(req.validated.params.windowId, req.validated.body)))
  })

  router.delete('/:windowId', requireAuth, requirePermission('vehicles:manage'), validate(z.object({
    params: z.object({ windowId: objectId }),
  })), async (req, res) => {
    res.json(success(await fleetService.deleteMaintenanceWindow(req.validated.params.windowId)))
  })

  return router
}

module.exports = { createMaintenanceWindowsRouter }
