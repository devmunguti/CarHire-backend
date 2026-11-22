const mongoose = require('mongoose')
const { randomUUID } = require('node:crypto')
const { AppError } = require('../lib/errors')

function createOperationsService({ repository, fileStore, now = () => new Date() }) {
  async function savePhotos(files, urlForPhoto) {
    const saved = []
    try {
      for (const file of files) {
        const metadata = await fileStore.saveOperationPhoto(file)
        if (!metadata) throw new AppError(400, 'INVALID_FILE', 'Upload a JPEG, PNG, or WebP image')
        saved.push({ id: randomUUID(), ...metadata })
      }
      return saved.map((photo) => ({ ...photo, url: urlForPhoto(photo.id) }))
    } catch (error) {
      await Promise.all(saved.map((photo) => fileStore.remove(photo.storageKey)))
      throw error
    }
  }

  return {
    listDrivers(query) {
      return repository.listDrivers(query)
    },

    listAvailableDrivers(query) {
      return repository.listAvailableDrivers(query)
    },

    async listMyDriverTrips(driverId, query) {
      await repository.markOverdue(now())
      return repository.listMyDriverTrips(driverId, query)
    },

    assignDriver(bookingId, driverId, actor) {
      return repository.assignDriver(bookingId, driverId, actor, now())
    },

    updateDriverTripStatus(bookingId, status, actor) {
      return repository.updateDriverTripStatus(bookingId, status, actor, now())
    },

    async uploadInspectionPhoto(bookingId, type, file) {
      const photos = await savePhotos([file], (id) => `/bookings/${bookingId}/inspections/photos/${id}`)
      try {
        const url = await repository.uploadInspectionPhoto(bookingId, type, photos[0])
        return { url }
      } catch (error) {
        await fileStore.remove(photos[0].storageKey)
        throw error
      }
    },

    async getInspectionPhoto(bookingId, photoId, actor) {
      const photo = await repository.getInspectionPhoto(bookingId, photoId, actor)
      if (!photo) return null
      return { buffer: await fileStore.read(photo.storageKey), mimeType: photo.mimeType }
    },

    checkOut(bookingId, input, actor) {
      return repository.checkOut(bookingId, input, actor, now())
    },

    previewSettlement(bookingId, odometer, actor) {
      return repository.previewSettlement(bookingId, odometer, actor, now())
    },

    checkIn(bookingId, input, actor) {
      return repository.checkIn(bookingId, input, actor, now())
    },

    listMechanics(query) {
      return repository.listMechanics(query)
    },

    createMechanic(input) {
      return repository.createMechanic(input)
    },

    findNearestMechanics(query) {
      return repository.findNearestMechanics(query)
    },

    async createIncident(input, actor, files) {
      const incidentId = new mongoose.Types.ObjectId()
      const photos = await savePhotos(files, (id) => `/incidents/${incidentId}/photos/${id}`)
      try {
        return await repository.createIncident(input, actor, photos, now(), incidentId)
      } catch (error) {
        await Promise.all(photos.map((photo) => fileStore.remove(photo.storageKey)))
        throw error
      }
    },

    listIncidents(query) {
      return repository.listIncidents(query)
    },

    async getIncidentPhoto(incidentId, photoId) {
      const photo = await repository.getIncidentPhoto(incidentId, photoId)
      if (!photo) return null
      return { buffer: await fileStore.read(photo.storageKey), mimeType: photo.mimeType }
    },

    dispatchIncident(incidentId, input, actor) {
      return repository.dispatchIncident(incidentId, input, actor, now())
    },

    resolveIncident(incidentId, resolution, actor) {
      return repository.resolveIncident(incidentId, resolution, actor, now())
    },
  }
}

module.exports = { createOperationsService }
