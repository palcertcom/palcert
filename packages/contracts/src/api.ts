/** Current public API version prefix (§35). */
export const API_VERSION = 'v1' as const;
export const API_PREFIX = `/api/${API_VERSION}` as const;

/** Header carrying the request correlation ID across all PalCert services (§46, §48). */
export const REQUEST_ID_HEADER = 'x-request-id' as const;

/** Header used for idempotent, money-moving operations (§26, §27). */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key' as const;
