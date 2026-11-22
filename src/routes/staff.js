const express = require('express')
const { z } = require('zod')
const { validate } = require('../middleware/validate')

const invitationBody = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(254).transform((email) => email.toLowerCase()),
  phone: z.string().regex(/^254[17][0-9]{8}$/),
  role: z.enum(['owner', 'manager', 'agent', 'driver', 'mechanic']),
  branch: z.string().trim().min(1).max(120),
  driverProfile: z.object({
    languages: z.array(z.string().trim().min(1).max(40)).min(1).max(10),
    licenceClass: z.string().trim().min(1).max(20),
    licenceExpiresAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
    psvExpiresAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.role === 'driver' && !value.driverProfile) {
    context.addIssue({ code: 'custom', path: ['driverProfile'], message: 'Driver qualifications are required for driver invitations' })
  }
  if (value.role !== 'driver' && value.driverProfile) {
    context.addIssue({ code: 'custom', path: ['driverProfile'], message: 'Driver qualifications are only valid for driver invitations' })
  }
})
const objectId = z.string().regex(/^[a-f\d]{24}$/i)
const activeFilter = z.preprocess((value) => {
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}, z.boolean().optional())
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
  active: activeFilter,
  branch: z.string().trim().min(1).max(120).optional(),
  sort: z.enum(['name:asc']).default('name:asc'),
}).strict()
const staffPatch = z.object({
  role: z.enum(['owner', 'manager', 'agent', 'driver', 'mechanic']).optional(),
  branch: z.string().trim().min(1).max(120).optional(),
  active: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0)

function success(data) {
  return { success: true, data, error: null }
}

function createStaffRouter({ accountService, requireAuth, requirePermission }) {
  const router = express.Router()
  router.use(requireAuth, requirePermission('staff:manage'))

  router.get('/', validate(z.object({ query: listQuery })), async (req, res) => {
    res.json(success(await accountService.listStaff(req.validated.query, req.user)))
  })

  router.post('/', validate(z.object({ body: invitationBody })), async (req, res) => {
    const invitation = await accountService.createInvitation(req.user, req.validated.body)
    res.status(201).json(success(invitation))
  })

  router.patch('/:staffId', validate(z.object({
    params: z.object({ staffId: objectId }),
    body: staffPatch,
  })), async (req, res) => {
    res.json(success(await accountService.updateStaff(req.validated.params.staffId, req.validated.body, req.user)))
  })

  router.post('/invitations/:invitationId/resend', validate(z.object({
    params: z.object({ invitationId: objectId }),
  })), async (req, res) => {
    const invitation = await accountService.resendInvitation(req.validated.params.invitationId)
    res.json(success(invitation))
  })

  router.delete('/invitations/:invitationId', validate(z.object({
    params: z.object({ invitationId: objectId }),
  })), async (req, res) => {
    await accountService.revokeInvitation(req.validated.params.invitationId)
    res.json(success({ revoked: true }))
  })

  return router
}

module.exports = { createStaffRouter }
