module.exports = {
  async up(db) {
    await db.collection('guestaccesses').createIndex(
      { exchangeTokenHash: 1 },
      { unique: true, sparse: true, name: 'uniq_guest_exchange_token' },
    )
    await db.collection('guestaccesses').createIndex(
      { sessionTokenHash: 1 },
      { unique: true, sparse: true, name: 'uniq_guest_session_token' },
    )
    await db.collection('guestaccesses').createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'ttl_guest_access_expiry' },
    )
    await db.collection('payments').createIndex(
      { paymentId: 1 },
      { unique: true, name: 'uniq_payment_public_id' },
    )
    await db.collection('payments').createIndex(
      { bookingId: 1, idempotencyKey: 1 },
      {
        unique: true,
        name: 'uniq_payment_idempotency',
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      },
    )
    await db.collection('payments').createIndex(
      { bookingId: 1, status: 1 },
      {
        unique: true,
        name: 'uniq_pending_payment_per_booking',
        partialFilterExpression: { status: 'pending' },
      },
    )
    await db.collection('paymentevents').createIndex(
      { providerEventId: 1 },
      { unique: true, name: 'uniq_provider_payment_event' },
    )
    await db.collection('refunds').createIndex(
      { refundId: 1 },
      { unique: true, name: 'uniq_refund_public_id' },
    )
    await db.collection('refunds').createIndex(
      { bookingId: 1, idempotencyKey: 1 },
      {
        unique: true,
        name: 'uniq_refund_idempotency',
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      },
    )
    await db.collection('bookings').createIndex(
      { 'licence.deleteAfter': 1 },
      { name: 'idx_licence_retention_expiry' },
    )
  },

  async down(db) {
    await db.collection('guestaccesses').dropIndex('uniq_guest_exchange_token')
    await db.collection('guestaccesses').dropIndex('uniq_guest_session_token')
    await db.collection('guestaccesses').dropIndex('ttl_guest_access_expiry')
    await db.collection('payments').dropIndex('uniq_payment_public_id')
    await db.collection('payments').dropIndex('uniq_payment_idempotency')
    await db.collection('payments').dropIndex('uniq_pending_payment_per_booking')
    await db.collection('paymentevents').dropIndex('uniq_provider_payment_event')
    await db.collection('refunds').dropIndex('uniq_refund_public_id')
    await db.collection('refunds').dropIndex('uniq_refund_idempotency')
    await db.collection('bookings').dropIndex('idx_licence_retention_expiry')
  },
}
