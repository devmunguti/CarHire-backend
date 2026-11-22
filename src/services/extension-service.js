const { calculateQuote } = require('./booking-service')

function createExtensionService({ repository }) {
  function quoteForExtension(booking, vehicle, extension) {
    const extras = (booking.pricingSnapshot?.extras ?? []).map((item) => item.code)
    return calculateQuote({
      pickupAt: booking.pickupAt,
      returnAt: extension.requestedReturnAt,
      mode: booking.mode,
      driverLocation: booking.pricingSnapshot?.driverLocation,
      extras,
    }, vehicle.ratePerDay)
  }

  return {
    requestGuestExtension(reference, sessionToken, input, now) {
      return repository.createGuestRequest(reference, sessionToken, input, quoteForExtension, now)
    },

    listRequests(query) {
      return repository.listRequests(query)
    },

    reviewRequest(id, input, actor, now) {
      return repository.reviewRequest(id, input, actor, now)
    },
  }
}

module.exports = { createExtensionService }
