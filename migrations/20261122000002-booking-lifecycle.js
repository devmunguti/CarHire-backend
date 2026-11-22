module.exports = {
  async up(db) {
    await db.collection('bookings').createIndex(
      { status: 1, holdExpiresAt: 1 },
      { name: 'idx_booking_hold_expiry' },
    )
    await db.collection('bookings').createIndex(
      { createdById: 1, idempotencyKey: 1 },
      {
        unique: true,
        name: 'uniq_booking_actor_idempotency',
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      },
    )
    await db.collection('bookings').createIndex(
      { status: 1, pickupAt: 1, _id: 1 },
      { name: 'idx_booking_status_pickup' },
    )
    await db.collection('bookings').createIndex(
      { createdAt: -1, _id: -1 },
      { name: 'idx_booking_created_desc' },
    )
  },

  async down(db) {
    await db.collection('bookings').dropIndex('idx_booking_hold_expiry')
    await db.collection('bookings').dropIndex('uniq_booking_actor_idempotency')
    await db.collection('bookings').dropIndex('idx_booking_status_pickup')
    await db.collection('bookings').dropIndex('idx_booking_created_desc')
  },
}
