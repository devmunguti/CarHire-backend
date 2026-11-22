const pino = require('pino')
const { env } = require('../config/env')

const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'passwordHash',
      'refreshToken',
      'token',
      'accessToken',
    ],
    censor: '[REDACTED]',
  },
})

module.exports = { logger }
