/**
 * Shared HTTP transport for AI providers.
 */

const DEFAULT_TIMEOUT_MS = 60_000
const QUOTA_WINDOW_MS = 60_000

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function retryAfterMs(headerValue) {
	const seconds = parseInt(headerValue, 10)
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : QUOTA_WINDOW_MS
}

async function fetchWithTimeout(url, init, timeoutMs) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	try {
		return await fetch(url, { ...init, signal: controller.signal })
	} catch (e) {
		if (e.name === "AbortError" || e.name === "TimeoutError") {
			throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`)
		}
		throw e
	} finally {
		clearTimeout(timer)
	}
}

export async function postJson(url, {
	apiKey,
	body,
	headers = {},
	timeoutMs = DEFAULT_TIMEOUT_MS,
	retries = 3,
	sleep = defaultSleep
} = {}) {
	const init = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			...headers
		},
		body: JSON.stringify(body)
	}

	for (let attempt = 1; attempt <= retries; attempt++) {
		const res = await fetchWithTimeout(url, init, timeoutMs)

		if (res.status === 429) {
			const waitMs = retryAfterMs(res.headers.get("retry-after"))
			await res.text()
			if (attempt === retries) {
				throw new Error(`HTTP 429: rate limited after ${retries} attempts`)
			}
			await sleep(waitMs)
			continue
		}

		if (!res.ok) {
			const text = await res.text()
			throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`)
		}

		return await res.json()
	}
}
