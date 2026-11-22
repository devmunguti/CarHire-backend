const { Readable } = require('node:stream')
const { AppError } = require('../lib/errors')

const imageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])

function detectImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

function createCloudinaryImageStore(config, cloudinary = require('cloudinary').v2, logger = require('../lib/logger').logger) {
  const configured = Boolean(config.CLOUDINARY_CLOUD_NAME && config.CLOUDINARY_API_KEY && config.CLOUDINARY_API_SECRET)
  if (configured) {
    cloudinary.config({
      cloud_name: config.CLOUDINARY_CLOUD_NAME,
      api_key: config.CLOUDINARY_API_KEY,
      api_secret: config.CLOUDINARY_API_SECRET,
      secure: true,
    })
  }

  return {
    async uploadVehicleImage(file) {
      if (!configured) {
        throw new AppError(503, 'IMAGE_STORAGE_UNAVAILABLE', 'Vehicle image uploads are not configured')
      }
      if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0 || file.buffer.length > 5 * 1024 * 1024) {
        throw new AppError(400, 'INVALID_FILE', 'Upload an image no larger than 5 MiB')
      }
      const detectedMime = detectImageMime(file.buffer)
      if (!detectedMime || !imageMimeTypes.has(detectedMime) || detectedMime !== file.mimetype) {
        throw new AppError(400, 'INVALID_FILE', 'Upload a valid JPEG, PNG, or WebP image')
      }

      try {
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream({
            folder: 'autohire/vehicles',
            resource_type: 'image',
            allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
          }, (error, uploaded) => {
            if (error) reject(error)
            else resolve(uploaded)
          })
          Readable.from(file.buffer).pipe(stream)
        })
        if (!result?.secure_url || !result?.public_id) throw new Error('Cloudinary returned incomplete image metadata')
        return { url: result.secure_url, publicId: result.public_id }
      } catch (error) {
        logger.error({ errorType: error?.name ?? 'UnknownError' }, 'Cloudinary vehicle image upload failed')
        throw new AppError(502, 'IMAGE_UPLOAD_FAILED', 'The vehicle image could not be uploaded')
      }
    },

    async deleteImage(publicId) {
      if (!configured || !publicId) return
      const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'image' })
      if (!['ok', 'not found'].includes(result.result)) {
        throw new AppError(502, 'IMAGE_DELETE_FAILED', 'The previous vehicle image could not be removed from storage')
      }
    },
  }
}

module.exports = { createCloudinaryImageStore, detectImageMime }
