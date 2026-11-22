const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const NON_MUTATING_POSTS = new Set(['/api/v1/quotes/calculate'])

function isNonMutatingPost(path) {
  return NON_MUTATING_POSTS.has(path) || /^\/api\/v1\/bookings\/[^/]+\/check-in\/settlement$/.test(path)
}

function createMutationAuditMiddleware({ auditRepository }) {
  return (req, res, next) => {
    const path = req.path
    if (!MUTATION_METHODS.has(req.method) || (req.method === 'POST' && isNonMutatingPost(path))) return next()

    const sendJson = res.json.bind(res)
    let auditAttempted = false
    res.json = (body) => {
      if (auditAttempted || !body?.success || res.statusCode < 200 || res.statusCode >= 300) {
        return sendJson(body)
      }
      auditAttempted = true
      const routePath = req.route?.path ?? path
      const operationPath = `${req.baseUrl ?? ''}${routePath}`.replace(/\/+/g, '/')
      const resource = operationPath.split('/').filter(Boolean).filter((part) => part !== 'api' && part !== 'v1')[0] ?? 'request'
      const entityId = Object.values(req.params ?? {}).find((value) => /^[a-f\d]{24}$/i.test(String(value)))
        ?? (typeof body.data?.id === 'string' && /^[a-f\d]{24}$/i.test(body.data.id) ? body.data.id : undefined)
      const actorId = req.user?.id ?? (req.user?._id ? String(req.user._id) : undefined)
      const actor = req.user?.name
        ? `${req.user.name} (${req.user.role})`
        : req.path.startsWith('/webhooks/') ? 'PayHero callback' : 'System'

      auditRepository.record({
        ...(actorId ? { actorId } : {}),
        actor,
        action: `${req.method} ${operationPath}`,
        entity: entityId ? `${resource}:${entityId}` : resource,
        ...(req.id ? { requestId: String(req.id) } : {}),
      }).then(() => sendJson(body)).catch((error) => next(error))
      return res
    }
    next()
  }
}

module.exports = { createMutationAuditMiddleware }
