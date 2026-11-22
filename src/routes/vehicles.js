const express = require('express')
const { z } = require('zod')
const { validate } = require('../middleware/validate')

const objectId = z.string().regex(/^[a-f\d]{24}$/i)
const dateTime = z.string().datetime({ offset: true }).transform((value) => new Date(value))
const status = z.enum(['available', 'maintenance', 'inactive'])
const vehicleFields = {
  make: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(100),
  category: z.string().trim().max(50).optional(),
  year: z.coerce.number().int().min(1900).max(new Date().getFullYear() + 1),
  registration: z.string().trim().min(2).max(20),
  seats: z.coerce.number().int().min(1).max(100),
  transmission: z.enum(['automatic', 'manual']),
  ratePerDay: z.coerce.number().int().min(0).max(1_000_000_000),
}
const vehicleCreate = z.object({ ...vehicleFields, status: status.optional() }).strict()
const vehiclePatch = z.object({ ...vehicleFields, status }).partial().strict().refine((value) => Object.keys(value).length > 0)
const listQuery = z.object({
  from: dateTime.optional(),
  to: dateTime.optional(),
  sort: z.enum(['registration:asc']).default('registration:asc'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
}).strict().refine((query) => Boolean(query.from) === Boolean(query.to), 'Both from and to are required for availability')
  .refine((query) => !query.from || Date.parse(query.to) > Date.parse(query.from), 'to must be after from')

function success(data) {
  return { success: true, data, error: null }
}

function createVehiclesRouter({ fleetService, requireAuth, requirePermission }) {
  const router = express.Router()

  router.get('/', validate(z.object({ query: listQuery })), async (req, res) => {
    res.json(success(await fleetService.listVehicles(req.validated.query)))
  })

  router.post('/', requireAuth, requirePermission('vehicles:manage'), validate(z.object({ body: vehicleCreate })), async (req, res) => {
    res.status(201).json(success(await fleetService.createVehicle(req.validated.body)))
  })

  router.get('/:vehicleId', validate(z.object({ params: z.object({ vehicleId: objectId }) })), async (req, res) => {
    res.json(success(await fleetService.getVehicle(req.validated.params.vehicleId)))
  })

  router.patch('/:vehicleId', requireAuth, requirePermission('vehicles:manage'), validate(z.object({
    params: z.object({ vehicleId: objectId }),
    body: vehiclePatch,
  })), async (req, res) => {
    res.json(success(await fleetService.updateVehicle(req.validated.params.vehicleId, req.validated.body)))
  })

  return router
}

module.exports = { createVehiclesRouter }
