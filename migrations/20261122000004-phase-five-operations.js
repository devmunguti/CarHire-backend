module.exports = {
  async up(db) {
    await db.collection('users').createIndex(
      { role: 1, name: 1, _id: 1 },
      { name: 'idx_driver_roster' },
    )
    await db.collection('bookings').createIndex(
      { driverId: 1, pickupAt: 1, _id: 1 },
      { name: 'idx_booking_driver_pickup' },
    )
    await db.collection('mechanics').createIndex(
      { location: '2dsphere' },
      { name: 'idx_mechanic_location' },
    )
    await db.collection('mechanics').createIndex(
      { active: 1, name: 1, _id: 1 },
      { name: 'idx_mechanic_directory' },
    )
    await db.collection('incidents').createIndex(
      { reference: 1 },
      { unique: true, name: 'uniq_incident_reference' },
    )
    await db.collection('incidents').createIndex(
      { status: 1, createdAt: -1, _id: -1 },
      { name: 'idx_incident_status_created' },
    )
    await db.collection('incidents').createIndex(
      { 'dispatch.vehicleId': 1, status: 1 },
      { name: 'idx_incident_dispatch_vehicle' },
    )
  },

  async down(db) {
    await db.collection('users').dropIndex('idx_driver_roster')
    await db.collection('bookings').dropIndex('idx_booking_driver_pickup')
    await db.collection('mechanics').dropIndex('idx_mechanic_location')
    await db.collection('mechanics').dropIndex('idx_mechanic_directory')
    await db.collection('incidents').dropIndex('uniq_incident_reference')
    await db.collection('incidents').dropIndex('idx_incident_status_created')
    await db.collection('incidents').dropIndex('idx_incident_dispatch_vehicle')
  },
}
