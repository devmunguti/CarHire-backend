const express = require('express')
const multer = require('multer')
const rateLimit = require('express-rate-limit')
const { z } = require('zod')
const { AppError, forbidden } = require('../lib/errors')
const { validate } = require('../middleware/validate')

const objectId = z.string().regex(/^[a-f\d]{24}$/i)
const photoId = z.string().uuid()
const dateTime = z.string().datetime({ offset: true }).transform((value) => new Date(value))
const pageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
  sort: z.string().optional(),
}
const pointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ]),
}).strict()
const handoverBody = z.object({
  odometer: z.number().int().min(0),
  fuelLevel: z.enum(['empty', 'quarter', 'half', 'three_quarters', 'full']),
  notes: z.string().max(1000),
  photos: z.array(z.string().max(200)).max(10),
  signatureConfirmed: z.literal(true),
  criticalDefect: z.boolean(),
}).strict()
const mechanicBody = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(1).max(30),
  whatsapp: z.string().trim().min(1).max(30),
  county: z.string().trim().min(1).max(120),
  town: z.string().trim().min(1).max(120),
  type: z.enum(['in_house', 'partner_garage', 'towing']),
  specialties: z.array(z.enum(['flat_tyre', 'battery', 'overheating', 'accident', 'strange_noise'])).max(10),
  callOutRateKes: z.number().int().min(0),
  location: pointSchema,
}).strict()
const incidentDispatchBody = z.object({
  type: z.enum(['closest_partner', 'in_house_rescue', 'replacement_vehicle']),
  mechanicId: objectId.optional(),
  vehicleId: objectId.optional(),
}).strict().superRefine((value, context) => {
  if (value.type === 'replacement_vehicle' && !value.vehicleId) {
    context.addIssue({ code: 'custom', path: ['vehicleId'], message: 'A replacement vehicle is required' })
  }
})

function success(data) {
  return { success: true, data, error: null }
}

function uploadMiddleware({ single, array, fields = 7 }) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: single ? 1 : 10, fields, fieldSize: 4096 },
  })[single ? 'single' : 'array'](single ? single : array, array ? 10 : undefined)
  return (req, res, next) => upload(req, res, (error) => {
    if (!error) return next()
    if (error.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'PAYLOAD_TOO_LARGE', 'Image exceeds 5 MiB'))
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new AppError(400, 'INVALID_FILE', 'Too many or unexpected files were uploaded'))
    }
    return next(error)
  })
}

function parseMultipartIncident(req, res, next) {
  let location
  try {
    location = JSON.parse(String(req.body.location ?? ''))
  } catch {
    return next(new AppError(400, 'INVALID_LOCATION', 'A valid GeoJSON location is required'))
  }
  const parsedPoint = pointSchema.safeParse(location)
  if (!parsedPoint.success) return next(new AppError(400, 'INVALID_LOCATION', 'A valid GeoJSON location is required'))
  const parsed = z.object({
    category: z.enum(['flat_tyre', 'battery', 'overheating', 'accident', 'strange_noise']),
    description: z.string().trim().min(1).max(3000),
    locationText: z.string().trim().min(1).max(300),
    vehicleId: objectId.optional(),
    immobilising: z.enum(['true', 'false']).transform((value) => value === 'true'),
  }).safeParse({
    category: req.body.category,
    description: req.body.description,
    locationText: req.body.locationText,
    vehicleId: req.body.vehicleId || undefined,
    immobilising: req.body.immobilising,
  })
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }))
    return next(new AppError(400, 'INVALID_INCIDENT', 'Incident details are invalid', details))
  }
  req.incidentInput = { ...parsed.data, location: parsedPoint.data }
  next()
}

function createOperationsRouter({ operationsService, requireAuth, optionalAuth, requirePermission, requireAnyPermission }) {
  const router = express.Router()
  const uploadInspection = uploadMiddleware({ single: 'file', fields: 1 })
  const uploadIncident = uploadMiddleware({ array: 'photos' })
  const incidentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: true,
    legacyHeaders: false,
    handler(req, res, next) {
      next(new AppError(429, 'RATE_LIMITED', 'Too many incident reports; try again later'))
    },
  })

  router.get('/drivers', requireAuth, requirePermission('drivers:assign'), validate(z.object({
    query: z.object({ ...pageQuery, sort: z.enum(['name:asc']).default('name:asc') }).strict(),
  })), async (req, res) => {
    res.json(success(await operationsService.listDrivers(req.validated.query)))
  })

  router.get('/drivers/available', requireAuth, requirePermission('drivers:assign'), validate(z.object({
    query: z.object({
      from: dateTime,
      to: dateTime,
      vehicleId: objectId,
    }).strict().refine((value) => value.to > value.from, { path: ['to'], message: 'to must be after from' }),
  })), async (req, res) => {
    res.json(success(await operationsService.listAvailableDrivers(req.validated.query)))
  })

  router.get('/drivers/me/trips', requireAuth, requirePermission('trips:read-own'), validate(z.object({
    query: z.object({ ...pageQuery, sort: z.enum(['pickupAt:asc']).default('pickupAt:asc') }).strict(),
  })), async (req, res) => {
    res.json(success(await operationsService.listMyDriverTrips(req.user.id, req.validated.query)))
  })

  router.post('/bookings/:bookingId/driver', requireAuth, requirePermission('drivers:assign'), validate(z.object({
    params: z.object({ bookingId: objectId }),
    body: z.object({ driverId: objectId }).strict(),
  })), async (req, res) => {
    res.json(success(await operationsService.assignDriver(
      req.validated.params.bookingId,
      req.validated.body.driverId,
      req.user,
    )))
  })

  router.post('/bookings/:bookingId/driver-status', requireAuth, requirePermission('trips:read-own'), validate(z.object({
    params: z.object({ bookingId: objectId }),
    body: z.object({ status: z.enum(['en_route_to_pickup', 'customer_onboard', 'trip_completed']) }).strict(),
  })), async (req, res) => {
    res.json(success(await operationsService.updateDriverTripStatus(
      req.validated.params.bookingId,
      req.validated.body.status,
      req.user,
    )))
  })

  router.post('/bookings/:bookingId/inspections/photos', requireAuth, requireAnyPermission('handover:manage', 'trips:read-own'), uploadInspection, validate(z.object({
    params: z.object({ bookingId: objectId }),
    body: z.object({ type: z.enum(['check_out', 'check_in']) }).strict(),
  })), async (req, res) => {
    if (!req.file) throw new AppError(400, 'INVALID_FILE', 'Upload one inspection photo')
    res.status(201).json(success(await operationsService.uploadInspectionPhoto(
      req.validated.params.bookingId,
      req.validated.body.type,
      req.file,
    )))
  })

  router.get('/bookings/:bookingId/inspections/photos/:photoId', requireAuth, requireAnyPermission('handover:manage', 'trips:read-own'), validate(z.object({
    params: z.object({ bookingId: objectId, photoId }),
  })), async (req, res) => {
    const photo = await operationsService.getInspectionPhoto(
      req.validated.params.bookingId,
      req.validated.params.photoId,
      req.user,
    )
    if (!photo) throw new AppError(404, 'NOT_FOUND', 'Inspection photo was not found')
    res.setHeader('Content-Type', photo.mimeType)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(photo.buffer)
  })

  router.post('/bookings/:bookingId/check-out', requireAuth, requireAnyPermission('handover:manage', 'trips:read-own'), validate(z.object({
    params: z.object({ bookingId: objectId }),
    body: handoverBody,
  })), async (req, res) => {
    res.json(success(await operationsService.checkOut(req.validated.params.bookingId, req.validated.body, req.user)))
  })

  router.post('/bookings/:bookingId/check-in/settlement', requireAuth, requireAnyPermission('handover:manage', 'trips:read-own'), validate(z.object({
    params: z.object({ bookingId: objectId }),
    body: z.object({ odometer: z.number().int().min(0) }).strict(),
  })), async (req, res) => {
    res.json(success(await operationsService.previewSettlement(
      req.validated.params.bookingId,
      req.validated.body.odometer,
      req.user,
    )))
  })

  router.post('/bookings/:bookingId/check-in', requireAuth, requireAnyPermission('handover:manage', 'trips:read-own'), validate(z.object({
    params: z.object({ bookingId: objectId }),
    body: handoverBody,
  })), async (req, res) => {
    res.json(success(await operationsService.checkIn(req.validated.params.bookingId, req.validated.body, req.user)))
  })

  router.get('/mechanics/nearest', requireAuth, requirePermission('mechanics:read'), validate(z.object({
    query: z.object({
      lat: z.coerce.number().min(-90).max(90),
      lng: z.coerce.number().min(-180).max(180),
      radiusKm: z.coerce.number().positive().max(500).default(50),
      limit: z.coerce.number().int().min(1).max(100).default(5),
      category: z.enum(['flat_tyre', 'battery', 'overheating', 'accident', 'strange_noise']).optional(),
    }).strict(),
  })), async (req, res) => {
    const { lat, lng, radiusKm, ...query } = req.validated.query
    res.json(success(await operationsService.findNearestMechanics({ latitude: lat, longitude: lng, radiusKm, ...query })))
  })

  router.get('/mechanics', requireAuth, requirePermission('mechanics:read'), validate(z.object({
    query: z.object({ ...pageQuery, sort: z.enum(['name:asc']).default('name:asc') }).strict(),
  })), async (req, res) => {
    res.json(success(await operationsService.listMechanics(req.validated.query)))
  })

  router.post('/mechanics', requireAuth, requirePermission('staff:manage'), validate(z.object({
    body: mechanicBody,
  })), async (req, res) => {
    res.status(201).json(success(await operationsService.createMechanic(req.validated.body)))
  })

  router.get('/incidents', requireAuth, requirePermission('incidents:manage'), validate(z.object({
    query: z.object({ ...pageQuery, sort: z.enum(['createdAt:desc']).default('createdAt:desc') }).strict(),
  })), async (req, res) => {
    res.json(success(await operationsService.listIncidents(req.validated.query)))
  })

  router.post('/incidents/breakdown', optionalAuth, (req, res, next) => {
    if (!req.user || ['owner', 'manager', 'agent', 'driver'].includes(req.user.role)) return next()
    return next(forbidden())
  }, incidentLimiter, uploadIncident, parseMultipartIncident, async (req, res) => {
    res.status(201).json(success(await operationsService.createIncident(req.incidentInput, req.user, req.files ?? [])))
  })

  router.get('/incidents/:incidentId/photos/:photoId', requireAuth, requirePermission('incidents:manage'), validate(z.object({
    params: z.object({ incidentId: objectId, photoId }),
  })), async (req, res) => {
    const photo = await operationsService.getIncidentPhoto(req.validated.params.incidentId, req.validated.params.photoId)
    if (!photo) throw new AppError(404, 'NOT_FOUND', 'Incident photo was not found')
    res.setHeader('Content-Type', photo.mimeType)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(photo.buffer)
  })

  router.patch('/incidents/:incidentId/dispatch', requireAuth, requirePermission('mechanics:dispatch'), validate(z.object({
    params: z.object({ incidentId: objectId }),
    body: incidentDispatchBody,
  })), async (req, res) => {
    res.json(success(await operationsService.dispatchIncident(
      req.validated.params.incidentId,
      req.validated.body,
      req.user,
    )))
  })

  router.post('/incidents/:incidentId/resolve', requireAuth, requirePermission('incidents:manage'), validate(z.object({
    params: z.object({ incidentId: objectId }),
    body: z.object({ resolution: z.string().trim().min(1).max(2000) }).strict(),
  })), async (req, res) => {
    res.json(success(await operationsService.resolveIncident(
      req.validated.params.incidentId,
      req.validated.body.resolution,
      req.user,
    )))
  })

  return router
}

module.exports = { createOperationsRouter }
