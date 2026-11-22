const { env } = require('./config/env')
const { connectDatabase, disconnectDatabase } = require('./config/database')
const { logger } = require('./lib/logger')
const { createApp } = require('./app')
const { createPrivateFileStore } = require('./services/private-file-store')

async function startServer() {
  await connectDatabase()
  const fileStore = createPrivateFileStore(env.PRIVATE_UPLOAD_DIR)
  await fileStore.cleanupExpired()
  const cleanupTimer = setInterval(() => {
    fileStore.cleanupExpired().catch((error) => {
      logger.error({ err: error }, 'expired licence cleanup failed')
    })
  }, 60 * 60 * 1000)
  cleanupTimer.unref()
  const app = createApp({ fileStore })
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    logger.info({ port: env.PORT }, 'AutoHire API listening')
  })

  async function shutdown(signal) {
    logger.info({ signal }, 'shutting down')
    clearInterval(cleanupTimer)
    server.close(async (error) => {
      if (error) {
        logger.error({ err: error }, 'HTTP server shutdown failed')
        process.exitCode = 1
      }
      await disconnectDatabase()
    })
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  return server
}

if (require.main === module) {
  startServer().catch((error) => {
    logger.fatal({ err: error }, 'failed to start AutoHire API')
    process.exitCode = 1
  })
}

module.exports = { startServer }
