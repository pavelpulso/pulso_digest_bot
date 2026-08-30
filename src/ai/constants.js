/**
 * Constants for AI module.
 */

/**
 * Text length limits for different tasks.
 */
export const LIMITS = {
  /** Max post text length for ranking — relevance is decided by the opening, not the full post */
  RANK_TEXT: 500,
  /** Total token budget per ranking request — prompt AND reserved completion, which
   *  providers bill together against the per-minute limit */
  RANK_BATCH_TOKENS: 5000,
  /** Max words in a ranking reason — the reserve below is derived from this */
  RANK_REASON_WORDS: 8,
  /** Completion tokens one scored post needs: id, score, an 8-word Cyrillic reason and a 1-2 word topic */
  COMPLETION_TOKENS_PER_POST: 135,
  /** Cyrillic costs ~2.5 chars per token; English ~4. Assume the expensive case. */
  CHARS_PER_TOKEN: 2.5,
  /** Max post text length for summary */
  SUMMARY_TEXT: 1500,
  /** Max text length for channel analysis */
  ANALYZE_TEXT: 1000,
  /** Max text length for audit */
  AUDIT_TEXT: 500,
  /** Completion tokens one digest block needs (non-compact: essence + potential + action).
   *  Floor from the prompt caps: essence <=14 words, potential <=10, action <=10 → 34 words.
   *  34 words * 15 chars/word (same conservative ratio as the SUMMARY_WORDS truncation
   *  below) + ~90 chars of JSON structure = 600 chars / 2.5 chars-per-token = 240 tokens.
   *  But the caps are a request, not a guarantee: OpenRouter was observed truncated at
   *  ~350 tokens/block for a 3-block reply (and that was the CUT-OFF length, so the real
   *  intent was longer), and a Gemini block came back with a 17-word essence against the
   *  14-word cap. Reasoning models (Gemini's `reasoning_effort`, Groq's gpt-oss-120b,
   *  OpenRouter's nemotron-3-super-120b) also spend part of this same ceiling on chain-of-
   *  thought before the visible answer, which the 240 floor above doesn't budget for at all.
   *  So set this from observed production behaviour with headroom, not the tight floor —
   *  700 is the number already proven to stop Gemini's truncation. */
  COMPLETION_TOKENS_PER_BLOCK: 700,
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
