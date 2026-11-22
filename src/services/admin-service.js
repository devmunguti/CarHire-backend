function createAdminService({ repository, auditRepository }) {
  return {
    getDashboard() {
      return repository.dashboard()
    },

    getNotificationCounts(actor) {
      return repository.notificationCounts(actor)
    },

    search(query) {
      return repository.search(query)
    },

    listPendingApprovals(query, actorId) {
      return repository.listPendingApprovals(query, actorId)
    },

    listAuditEntries(query) {
      return auditRepository.list(query)
    },
  }
}

module.exports = { createAdminService }
