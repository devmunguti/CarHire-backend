module.exports = {
  async up(db) {
    await db.collection('users').createIndex({ email: 1 }, { unique: true, name: 'uniq_users_email' })
    await db.collection('users').createIndex(
      { bootstrapOwner: 1 },
      { unique: true, partialFilterExpression: { bootstrapOwner: true }, name: 'uniq_initial_owner' },
    )
    await db.collection('refreshsessions').createIndex({ userId: 1 }, { name: 'idx_refresh_sessions_user' })
    await db.collection('refreshsessions').createIndex({ refreshTokenHash: 1 }, { unique: true, name: 'uniq_refresh_token_hash' })
    await db.collection('refreshsessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_refresh_session_expiry' })
    await db.collection('staffinvitations').createIndex({ email: 1 }, { name: 'idx_staff_invitations_email' })
    await db.collection('staffinvitations').createIndex({ tokenHash: 1 }, { unique: true, name: 'uniq_invitation_token_hash' })
    await db.collection('passwordresets').createIndex({ userId: 1 }, { name: 'idx_password_resets_user' })
    await db.collection('passwordresets').createIndex({ tokenHash: 1 }, { unique: true, name: 'uniq_password_reset_token_hash' })
    await db.collection('passwordresets').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_password_reset_expiry' })
  },

  async down(db) {
    await db.collection('users').dropIndex('uniq_users_email')
    await db.collection('users').dropIndex('uniq_initial_owner')
    await db.collection('refreshsessions').dropIndex('idx_refresh_sessions_user')
    await db.collection('refreshsessions').dropIndex('uniq_refresh_token_hash')
    await db.collection('refreshsessions').dropIndex('ttl_refresh_session_expiry')
    await db.collection('staffinvitations').dropIndex('idx_staff_invitations_email')
    await db.collection('staffinvitations').dropIndex('uniq_invitation_token_hash')
    await db.collection('passwordresets').dropIndex('idx_password_resets_user')
    await db.collection('passwordresets').dropIndex('uniq_password_reset_token_hash')
    await db.collection('passwordresets').dropIndex('ttl_password_reset_expiry')
  },
}
