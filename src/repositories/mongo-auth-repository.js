const mongoose = require('mongoose')
const { User, RefreshSession, StaffInvitation, PasswordReset } = require('../models')
const { AppError, forbidden } = require('../lib/errors')

function publicQuery(query) {
  return query.lean()
}

const authRepository = {
  findUserByEmail(email, includePassword = false) {
    let query = User.findOne({ email })
    if (includePassword) query = query.select('+passwordHash')
    return publicQuery(query)
  },

  findUserById(id) {
    return publicQuery(User.findById(id))
  },

  updateCurrentUser(id, patch) {
    return publicQuery(User.findByIdAndUpdate(id, { $set: patch }, { returnDocument: 'after', runValidators: true }))
  },

  async listStaff({ limit, cursor, active, branch, excludeOwners }) {
    let position
    if (cursor) {
      try {
        position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        if (!position || typeof position.name !== 'string' || !mongoose.Types.ObjectId.isValid(position.id)) {
          throw new Error('Invalid staff cursor')
        }
      } catch {
        throw new AppError(400, 'INVALID_QUERY', 'Pagination cursor is invalid')
      }
    }
    const filter = {}
    if (typeof active === 'boolean') filter.active = active
    if (branch) filter.branch = branch
    if (excludeOwners) filter.role = { $ne: 'owner' }
    if (position) {
      filter.$or = [
        { name: { $gt: position.name } },
        { name: position.name, _id: { $gt: new mongoose.Types.ObjectId(position.id) } },
      ]
    }
    const rows = await User.find(filter)
      .sort({ name: 1, _id: 1 })
      .limit(limit + 1)
      .lean()
    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    const last = items[items.length - 1]
    return {
      items,
      nextCursor: hasMore
        ? Buffer.from(JSON.stringify({ name: last.name, id: String(last._id) })).toString('base64url')
        : null,
    }
  },

  async updateStaff(id, patch, actor) {
    const session = await mongoose.startSession()
    let updated
    try {
      await session.withTransaction(async () => {
        await mongoose.connection.collection('adminlocks').updateOne(
          { _id: 'owner-account-guard' },
          { $inc: { revision: 1 } },
          { session },
        )
        const current = await User.findById(id).session(session)
        if (!current) return
        if (actor.id === String(current._id) && (patch.role !== undefined || patch.active === false)) {
          throw forbidden('You cannot change your own role or deactivate your own account')
        }
        if (actor.role === 'manager' && (current.role === 'owner' || patch.role === 'owner')) {
          throw forbidden('Managers cannot change owner accounts or assign the owner role')
        }
        if (patch.role === 'driver' && current.role !== 'driver' && !current.driverProfile) {
          throw new AppError(409, 'DRIVER_PROFILE_REQUIRED', 'Driver qualifications are required before assigning the driver role')
        }
        if ((patch.active === false && current.active && current.role === 'owner')
          || (patch.role && patch.role !== 'owner' && current.role === 'owner')) {
          const ownerCount = await User.countDocuments({ role: 'owner', active: true }).session(session)
          if (ownerCount <= 1) throw new AppError(409, 'LAST_OWNER_REQUIRED', 'The last active owner cannot be deactivated or demoted')
        }
        current.set(patch)
        await current.save({ session })
        if (patch.active === false) {
          await RefreshSession.updateMany(
            { userId: current._id, revokedAt: null },
            { $set: { revokedAt: new Date() } },
            { session },
          )
        }
        updated = current.toObject()
      })
    } finally {
      await session.endSession()
    }
    return updated ?? null
  },

  createUser(user) {
    return User.create(user)
  },

  updateLastLogin(id, lastLoginAt) {
    return User.updateOne({ _id: id }, { $set: { lastLoginAt } })
  },

  createSession(session) {
    return RefreshSession.create(session)
  },

  findActiveSession(id, now) {
    return publicQuery(RefreshSession.findOne({ _id: id, revokedAt: null, expiresAt: { $gt: now } }))
  },

  findSessionByRefreshHash(refreshTokenHash) {
    return publicQuery(RefreshSession.findOne({ refreshTokenHash, revokedAt: null }))
  },

  rotateSession({ id, currentHash, nextHash, now }) {
    return publicQuery(RefreshSession.findOneAndUpdate(
      { _id: id, refreshTokenHash: currentHash, revokedAt: null, expiresAt: { $gt: now } },
      { $set: { refreshTokenHash: nextHash } },
      { returnDocument: 'after' },
    ))
  },

  revokeSessionByRefreshHash(refreshTokenHash, now) {
    return RefreshSession.updateOne({ refreshTokenHash, revokedAt: null }, { $set: { revokedAt: now } })
  },

  revokeSession(id, now) {
    return RefreshSession.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: now } })
  },

  revokeSessionsForUser(userId, now) {
    return RefreshSession.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now } })
  },

  createInvitation(invitation) {
    return StaffInvitation.create(invitation)
  },

  findPendingInvitationByEmail(email, now) {
    return publicQuery(StaffInvitation.findOne({
      email,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { $gt: now },
    }))
  },

  findInvitationByTokenHash(tokenHash) {
    return publicQuery(StaffInvitation.findOne({ tokenHash, acceptedAt: null, revokedAt: null }))
  },

  findInvitationById(id) {
    return publicQuery(StaffInvitation.findById(id))
  },

  replaceInvitationToken({ id, tokenHash, expiresAt, now }) {
    return publicQuery(StaffInvitation.findOneAndUpdate(
      { _id: id, acceptedAt: null, revokedAt: null },
      { $set: { tokenHash, expiresAt, updatedAt: now } },
      { returnDocument: 'after' },
    ))
  },

  acceptInvitation({ id, tokenHash, now }) {
    return publicQuery(StaffInvitation.findOneAndUpdate(
      { _id: id, tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { $gt: now } },
      { $set: { acceptedAt: now } },
      { returnDocument: 'after' },
    ))
  },

  revokeInvitation(id, now) {
    return StaffInvitation.updateOne(
      { _id: id, acceptedAt: null, revokedAt: null },
      { $set: { revokedAt: now } },
    )
  },

  reopenInvitation({ id, acceptedAt }) {
    return StaffInvitation.updateOne({ _id: id, acceptedAt }, { $set: { acceptedAt: null } })
  },

  revokePendingInvitations(email, now) {
    return StaffInvitation.updateMany(
      { email, acceptedAt: null, revokedAt: null },
      { $set: { revokedAt: now } },
    )
  },

  createPasswordReset(reset) {
    return PasswordReset.create(reset)
  },

  findPasswordResetByTokenHash(tokenHash) {
    return publicQuery(PasswordReset.findOne({ tokenHash, usedAt: null }))
  },

  consumePasswordReset({ id, tokenHash, now }) {
    return publicQuery(PasswordReset.findOneAndUpdate(
      { _id: id, tokenHash, usedAt: null, expiresAt: { $gt: now } },
      { $set: { usedAt: now } },
      { returnDocument: 'after' },
    ))
  },

  reopenPasswordReset({ id, usedAt }) {
    return PasswordReset.updateOne({ _id: id, usedAt }, { $set: { usedAt: null } })
  },

  revokePasswordResetsForUser(userId, now) {
    return PasswordReset.updateMany({ userId, usedAt: null }, { $set: { usedAt: now } })
  },

  updatePassword(userId, passwordHash) {
    return User.updateOne({ _id: userId }, { $set: { passwordHash } })
  },
}

module.exports = { authRepository }
