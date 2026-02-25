export class BotCache {
	constructor() {
		this.blockCache = new Map()
		this.auditWeakCache = new Map()
	}

	setBlock(postId, data) {
		this.blockCache.set(postId, data)
	}

	getBlock(postId) {
		return this.blockCache.get(postId)
	}

	setAuditWeak(userId, channels) {
		this.auditWeakCache.set(userId, channels)
	}

	getAuditWeak(userId) {
		return this.auditWeakCache.get(userId)
	}

	deleteAuditWeak(userId) {
		this.auditWeakCache.delete(userId)
	}
}
