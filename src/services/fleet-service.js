const { AppError } = require('../lib/errors')

function createFleetService({ repository, imageStore, logger }) {
  return {
    listVehicles(query) {
      return repository.listVehicles(query)
    },

    async getVehicle(id) {
      const vehicle = await repository.findVehicleById(id)
      if (!vehicle) throw new AppError(404, 'NOT_FOUND', 'Vehicle was not found')
      return vehicle
    },

    createVehicle(input) {
      return repository.createVehicle(input)
    },

    async updateVehicle(id, patch) {
      const vehicle = await repository.updateVehicle(id, patch)
      if (!vehicle) throw new AppError(404, 'NOT_FOUND', 'Vehicle was not found')
      return vehicle
    },

    async uploadVehicleImage(id, file) {
      const uploaded = await imageStore.uploadVehicleImage(file)
      let updated
      try {
        updated = await repository.updateVehicleImage(id, uploaded)
        if (!updated) throw new AppError(404, 'NOT_FOUND', 'Vehicle was not found')
      } catch (error) {
        try {
          await imageStore.deleteImage(uploaded.publicId)
        } catch (cleanupError) {
          logger.error({ errorType: cleanupError?.name ?? 'UnknownError', vehicleId: id }, 'failed to clean up an unlinked vehicle image')
        }
        throw error
      }

      if (updated.previousPublicId && updated.previousPublicId !== uploaded.publicId) {
        try {
          await imageStore.deleteImage(updated.previousPublicId)
        } catch (error) {
          logger.warn({ errorType: error?.name ?? 'UnknownError', vehicleId: id }, 'failed to remove replaced vehicle image')
        }
      }
      return updated.vehicle
    },

    listMaintenanceWindows(query) {
      return repository.listMaintenanceWindows(query)
    },

    async createMaintenanceWindow(input, actorId) {
      return repository.createMaintenanceWindow(input, actorId)
    },

    async updateMaintenanceWindow(id, patch) {
      const window = await repository.updateMaintenanceWindow(id, patch)
      if (!window) throw new AppError(404, 'NOT_FOUND', 'Maintenance window was not found')
      return window
    },

    async deleteMaintenanceWindow(id) {
      if (!await repository.deleteMaintenanceWindow(id)) {
        throw new AppError(404, 'NOT_FOUND', 'Maintenance window was not found')
      }
      return { deleted: true }
    },
  }
}

module.exports = { createFleetService }
