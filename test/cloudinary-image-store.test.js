const assert = require('node:assert/strict')
const { describe, it } = require('node:test')
const { Writable } = require('node:stream')
const { createCloudinaryImageStore } = require('../src/services/cloudinary-image-store')
const { createFleetService } = require('../src/services/fleet-service')

const config = {
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-key',
  CLOUDINARY_API_SECRET: 'test-secret',
}
const testLogger = { error() {}, warn() {} }
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function fakeCloudinary({ uploadError } = {}) {
  const calls = { configuration: null, options: null, deletes: [] }
  const cloudinary = {
    config(configuration) {
      calls.configuration = configuration
    },
    uploader: {
      upload_stream(options, callback) {
        calls.options = options
        return new Writable({
          write(chunk, encoding, done) { done() },
          final(done) {
            callback(uploadError ?? null, uploadError ? undefined : {
              secure_url: 'https://res.cloudinary.com/test-cloud/image/upload/vehicle.png',
              public_id: 'autohire/vehicles/vehicle',
            })
            done()
          },
        })
      },
      async destroy(publicId, options) {
        calls.deletes.push({ publicId, options })
        return { result: 'ok' }
      },
    },
  }
  return { cloudinary, calls }
}

describe('Cloudinary vehicle image storage', () => {
  it('uploads image bytes securely and returns the CDN URL and cleanup id', async () => {
    const { cloudinary, calls } = fakeCloudinary()
    const store = createCloudinaryImageStore(config, cloudinary, testLogger)
    const result = await store.uploadVehicleImage({ buffer: png, mimetype: 'image/png' })

    assert.deepEqual(result, {
      url: 'https://res.cloudinary.com/test-cloud/image/upload/vehicle.png',
      publicId: 'autohire/vehicles/vehicle',
    })
    assert.equal(calls.configuration.secure, true)
    assert.equal(calls.options.folder, 'autohire/vehicles')
    assert.deepEqual(calls.options.allowed_formats, ['jpg', 'jpeg', 'png', 'webp'])
    await store.deleteImage(result.publicId)
    assert.deepEqual(calls.deletes[0], {
      publicId: 'autohire/vehicles/vehicle',
      options: { resource_type: 'image' },
    })
  })

  it('rejects unconfigured storage, oversized images, and spoofed image content', async () => {
    const unconfigured = createCloudinaryImageStore({}, fakeCloudinary().cloudinary, testLogger)
    await assert.rejects(unconfigured.uploadVehicleImage({ buffer: png, mimetype: 'image/png' }), { code: 'IMAGE_STORAGE_UNAVAILABLE' })

    const { cloudinary } = fakeCloudinary()
    const store = createCloudinaryImageStore(config, cloudinary, testLogger)
    await assert.rejects(store.uploadVehicleImage({ buffer: Buffer.alloc(5 * 1024 * 1024 + 1), mimetype: 'image/png' }), { code: 'INVALID_FILE' })
    await assert.rejects(store.uploadVehicleImage({ buffer: Buffer.from('not an image'), mimetype: 'image/png' }), { code: 'INVALID_FILE' })
  })

  it('translates provider failures without exposing provider details to clients', async () => {
    const { cloudinary } = fakeCloudinary({ uploadError: new Error('provider response with secret material') })
    const store = createCloudinaryImageStore(config, cloudinary, testLogger)

    await assert.rejects(store.uploadVehicleImage({ buffer: png, mimetype: 'image/png' }), {
      code: 'IMAGE_UPLOAD_FAILED',
      message: 'The vehicle image could not be uploaded',
    })
  })
})

describe('fleet image replacement', () => {
  it('persists the new CDN URL and removes the previous Cloudinary asset', async () => {
    const uploaded = { url: 'https://res.cloudinary.com/test-cloud/image/upload/new.png', publicId: 'new' }
    const repositoryCalls = []
    const deleted = []
    const fleetService = createFleetService({
      repository: {
        async updateVehicleImage(id, image) {
          repositoryCalls.push({ id, image })
          return { vehicle: { id, imageUrl: image.url }, previousPublicId: 'old' }
        },
      },
      imageStore: {
        async uploadVehicleImage() { return uploaded },
        async deleteImage(publicId) { deleted.push(publicId) },
      },
      logger: testLogger,
    })

    await assert.doesNotReject(async () => {
      const vehicle = await fleetService.uploadVehicleImage('vehicle-id', { buffer: png })
      assert.equal(vehicle.imageUrl, uploaded.url)
    })
    assert.deepEqual(repositoryCalls, [{ id: 'vehicle-id', image: uploaded }])
    assert.deepEqual(deleted, ['old'])
  })

  it('cleans up an uploaded image if the vehicle cannot be updated', async () => {
    const deleted = []
    const fleetService = createFleetService({
      repository: { async updateVehicleImage() { return null } },
      imageStore: {
        async uploadVehicleImage() { return { url: 'https://res.cloudinary.com/test/new.png', publicId: 'new' } },
        async deleteImage(publicId) { deleted.push(publicId) },
      },
      logger: testLogger,
    })

    await assert.rejects(fleetService.uploadVehicleImage('missing-id', { buffer: png }), {
      code: 'NOT_FOUND',
      status: 404,
    })
    assert.deepEqual(deleted, ['new'])
  })
})
