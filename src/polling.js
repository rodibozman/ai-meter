// Pure decisions of the polling loop (when to fetch, how to back off, what
// colour a percentage gets). No GNOME Shell import, so `gjs -m` can test it.

export const MAX_BACKOFF_SECONDS = 900;
// The usage endpoint allows only a handful of calls per few minutes per
// account, and Claude Code itself polls it: never fetch more often than this.
export const MIN_FETCH_GAP_MS = 30 * 1000;
// What a 429 without a usable Retry-After waits, and the least it can ask.
export const RATE_LIMIT_DEFAULT_SECONDS = 300;
export const RATE_LIMIT_MIN_SECONDS = 60;

/**
 * The state of the polling loop. It belongs to the extension, not to the
 * indicator, so that recreating the indicator (position change, lock
 * screen) keeps the last values, the minimum gap, a Retry-After and the
 * backoff: a burst of fetches would hit the rate limit shared with Claude
 * Code. `usage`/`plan`/`error`/`fetchedAt` describe the last fetch,
 * `lastAttempt`/`nextTry` are ms timestamps (0 = never), `backoff` seconds.
 */
export function newPollState() {
    return {usage: null, plan: '', error: null, fetchedAt: 0, lastAttempt: 0, nextTry: 0, backoff: 0};
}

/**
 * Seconds a fresh indicator waits before its first fetch: 0 without data,
 * otherwise what is left of the refresh interval since the last fetch.
 */
export function initialDelay(state, interval, now) {
    if (!state.usage)
        return 0;
    return Math.max(0, Math.ceil((state.fetchedAt + interval * 1000 - now) / 1000));
}

/** 'ok', 'warn' or 'crit' for a percentage and the two thresholds. */
export function severity(percent, warn, crit) {
    if (percent === null || percent === undefined)
        return 'ok';
    if (percent >= crit)
        return 'crit';
    if (percent >= warn)
        return 'warn';
    return 'ok';
}

/**
 * Milliseconds to wait before the next fetch is allowed, 0 when it can go
 * now. `state.nextTry` is the time a Retry-After or a backoff ends,
 * `state.lastAttempt` the time of the last call (both ms, 0 = never).
 */
export function fetchWait(state, now) {
    return Math.max(0, state.nextTry - now, state.lastAttempt + MIN_FETCH_GAP_MS - now);
}

// Failures that only the user can fix, by signing in to Claude Code: polled
// at the plain interval so the new login is seen on the next refresh.
const CREDENTIAL_KINDS = ['no-credentials', 'bad-credentials', 'expired'];

/**
 * Delay in seconds before retrying after a failed fetch, and the new backoff.
 * A rate limit honours Retry-After (floored at RATE_LIMIT_MIN_SECONDS) and
 * resets the backoff; a credentials problem retries at the refresh interval
 * (at least 60 s) without backoff; anything else doubles the backoff from
 * that interval up to MAX_BACKOFF_SECONDS.
 *
 * @param {{kind?: string, retryAfter?: number}} error
 * @param {number} backoff current backoff in seconds, 0 when none
 * @param {number} interval the refresh-interval setting, seconds
 * @returns {{next: number, backoff: number}}
 */
export function retryAfterError(error, backoff, interval) {
    if (error?.kind === 'rate-limited') {
        const asked = Number.isFinite(error.retryAfter) ? error.retryAfter : RATE_LIMIT_DEFAULT_SECONDS;
        return {next: Math.max(asked, RATE_LIMIT_MIN_SECONDS), backoff: 0};
    }
    const base = Math.max(interval, 60);
    if (CREDENTIAL_KINDS.includes(error?.kind))
        return {next: base, backoff: 0};
    const next = Math.min(backoff ? backoff * 2 : base, MAX_BACKOFF_SECONDS);
    return {next, backoff: next};
}
