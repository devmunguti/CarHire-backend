module.exports = {
  async up(db) {
    await db.collection('auditentries').createIndex(
      { createdAt: -1, _id: -1 },
      { name: 'idx_audit_created' },
    )
    await db.collection('auditentries').createIndex(
      { actorId: 1, createdAt: -1, _id: -1 },
      { name: 'idx_audit_actor_created' },
    )
    await db.collection('auditentries').createIndex(
      { entity: 1, createdAt: -1, _id: -1 },
      { name: 'idx_audit_entity_created' },
    )
    await db.collection('adminlocks').updateOne(
      { _id: 'owner-account-guard' },
      { $setOnInsert: { revision: 0 } },
      { upsert: true },
    )
  },

  async down(db) {
    await db.collection('auditentries').dropIndex('idx_audit_created')
    await db.collection('auditentries').dropIndex('idx_audit_actor_created')
    await db.collection('auditentries').dropIndex('idx_audit_entity_created')
    await db.collection('adminlocks').deleteOne({ _id: 'owner-account-guard' })
  },
}
