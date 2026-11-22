const { AppError } = require('../lib/errors')

function errorHandler(logger) {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error)

    let status = 500
    let code = 'INTERNAL_ERROR'
    let message = 'An unexpected error occurred'
    let details

    if (error instanceof AppError) {
      status = error.status
      code = error.code
      message = error.message
      details = error.details
    } else if (error?.type === 'entity.parse.failed') {
      status = 400
      code = 'INVALID_JSON'
      message = 'Request body contains invalid JSON'
    } else if (error?.type === 'entity.too.large') {
      status = 413
      code = 'PAYLOAD_TOO_LARGE'
      message = 'Request body exceeds the allowed size'
    } else if (error?.name === 'ValidationError') {
      status = 422
      code = 'VALIDATION_ERROR'
      message = 'Stored data failed validation'
    } else if (error?.code === 11000) {
      status = 409
      code = error.keyPattern?.email ? 'DUPLICATE_EMAIL' : 'CONFLICT'
      message = error.keyPattern?.email
        ? 'An account already uses this email'
        : 'A record with the supplied value already exists'
    } else {
      logger.error({ err: error, requestId: req.id, method: req.method, path: req.path }, 'request failed')
    }

    const body = { success: false, data: null, error: { code, message } }
    if (details) body.error.details = details
    res.status(status).json(body)
  }
}

module.exports = { errorHandler }
