const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { Booking } = require('../models')

const licenceMimeExtensions = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
})
const operationMimeExtensions = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
})

function detectLicenceMime(buffer) {
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

function createPrivateFileStore(directory) {
  const root = path.resolve(directory)

  function resolveKey(key) {
    if (typeof key !== 'string' || !/^[a-f\d-]+\.(jpg|png|webp|pdf)$/.test(key)) {
      throw new Error('Stored private file key is invalid')
    }
    const resolved = path.resolve(root, key)
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Stored private file path escaped its root')
    return resolved
  }

  return {
    async saveLicence(file) {
      const mimeType = detectLicenceMime(file.buffer)
      if (!mimeType || !Object.hasOwn(licenceMimeExtensions, mimeType)) {
        return null
      }
      await fs.mkdir(root, { recursive: true })
      const key = `${randomUUID()}.${licenceMimeExtensions[mimeType]}`
      await fs.writeFile(resolveKey(key), file.buffer, { flag: 'wx', mode: 0o600 })
      return {
        storageKey: key,
        mimeType,
        sizeBytes: file.size,
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
      }
    },

    async saveOperationPhoto(file) {
      const mimeType = detectLicenceMime(file.buffer)
      if (!mimeType || !Object.hasOwn(operationMimeExtensions, mimeType)) return null
      await fs.mkdir(root, { recursive: true })
      const key = `${randomUUID()}.${operationMimeExtensions[mimeType]}`
      await fs.writeFile(resolveKey(key), file.buffer, { flag: 'wx', mode: 0o600 })
      return {
        storageKey: key,
        mimeType,
        sizeBytes: file.size,
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
      }
    },

    read(key) {
      return fs.readFile(resolveKey(key))
    },

    async remove(key) {
      try {
        await fs.unlink(resolveKey(key))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    },

    async cleanupExpired(now = new Date()) {
      const expired = await Booking.find({ 'licence.deleteAfter': { $lte: now } })
        .select('+licence.storageKey +licence.deleteAfter')
        .lean()
      for (const booking of expired) {
        if (!booking.licence?.storageKey) continue
        await this.remove(booking.licence.storageKey)
        await Booking.updateOne(
          { _id: booking._id, 'licence.storageKey': booking.licence.storageKey },
          { $unset: { licence: 1 } },
        )
      }
      return expired.length
    },
  }
}

module.exports = { createPrivateFileStore, detectLicenceMime }
