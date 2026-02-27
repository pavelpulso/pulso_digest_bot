/**
 * Константы для AI-модуля.
 */

/**
 * Лимиты на размер текста для разных задач.
 */
export const LIMITS = {
  /** Макс. длина текста поста для ранжирования */
  RANK_TEXT: 2000,
  /** Макс. длина текста поста для саммари */
  SUMMARY_TEXT: 1500,
  /** Макс. длина текста для анализа канала */
  ANALYZE_TEXT: 1000,
  /** Макс. длина текста для аудита */
  AUDIT_TEXT: 500,
  /** Макс. количество блоков в дайджесте */
  MAX_BLOCKS: 20,
  /** Мин. количество блоков в дайджесте */
  MIN_BLOCKS: 3,
  /** Макс. длина teaser (слов) */
  TEASER_WORDS: 12,
  /** Макс. длина summary (слов) */
  SUMMARY_WORDS: 20,
  /** Макс. длина аргумента (слов) */
  ARGUMENT_WORDS: 15,
  /** Макс. длина reason для канала (слов) */
  CHANNEL_REASON_WORDS: 10,
  /** Макс. количество каналов для рекомендации */
  MAX_RECOMMENDATIONS: 5,
  /** Макс. количество каналов для анализа */
  MAX_CHANNELS_ANALYZE: 100,
  /** Макс. количество постов для анализа канала */
  MAX_POSTS_ANALYZE: 15
}

/**
 * Ключи JSON, которые могут содержать массив результатов.
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
 * Допустимые вердикты для анализа канала.
 */
export const VERDICTS = ["keep", "mute", "unsubscribe"]

/**
 * Макс. количество повторных попыток при 429 ошибке.
 */
export const MAX_RETRIES = 3

/**
 * Задержка между попытками (мс) — будет умножена на номер попытки.
 */
export const RETRY_DELAY_MS = 1000
