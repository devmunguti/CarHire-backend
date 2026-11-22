const bcrypt = require('bcryptjs')
const { AppError, forbidden } = require('../lib/errors')
const { toPublicUser } = require('./auth-service')
const { createOpaqueToken, hashToken } = require('./tokens')

const INVITATION_TTL_MS = 72 * 60 * 60 * 1000
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000
const PASSWORD_HASH_ROUNDS = 12

function idOf(record) {
  return String(record._id ?? record.id)
}

function invitationLink(frontendBaseUrl, token) {
  const link = new URL('/accept-invitation', frontendBaseUrl)
  link.searchParams.set('token', token)
  return link.toString()
}

function passwordResetLink(frontendBaseUrl, token) {
  const link = new URL('/reset-password', frontendBaseUrl)
  link.searchParams.set('token', token)
  return link.toString()
}

function invitationError() {
  return new AppError(400, 'INVALID_INVITATION', 'Invitation is invalid or has already been used')
}

function resetError() {
  return new AppError(400, 'INVALID_RESET_TOKEN', 'Password reset token is invalid or expired')
}

function createAccountService({ repository, mailer, logger, frontendBaseUrl, now = () => new Date() }) {
  async function createInvitation(actor, input) {
    if (actor.role === 'manager' && input.role === 'owner') throw forbidden('Managers cannot invite owner accounts')
    const email = input.email.toLowerCase()
    if (await repository.findUserByEmail(email) || await repository.findPendingInvitationByEmail(email, now())) {
      throw new AppError(409, 'DUPLICATE_EMAIL', 'An account or active invitation already uses this email')
    }

    const rawToken = createOpaqueToken()
    const expiresAt = new Date(now().getTime() + INVITATION_TTL_MS)
    const invitation = await repository.createInvitation({
      ...input,
      email,
      tokenHash: hashToken(rawToken),
      createdById: actor.id,
      expiresAt,
      acceptedAt: null,
      revokedAt: null,
    })

    try {
      await mailer.sendInvitation({ to: email, name: input.name, role: input.role, link: invitationLink(frontendBaseUrl, rawToken) })
    } catch (error) {
      await repository.revokeInvitation(idOf(invitation), now())
      throw error
    }

    return { id: idOf(invitation), email, role: input.role, expiresAt: expiresAt.toISOString() }
  }

  async function resendInvitation(invitationId) {
    const existing = await repository.findInvitationById(invitationId)
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Invitation was not found')
    if (existing.acceptedAt || existing.revokedAt) {
      throw new AppError(409, 'INVITATION_ACCEPTED', 'Invitation is no longer available to resend')
    }
    if (new Date(existing.expiresAt) <= now()) {
      throw new AppError(409, 'INVITATION_EXPIRED', 'Invitation has expired')
    }

    const token = createOpaqueToken()
    const currentTime = now()
    const expiresAt = new Date(currentTime.getTime() + INVITATION_TTL_MS)
    const updated = await repository.replaceInvitationToken({
      id: invitationId,
      tokenHash: hashToken(token),
      expiresAt,
      now: currentTime,
    })
    if (!updated) throw new AppError(409, 'INVITATION_ACCEPTED', 'Invitation is no longer available to resend')

    try {
      await mailer.sendInvitation({
        to: updated.email,
        name: updated.name,
        role: updated.role,
        link: invitationLink(frontendBaseUrl, token),
      })
    } catch (error) {
      await repository.revokeInvitation(invitationId, now())
      throw error
    }

    return { id: idOf(updated), email: updated.email, role: updated.role, expiresAt: expiresAt.toISOString() }
  }

  async function revokeInvitation(invitationId) {
    const existing = await repository.findInvitationById(invitationId)
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Invitation was not found')
    if (existing.acceptedAt || existing.revokedAt) {
      throw new AppError(409, 'INVITATION_ACCEPTED', 'Invitation is already accepted or revoked')
    }
    const result = await repository.revokeInvitation(invitationId, now())
    if (result.matchedCount === 0) throw new AppError(409, 'INVITATION_ACCEPTED', 'Invitation is already accepted or revoked')
  }

  async function listStaff(query, actor) {
    const result = await repository.listStaff({
      ...query,
      excludeOwners: actor.role === 'manager',
    })
    return {
      ...result,
      items: result.items.map((user) => toPublicUser(user)),
    }
  }

  async function updateStaff(staffId, patch, actor) {
    const existing = await repository.findUserById(staffId)
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Staff account was not found')
    if (actor.id === staffId && (patch.role !== undefined || patch.active === false)) {
      throw forbidden('You cannot change your own role or deactivate your own account')
    }
    if (actor.role === 'manager' && (existing.role === 'owner' || patch.role === 'owner')) {
      throw forbidden('Managers cannot change owner accounts or assign the owner role')
    }
    if (patch.role === 'driver' && existing.role !== 'driver' && !existing.driverProfile) {
      throw new AppError(409, 'DRIVER_PROFILE_REQUIRED', 'Driver qualifications are required before assigning the driver role')
    }
    const updated = await repository.updateStaff(staffId, patch, actor)
    if (!updated) throw new AppError(404, 'NOT_FOUND', 'Staff account was not found')
    return toPublicUser(updated)
  }

  async function acceptInvitation({ token, password }) {
    const tokenHash = hashToken(token)
    const invitation = await repository.findInvitationByTokenHash(tokenHash)
    if (!invitation) throw invitationError()
    if (new Date(invitation.expiresAt) <= now()) {
      throw new AppError(400, 'INVITATION_EXPIRED', 'Invitation has expired')
    }
    if (await repository.findUserByEmail(invitation.email)) {
      throw new AppError(409, 'DUPLICATE_EMAIL', 'An account already uses this email')
    }

    const currentTime = now()
    const claimed = await repository.acceptInvitation({ id: idOf(invitation), tokenHash, now: currentTime })
    if (!claimed) throw invitationError()

    try {
      const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS)
      const user = await repository.createUser({
        name: invitation.name,
        email: invitation.email,
        phone: invitation.phone,
        role: invitation.role,
        branch: invitation.branch,
        ...(invitation.driverProfile ? { driverProfile: invitation.driverProfile } : {}),
        passwordHash,
        active: true,
      })
      return {
        id: idOf(user),
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        branch: user.branch,
        active: user.active,
      }
    } catch (error) {
      await repository.reopenInvitation({ id: idOf(invitation), acceptedAt: currentTime })
      throw error
    }
  }

  async function requestPasswordReset(email) {
    const user = await repository.findUserByEmail(email.toLowerCase())
    if (!user || !user.active) return

    const currentTime = now()
    const token = createOpaqueToken()
    await repository.revokePasswordResetsForUser(idOf(user), currentTime)
    await repository.createPasswordReset({
      userId: idOf(user),
      tokenHash: hashToken(token),
      expiresAt: new Date(currentTime.getTime() + PASSWORD_RESET_TTL_MS),
      usedAt: null,
    })
    try {
      await mailer.sendPasswordReset({
        to: user.email,
        name: user.name,
        link: passwordResetLink(frontendBaseUrl, token),
      })
    } catch (error) {
      logger.error({ err: error, userId: idOf(user) }, 'password reset email delivery failed')
    }
  }

  async function confirmPasswordReset({ token, password }) {
    const tokenHash = hashToken(token)
    const reset = await repository.findPasswordResetByTokenHash(tokenHash)
    if (!reset || new Date(reset.expiresAt) <= now()) throw resetError()

    const currentTime = now()
    const claimed = await repository.consumePasswordReset({ id: idOf(reset), tokenHash, now: currentTime })
    if (!claimed) throw resetError()

    try {
      const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS)
      await repository.updatePassword(reset.userId, passwordHash)
      await repository.revokeSessionsForUser(reset.userId, currentTime)
      await repository.revokePasswordResetsForUser(reset.userId, currentTime)
    } catch (error) {
      await repository.reopenPasswordReset({ id: idOf(reset), usedAt: currentTime })
      throw error
    }
  }

  return {
    createInvitation,
    resendInvitation,
    revokeInvitation,
    acceptInvitation,
    requestPasswordReset,
    confirmPasswordReset,
    listStaff,
    updateStaff,
  }
}

module.exports = { createAccountService, INVITATION_TTL_MS, PASSWORD_RESET_TTL_MS }
