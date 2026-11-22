class AppError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function unauthorized(message = 'Authentication is required') {
  return new AppError(401, 'UNAUTHENTICATED', message)
}

function forbidden(message = 'You do not have permission to perform this action') {
  return new AppError(403, 'FORBIDDEN', message)
}

module.exports = { AppError, unauthorized, forbidden }
