/**
 * Constants for AI module.
 */

/**
 * Text length limits for different tasks.
 */
export const LIMITS = {
  /** Max post text length for ranking — relevance is decided by the opening, not the full post */
  RANK_TEXT: 500,
  /** Token budget for a single ranking request, kept under the 8000 TPM free tier */
  RANK_BATCH_TOKENS: 5000,
  /** Cyrillic costs ~2.5 chars per token; English ~4. Assume the expensive case. */
  CHARS_PER_TOKEN: 2.5,
  /** Max post text length for summary */
  SUMMARY_TEXT: 1500,
  /** Max text length for channel analysis */
  ANALYZE_TEXT: 1000,
  /** Max text length for audit */
  AUDIT_TEXT: 500,
  /** Max blocks in digest */
  MAX_BLOCKS: 20,
  /** Min blocks in digest */
  MIN_BLOCKS: 3,
  /** Max teaser length (words) */
  TEASER_WORDS: 12,
  /** Max summary length (words) */
  SUMMARY_WORDS: 20,
  /** Max argument length (words) */
  ARGUMENT_WORDS: 15,
  /** Max reason length for channel (words) */
  CHANNEL_REASON_WORDS: 10,
  /** Max channels for recommendation */
  MAX_RECOMMENDATIONS: 5,
  /** Max channels for analysis */
  MAX_CHANNELS_ANALYZE: 100,
  /** Max posts for channel analysis */
  MAX_POSTS_ANALYZE: 15
}

/**
 * JSON keys that may contain result array.
 */
export const JSON_ARRAY_KEYS = [
  "ranking",
  "posts",
  "items",
  "channels",
  "recommendations",
  "result"
]

/**
 * Valid verdicts for channel analysis.
 */
export const VERDICTS = ["keep", "mute", "unsubscribe"]

/**
 * Max retries for 429 error.
 */
export const MAX_RETRIES = 3

/**
 * Delay between retries (ms) — multiplied by attempt number.
 */
export const RETRY_DELAY_MS = 1000
