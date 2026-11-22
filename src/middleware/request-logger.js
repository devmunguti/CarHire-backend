const { randomUUID } = require('node:crypto')

function requestLogger(logger) {
  return (req, res, next) => {
    req.id = randomUUID()
    res.setHeader('X-Request-Id', req.id)
    const startedAt = process.hrtime.bigint()
    res.on('finish', () => {
      logger.info({
        requestId: req.id,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      }, 'request completed')
    })
    next()
  }
}

module.exports = { requestLogger }
