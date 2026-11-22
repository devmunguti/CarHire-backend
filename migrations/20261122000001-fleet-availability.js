module.exports = {
  async up(db) {
    await db.collection('vehicles').createIndex({ registrationKey: 1 }, { unique: true, name: 'uniq_vehicle_registration' })
    await db.collection('maintenancewindows').createIndex({ vehicleId: 1, startAt: 1, endAt: 1 }, { name: 'idx_maintenance_vehicle_interval' })
    await db.collection('bookings').createIndex({ reference: 1 }, { unique: true, name: 'uniq_booking_reference' })
    await db.collection('bookings').createIndex({ vehicleId: 1, pickupAt: 1, returnAt: 1, status: 1 }, { name: 'idx_booking_vehicle_interval' })
    await db.collection('bookings').createIndex({ customerId: 1 }, { name: 'idx_booking_customer' })
  },

  async down(db) {
    await db.collection('vehicles').dropIndex('uniq_vehicle_registration')
    await db.collection('maintenancewindows').dropIndex('idx_maintenance_vehicle_interval')
    await db.collection('bookings').dropIndex('uniq_booking_reference')
    await db.collection('bookings').dropIndex('idx_booking_vehicle_interval')
    await db.collection('bookings').dropIndex('idx_booking_customer')
  },
}
