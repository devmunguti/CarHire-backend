const express = require('express')
const path = require('node:path')
const cors = require('cors')
const helmet = require('helmet')
const cookieParser = require('cookie-parser')
const mongoose = require('mongoose')
const { env } = require('./config/env')
const { logger: defaultLogger } = require('./lib/logger')
const { AppError } = require('./lib/errors')
const { errorHandler } = require('./middleware/error-handler')
const { requestLogger } = require('./middleware/request-logger')
const { createAuthMiddleware } = require('./middleware/auth')
const { createMutationAuditMiddleware } = require('./middleware/audit-mutations')
const { authRepository: defaultRepository } = require('./repositories/mongo-auth-repository')
const { fleetRepository: defaultFleetRepository } = require('./repositories/mongo-fleet-repository')
const { createMongoOperationsRepository } = require('./repositories/mongo-operations-repository')
const { createMongoAdminRepository } = require('./repositories/mongo-admin-repository')
const { createMongoAuditRepository } = require('./repositories/mongo-audit-repository')
const { createAuthService } = require('./services/auth-service')
const { createAccountService } = require('./services/account-service')
const { createFleetService } = require('./services/fleet-service')
const { createBookingService } = require('./services/booking-service')
const { createGuestBookingService } = require('./services/guest-booking-service')
const { createPaymentService } = require('./services/payment-service')
const { createPrivateFileStore } = require('./services/private-file-store')
const { createPayHeroProvider } = require('./services/payhero-provider')
const { createMailer } = require('./services/mailer')
const { createAuthRouter } = require('./routes/auth')
const { createStaffRouter } = require('./routes/staff')
const { createVehiclesRouter } = require('./routes/vehicles')
const { createMaintenanceWindowsRouter } = require('./routes/maintenance-windows')
const { createBookingsRouter } = require('./routes/bookings')
const { createGuestBookingsRouter } = require('./routes/guest-bookings')
const { createPaymentsRouter } = require('./routes/payments')
const { createOperationsRouter } = require('./routes/operations')
const { createOperationsService } = require('./services/operations-service')
const { createAdminService } = require('./services/admin-service')
const { createAdminRouter } = require('./routes/admin')
const { createContactRouter } = require('./routes/contact')

function success(data) {
  return { success: true, data, error: null }
}

function createApp(options = {}) {
  const config = options.env ?? env
  const logger = options.logger ?? defaultLogger
  const repository = options.repository ?? defaultRepository
  const fleetRepository = options.fleetRepository ?? defaultFleetRepository
  const operationsRepository = options.operationsRepository ?? createMongoOperationsRepository()
  const adminRepository = options.adminRepository ?? createMongoAdminRepository()
  const auditRepository = options.auditRepository ?? createMongoAuditRepository()
  const mailer = options.mailer ?? createMailer(config)
  const authService = options.authService ?? createAuthService({
    repository,
    accessTokenSecret: config.ACCESS_TOKEN_SECRET,
  })
  const accountService = options.accountService ?? createAccountService({
    repository,
    mailer,
    logger,
    frontendBaseUrl: config.FRONTEND_BASE_URL,
  })
  const fleetService = options.fleetService ?? createFleetService({ repository: fleetRepository })
  const bookingService = options.bookingService ?? createBookingService({ repository: fleetRepository })
  const fileStore = options.fileStore ?? createPrivateFileStore(config.PRIVATE_UPLOAD_DIR || path.resolve(__dirname, '../private-files'))
  const paymentProvider = options.paymentProvider ?? createPayHeroProvider(config)
  const guestBookingService = options.guestBookingService ?? createGuestBookingService({ fileStore })
  const paymentService = options.paymentService ?? createPaymentService({ provider: paymentProvider })
  const operationsService = options.operationsService ?? createOperationsService({ repository: operationsRepository, fileStore })
  const adminService = options.adminService ?? createAdminService({ repository: adminRepository, auditRepository })
  const { requireAuth, optionalAuth, requirePermission, requireAnyPermission, requireRole } = createAuthMiddleware({
    authService,
    accessTokenSecret: config.ACCESS_TOKEN_SECRET,
  })
  const isDatabaseReady = options.isDatabaseReady ?? (() => mongoose.connection.readyState === 1)
  const app = express()

  app.disable('x-powered-by')
  app.use(requestLogger(logger))
  app.use(helmet())
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.CORS_ORIGINS.includes(origin)) return callback(null, origin || false)
      return callback(new AppError(403, 'CORS_ORIGIN_DENIED', 'Origin is not allowed'))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['Retry-After', 'X-Request-Id'],
  }))
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use(createMutationAuditMiddleware({ auditRepository }))

  app.get('/api/v1/health', (req, res, next) => {
    if (!isDatabaseReady()) {
      return next(new AppError(503, 'SERVICE_UNAVAILABLE', 'Database is not ready'))
    }
    res.json(success({ status: 'ok' }))
  })

  app.use('/api/v1/auth', createAuthRouter({ authService, accountService, requireAuth, env: config }))
  app.use('/api/v1/staff', createStaffRouter({ accountService, requireAuth, requirePermission }))
  app.use('/api/v1', createAdminRouter({ adminService, requireAuth, requirePermission, requireRole }))
  app.use('/api/v1/vehicles', createVehiclesRouter({ fleetService, requireAuth, requirePermission }))
  app.use('/api/v1/maintenance-windows', createMaintenanceWindowsRouter({
    fleetService,
    requireAuth,
    requireAnyPermission,
    requirePermission,
  }))
  app.use('/api/v1', createGuestBookingsRouter({
    guestBookingService,
    bookingService,
    requireAuth,
    optionalAuth,
    requirePermission,
    env: config,
  }))
  app.use('/api/v1', createPaymentsRouter({
    paymentService,
    requireAuth,
    optionalAuth,
    requirePermission,
    requireRole,
  }))
  app.use('/api/v1', createOperationsRouter({
    operationsService,
    requireAuth,
    optionalAuth,
    requirePermission,
    requireAnyPermission,
  }))
  app.use('/api/v1', createBookingsRouter({ bookingService, requireAuth, requirePermission, requireAnyPermission }))
  app.use('/contact', createContactRouter({ mailer, contactInbox: config.CONTACT_INBOX }))
  app.use((req, res, next) => next(new AppError(404, 'NOT_FOUND', 'Route was not found')))
  app.use(errorHandler(logger))

  return app
}

module.exports = { createApp }
