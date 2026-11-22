const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('node:test')
const express = require('express')
const { AppError } = require('../src/lib/errors')
const { errorHandler } = require('../src/middleware/error-handler')
const { createVehiclesRouter } = require('../src/routes/vehicles')
const { startTestServer, testLogger } = require('../test-support/helpers')

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const vehicleId = '507f1f77bcf86cd799439011'

async function setup() {
  const uploaded = []
  const app = express()
  app.use('/api/v1/vehicles', createVehiclesRouter({
    fleetService: {
      async uploadVehicleImage(id, file) {
        uploaded.push({ id, file })
        return { id, imageUrl: 'https://res.cloudinary.com/test/vehicle.png' }
      },
    },
    requireAuth(req, res, next) {
      if (req.get('authorization') !== 'Bearer owner-token') return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication is required'))
      req.user = { role: 'owner' }
      next()
    },
    requirePermission(permission) {
      return (req, res, next) => req.user?.role === 'owner'
        ? next()
        : next(new AppError(403, 'FORBIDDEN', `Permission ${permission} is required`))
    },
  }))
  app.use(errorHandler(testLogger()))
  const server = await startTestServer(app)
  return { ...server, uploaded }
}

function formWithImage(bytes = png) {
  const form = new FormData()
  form.append('image', new Blob([bytes], { type: 'image/png' }), 'vehicle.png')
  return form
}

describe('vehicle image upload route', () => {
  let server
  beforeEach(async () => {
    server = await setup()
  })
  afterEach(async () => {
    if (server) await server.close()
    server = null
  })

  it('requires an authenticated fleet manager and returns the persisted vehicle', async () => {
    const denied = await fetch(`${server.baseUrl}/api/v1/vehicles/${vehicleId}/image`, {
      method: 'POST',
      body: formWithImage(),
    })
    assert.equal(denied.status, 401)
    assert.equal(server.uploaded.length, 0)

    const response = await fetch(`${server.baseUrl}/api/v1/vehicles/${vehicleId}/image`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token' },
      body: formWithImage(),
    })
    assert.equal(response.status, 201)
    const envelope = await response.json()
    assert.equal(envelope.data.imageUrl, 'https://res.cloudinary.com/test/vehicle.png')
    assert.equal(server.uploaded[0].id, vehicleId)
    assert.deepEqual(server.uploaded[0].file.buffer, Buffer.from(png))
  })

  it('rejects uploads larger than 5 MiB before invoking storage', async () => {
    const response = await fetch(`${server.baseUrl}/api/v1/vehicles/${vehicleId}/image`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token' },
      body: formWithImage(new Uint8Array(5 * 1024 * 1024 + 1)),
    })
    assert.equal(response.status, 413)
    assert.equal((await response.json()).error.code, 'PAYLOAD_TOO_LARGE')
    assert.equal(server.uploaded.length, 0)
  })
})
