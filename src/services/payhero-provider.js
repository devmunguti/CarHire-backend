const { AppError } = require('../lib/errors')

const PAYHERO_API_BASE_URL = 'https://backend.payhero.co.ke'

function providerError(message = 'PayHero payment service is unavailable') {
  return new AppError(502, 'PAYMENT_PROVIDER_ERROR', message)
}

function createPayHeroProvider(config, fetchImpl = globalThis.fetch) {
  const configured = Boolean(
    config.PAYHERO_USERNAME
    && config.PAYHERO_PASSWORD
    && config.PAYHERO_CHANNEL_ID
    && config.PAYHERO_CALLBACK_URL,
  )

  async function request(url, init) {
    let response
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.PAYHERO_USERNAME}:${config.PAYHERO_PASSWORD}`).toString('base64')}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
      })
    } catch (error) {
      throw providerError(error.name === 'TimeoutError' ? 'PayHero request timed out' : undefined)
    }
    let body
    try {
      body = await response.json()
    } catch {
      throw providerError('PayHero returned an invalid response')
    }
    if (!response.ok) throw providerError('PayHero rejected the payment request')
    return body
  }

  return {
    configured,

    async initiate({ amountKes, phone, externalReference, customerName }) {
      if (!configured) {
        throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'PayHero credentials and callback URL are not configured')
      }
      const body = await request(`${config.PAYHERO_API_BASE_URL || PAYHERO_API_BASE_URL}/api/v2/payments`, {
        method: 'POST',
        body: JSON.stringify({
          amount: amountKes,
          phone_number: phone,
          channel_id: Number(config.PAYHERO_CHANNEL_ID),
          provider: 'm-pesa',
          external_reference: externalReference,
          customer_name: customerName,
          callback_url: config.PAYHERO_CALLBACK_URL,
        }),
      })
      if (body.success !== true || typeof body.reference !== 'string' || !body.reference
        || typeof body.CheckoutRequestID !== 'string' || !body.CheckoutRequestID) {
        throw providerError('PayHero did not return a valid payment reference')
      }
      return {
        reference: body.reference,
        checkoutRequestId: body.CheckoutRequestID,
        status: String(body.status || 'QUEUED').toUpperCase(),
      }
    },

    async getStatus(reference) {
      if (!configured) {
        throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'PayHero credentials are not configured')
      }
      const url = new URL(`${config.PAYHERO_API_BASE_URL || PAYHERO_API_BASE_URL}/api/v2/transaction-status`)
      url.searchParams.set('reference', reference)
      const body = await request(url, { method: 'GET' })
      if (typeof body.status !== 'string' || typeof body.reference !== 'string') {
        throw providerError('PayHero returned an invalid transaction status')
      }
      return {
        status: body.status.toUpperCase(),
        reference: body.reference,
        checkoutRequestId: body.CheckoutRequestID || undefined,
        providerReference: body.provider_reference || body.third_party_reference || undefined,
        amountKes: Number.isSafeInteger(body.amount ?? body.Amount) ? (body.amount ?? body.Amount) : undefined,
      }
    },
  }
}

function createStubPaymentProvider() {
  const transactions = new Map()
  return {
    configured: true,
    transactions,
    async initiate({ amountKes, externalReference }) {
      const reference = `stub-${externalReference}`
      const checkoutRequestId = `checkout-${externalReference}`
      transactions.set(reference, { status: 'QUEUED', reference, checkoutRequestId, amountKes })
      return { reference, checkoutRequestId, status: 'QUEUED' }
    },
    async getStatus(reference) {
      const transaction = transactions.get(reference)
      if (!transaction) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Provider transaction was not found')
      return { ...transaction }
    },
    setStatus(reference, status) {
      const transaction = transactions.get(reference)
      if (!transaction) throw new Error('Stub transaction was not found')
      transaction.status = status.toUpperCase()
      return transaction
    },
  }
}

module.exports = { createPayHeroProvider, createStubPaymentProvider, PAYHERO_API_BASE_URL }
