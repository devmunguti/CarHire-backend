const { AppError } = require('../lib/errors')

const extraPrices = Object.freeze({
  baby_seat: { label: 'Baby seat', amountKes: 500, perDay: true },
  rooftop_tent: { label: 'Rooftop tent', amountKes: 1800, perDay: true },
  cooler_box: { label: 'Cooler box', amountKes: 700, perDay: true },
  airport_pickup: { label: 'Airport pickup', amountKes: 2500, perDay: false },
})

function calculateQuote(request, ratePerDay) {
  const durationMs = new Date(request.returnAt).getTime() - new Date(request.pickupAt).getTime()
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new AppError(400, 'INVALID_DATE_RANGE', 'Return time must be after pickup time')
  }
  const baseDays = Math.max(1, Math.ceil(durationMs / 86_400_000))
  const baseAmountKes = ratePerDay * baseDays
  const driverLocation = request.driverLocation ?? 'in_town'
  const chauffeurFeeKes = request.mode === 'chauffeur'
    ? (driverLocation === 'upcountry' ? 6500 : 3500) * baseDays
    : 0
  const extras = request.extras.map((code) => {
    const item = extraPrices[code]
    if (!item) throw new AppError(400, 'VALIDATION_ERROR', `Unsupported extra: ${code}`)
    return { code, label: item.label, amountKes: item.amountKes * (item.perDay ? baseDays : 1) }
  })
  const taxable = baseAmountKes + chauffeurFeeKes + extras.reduce((sum, item) => sum + item.amountKes, 0)
  const vatAmountKes = Math.round(taxable * 0.16)
  return {
    currency: 'KES',
    pricingSnapshot: {
      baseDays,
      baseRateKes: ratePerDay,
      baseAmountKes,
      chauffeurFeeKes,
      driverLocation,
      extras,
      vatRate: 16,
      vatAmountKes,
      totalDueKes: taxable + vatAmountKes,
      refundableDepositKes: 15000,
    },
  }
}

function validateBookingDates(request, now) {
  const pickupAt = new Date(request.pickupAt)
  const returnAt = new Date(request.returnAt)
  if (!Number.isFinite(pickupAt.getTime()) || !Number.isFinite(returnAt.getTime())
    || pickupAt <= now || returnAt <= pickupAt) {
    throw new AppError(400, 'INVALID_DATE_RANGE', 'Pickup must be in the future and return must follow pickup')
  }
}

function createBookingService({ repository }) {
  return {
    async calculateQuote(request, now = new Date()) {
      validateBookingDates(request, now)
      const vehicle = await repository.findVehicleById(request.vehicleId)
      if (!vehicle) throw new AppError(404, 'NOT_FOUND', 'Vehicle was not found')
      const available = await repository.isVehicleAvailableForPeriod(
        request.vehicleId,
        new Date(request.pickupAt),
        new Date(request.returnAt),
        now,
      )
      if (!available) {
        throw new AppError(409, 'VEHICLE_UNAVAILABLE', 'This vehicle is not available for those dates')
      }
      return calculateQuote(request, vehicle.ratePerDay)
    },

    createBooking(request, actor, idempotencyKey, now = new Date()) {
      validateBookingDates(request, now)
      return repository.createBooking(
        request,
        actor,
        (vehicle) => calculateQuote(request, vehicle.ratePerDay),
        idempotencyKey,
      )
    },

    listBookings(query) {
      return repository.listBookings(query)
    },

    async getBooking(id, actor) {
      const booking = await repository.findBookingById(id, actor)
      if (!booking) throw new AppError(404, 'NOT_FOUND', 'Booking was not found')
      return booking
    },

    approveOfflinePayment(id, input, actor) {
      return repository.approveOfflinePayment(id, input, actor)
    },

    cancelBooking(id, reason, actor) {
      return repository.cancelBooking(id, reason, actor)
    },
  }
}

module.exports = { createBookingService, calculateQuote }
