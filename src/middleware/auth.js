const { forbidden, unauthorized } = require('../lib/errors')
const { verifyAccessToken } = require('../services/tokens')

const ROLE_PERMISSIONS = Object.freeze({
  owner: [
    'dashboard:view', 'timeline:view', 'vehicles:read', 'vehicles:manage', 'bookings:create',
    'payments:record', 'approvals:offline', 'booking:approve-corporate', 'handover:manage',
    'drivers:assign', 'mechanics:read', 'mechanics:dispatch', 'incidents:manage', 'staff:manage',
    'audit:read', 'settings:manage', 'maintenance:read',
  ],
  manager: [
    'dashboard:view', 'timeline:view', 'vehicles:read', 'vehicles:manage', 'bookings:create',
    'payments:record', 'approvals:offline', 'booking:approve-corporate', 'handover:manage',
    'drivers:assign', 'mechanics:read', 'mechanics:dispatch', 'incidents:manage', 'staff:manage',
    'maintenance:read',
  ],
  agent: [
    'dashboard:view', 'timeline:view', 'vehicles:read', 'bookings:create', 'payments:record',
    'approvals:offline', 'handover:manage', 'drivers:assign', 'mechanics:read',
    'mechanics:dispatch', 'incidents:manage',
  ],
  driver: ['handover:manage', 'mechanics:read', 'trips:read-own'],
  mechanic: ['vehicles:read', 'incidents:manage', 'maintenance:read'],
})

function createAuthMiddleware({ authService, accessTokenSecret }) {
  const requireAuth = async (req, res, next) => {
    const authorization = req.get('authorization') ?? ''
    const match = /^Bearer ([^\s]+)$/i.exec(authorization)
    if (!match) return next(unauthorized())

    const token = verifyAccessToken(match[1], accessTokenSecret)
    if (!token) return next(unauthorized('Access token is invalid or expired'))

    const user = await authService.authenticate(token)
    req.user = user
    next()
  }

  const optionalAuth = (req, res, next) => {
    if (!req.get('authorization')) return next()
    return requireAuth(req, res, next)
  }

  const requirePermission = (permission) => (req, res, next) => {
    if (!req.user) return next(unauthorized())
    if (!ROLE_PERMISSIONS[req.user.role]?.includes(permission)) return next(forbidden())
    next()
  }

  const requireAnyPermission = (...permissions) => (req, res, next) => {
    if (!req.user) return next(unauthorized())
    if (!permissions.some((permission) => ROLE_PERMISSIONS[req.user.role]?.includes(permission))) return next(forbidden())
    next()
  }

  const requireRole = (...roles) => (req, res, next) => {
    if (!req.user) return next(unauthorized())
    if (!roles.includes(req.user.role)) return next(forbidden())
    next()
  }

  return { requireAuth, optionalAuth, requirePermission, requireAnyPermission, requireRole }
}

module.exports = { ROLE_PERMISSIONS, createAuthMiddleware }
