module.exports = {
  async up(db) {
    await db.collection('bookings').createIndex(
      { guestHoldKey: 1 },
      {
        unique: true,
        sparse: true,
        name: 'uniq_booking_guest_hold_key',
      },
    )
    await db.collection('bookingextensions').createIndex(
      { bookingId: 1, status: 1 },
      {
        unique: true,
        partialFilterExpression: { status: 'pending' },
        name: 'uniq_pending_booking_extension',
      },
    )
    await db.collection('bookingextensions').createIndex(
      { status: 1, createdAt: -1, _id: -1 },
      { name: 'idx_extension_status_created' },
    )
  },

  async down(db) {
    await db.collection('bookingextensions').dropIndex('uniq_pending_booking_extension')
    await db.collection('bookingextensions').dropIndex('idx_extension_status_created')
    await db.collection('bookings').dropIndex('uniq_booking_guest_hold_key')
  },
}
