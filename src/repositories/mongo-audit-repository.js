const mongoose = require('mongoose')
const { AuditEntry } = require('../models')
const { AppError } = require('../lib/errors')

function encodeCursor(entry) {
  return Buffer.from(JSON.stringify({
    createdAt: entry.createdAt.toISOString(),
    id: String(entry._id),
  })).toString('base64url')
}

function decodeCursor(cursor) {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!value || !Number.isFinite(Date.parse(value.createdAt)) || !mongoose.Types.ObjectId.isValid(value.id)) {
      throw new Error('Invalid audit cursor')
    }
    return value
  } catch {
    throw new AppError(400, 'INVALID_QUERY', 'Pagination cursor is invalid')
  }
}

function auditView(entry) {
  const { _id, __v, ...fields } = typeof entry.toObject === 'function' ? entry.toObject() : entry
  return { id: String(_id), ...fields, createdAt: new Date(fields.createdAt).toISOString() }
}

function createMongoAuditRepository() {
  return {
    async record(entry) {
      const created = await AuditEntry.create(entry)
      return auditView(created)
    },

    async list({ limit, cursor, actorId, action, entity, from, to }) {
      const position = decodeCursor(cursor)
      const filter = {}
      if (actorId) filter.actorId = actorId
      if (action) filter.action = action
      if (entity) filter.entity = entity
      if (from || to) {
        filter.createdAt = {}
        if (from) filter.createdAt.$gte = from
        if (to) filter.createdAt.$lte = to
      }
      if (position) {
        const beforePosition = {
          createdAt: { $lt: new Date(position.createdAt) },
        }
        filter.$and = [
          { $or: [beforePosition, { createdAt: new Date(position.createdAt), _id: { $lt: new mongoose.Types.ObjectId(position.id) } }] },
        ]
      }

      const rows = await AuditEntry.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .lean()
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      return {
        items: page.map(auditView),
        nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      }
    },
  }
}

module.exports = { createMongoAuditRepository }
