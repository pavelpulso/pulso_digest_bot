/**
 * Shared HTTP transport for AI providers.
 */

const DEFAULT_TIMEOUT_MS = 60_000
const QUOTA_WINDOW_MS = 60_000
const BACKOFF_BASE_MS = 1_000

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

		// A 5xx is the provider being momentarily unavailable, not a bad request: Gemini
		// answers a demand spike with 503 "try again later", and without a retry that one
		// spike burned all three providers (each cooled down) and killed the whole digest.
		if (!res.ok) {
			const text = await res.text()
			if (res.status >= 500 && attempt < retries) {
				await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1))
				continue
			}
			throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`)
		}

		const data = await res.json()

		// OpenRouter reports an upstream failure with HTTP 200 and an error payload, so the
		// status code alone cannot be trusted. Left unread, such a body reached the providers
		// as a missing `choices` field and was reported as "empty response" — hiding both the
		// real cause and, when the upstream was merely overloaded, the fact it was retryable.
		const status = Number(data?.error?.code)
		if (data?.error) {
			const message = data.error.message || JSON.stringify(data.error)
			if (status >= 500 && attempt < retries) {
				await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1))
				continue
			}
			throw new Error(`HTTP ${Number.isFinite(status) ? status : res.status}: ${String(message).slice(0, 500)}`)
		}

		return data
	}
}
