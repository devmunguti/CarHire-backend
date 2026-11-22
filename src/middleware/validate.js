const { AppError } = require('../lib/errors')

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    })
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }))
      return next(new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details))
    }
    req.validated = result.data
    next()
  }
}

module.exports = { validate }
