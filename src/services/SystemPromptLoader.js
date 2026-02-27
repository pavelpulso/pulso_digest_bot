/**
 * Service for loading and caching system prompts from external sources.
 * Supports Google Docs, raw URLs, and other HTTP sources.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const FETCH_TIMEOUT_MS = 10000 // 10 seconds
const MAX_PROMPT_LENGTH = 5000 // Max prompt length

/**
 * Converts Google Docs URL to text export URL.
 */
function normalizeGoogleDocsUrl(url) {
  const docIdMatch = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/)
  if (docIdMatch) {
    const docId = docIdMatch[1]
    return `https://docs.google.com/document/d/${docId}/export?format=txt`
  }
  return url
}

/**
 * Fetches text from URL with timeout handling.
 */
async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "PulsoDigestBot/1.0"
      }
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const text = await response.text()
    return text.trim().slice(0, MAX_PROMPT_LENGTH)
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Fetches system prompt from URL.
 * @param {string} url - Source URL
 * @returns {Promise<string>} Fetched prompt text
 */
export async function fetchSystemPrompt(url) {
  if (!url || typeof url !== "string") {
    throw new Error("Invalid URL")
  }

  // Protocol check
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://")
  }

  // Normalize Google Docs URL
  const normalizedUrl = normalizeGoogleDocsUrl(url)

  const text = await fetchWithTimeout(normalizedUrl)

  if (!text || text.trim().length === 0) {
    throw new Error("Empty prompt content")
  }

  return text
}

/**
 * Checks if cache has expired.
 * @param {string|null} cachedAt - Cache date in ISO format
 * @returns {boolean} true if cache is stale
 */
function isCacheExpired(cachedAt) {
  if (!cachedAt) return true

  const cachedTime = new Date(cachedAt).getTime()
  const now = Date.now()
  return (now - cachedTime) > CACHE_TTL_MS
}

/**
 * Gets system prompt for user with caching.
 * @param {Object} user - User object from DB
 * @returns {Promise<string|null>} Prompt or null if unavailable
 */
export async function getUserSystemPrompt(user) {
  if (!user) return null

  const { system_prompt_url, system_prompt_cached, system_prompt_cached_at } = user

  // If URL is not set, return null
  if (!system_prompt_url) {
    return null
  }

  // If cache is valid, return it
  if (system_prompt_cached && !isCacheExpired(system_prompt_cached_at)) {
    return system_prompt_cached
  }

  // Cache is stale or missing — try to fetch
  try {
    const prompt = await fetchSystemPrompt(system_prompt_url)
    return prompt
  } catch (e) {
    console.warn(`[SystemPromptLoader] Failed to fetch prompt for user ${user.user_id}:`, e.message)
    // Fallback to old cache if available
    return system_prompt_cached || null
  }
}

/**
 * Forcefully refreshes system prompt cache.
 * @param {Object} user - User object from DB
 * @param {Function} updateCallback - DB update function (userId, prompt, url)
 * @returns {Promise<{success: boolean, prompt: string|null, error?: string}>}
 */
export async function refreshUserSystemPrompt(user, updateCallback) {
  if (!user || !user.system_prompt_url) {
    return { success: false, prompt: null, error: "No URL set" }
  }

  try {
    const prompt = await fetchSystemPrompt(user.system_prompt_url)
    await updateCallback(user.user_id, prompt, user.system_prompt_url)
    return { success: true, prompt }
  } catch (e) {
    console.error(`[SystemPromptLoader] Refresh failed for user ${user.user_id}:`, e.message)
    return { success: false, prompt: null, error: e.message }
  }
}

/**
 * Validates system prompt URL.
 * @param {string} url - URL to check
 * @returns {{valid: boolean, error?: string}}
 */
export function validateSystemPromptUrl(url) {
  if (!url || typeof url !== "string") {
    return { valid: false, error: "URL is required" }
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { valid: false, error: "URL must start with http:// or https://" }
  }

  // Google Docs URL check
  if (url.includes("docs.google.com")) {
    const docIdMatch = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/)
    if (!docIdMatch) {
      return { valid: false, error: "Invalid Google Docs URL" }
    }
  }

  return { valid: true }
}
