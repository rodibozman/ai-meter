// Offline tests of src/polling.js, the decisions behind the refresh loop:
// `gjs -m test/polling.js` from the repo root.
import {
    severity, fetchWait, retryAfterError, MIN_FETCH_GAP_MS, MAX_BACKOFF_SECONDS,
} from '../src/polling.js';
import {assert, assertEqual, main} from './harness.js';

main(() => {
    // Colour thresholds.
    assert(severity(null, 70, 90) === 'ok' && severity(undefined, 70, 90) === 'ok', 'unknown percent is ok');
    assert(severity(0, 70, 90) === 'ok' && severity(69, 70, 90) === 'ok', 'below warn is ok');
    assert(severity(70, 70, 90) === 'warn' && severity(89, 70, 90) === 'warn', 'warn threshold inclusive');
    assert(severity(90, 70, 90) === 'crit' && severity(100, 70, 90) === 'crit', 'crit threshold inclusive');
    assert(severity(50, 90, 70) === 'ok' && severity(80, 90, 70) === 'crit', 'crit wins when thresholds are inverted');

    // Minimum gap between two calls, and a Retry-After or backoff still running.
    const now = 1_000_000_000;
    assert(fetchWait({nextTry: 0, lastAttempt: 0}, now) === 0, 'first fetch goes now');
    assert(fetchWait({nextTry: 0, lastAttempt: now - MIN_FETCH_GAP_MS}, now) === 0, 'exactly the gap is allowed');
    assert(fetchWait({nextTry: 0, lastAttempt: now - 10_000}, now) === MIN_FETCH_GAP_MS - 10_000, 'manual refresh 10 s after a fetch waits the rest of the gap');
    assert(fetchWait({nextTry: now + 5_000, lastAttempt: now - 1_000}, now) === MIN_FETCH_GAP_MS - 1_000, 'the longer of gap and nextTry wins');
    assert(fetchWait({nextTry: now + 120_000, lastAttempt: now - 60_000}, now) === 120_000, 'nextTry in the future is honoured');
    assert(fetchWait({nextTry: now - 1, lastAttempt: now - MIN_FETCH_GAP_MS - 1}, now) === 0, 'past nextTry does not wait');

    // Rate limit: Retry-After, floored at 60 s, resets the backoff.
    assertEqual(retryAfterError({kind: 'rate-limited', retryAfter: 77}, 480, 120), {next: 77, backoff: 0}, 'Retry-After used and backoff reset');
    assertEqual(retryAfterError({kind: 'rate-limited', retryAfter: 10}, 0, 120), {next: 60, backoff: 0}, 'Retry-After floored at 60 s');
    assertEqual(retryAfterError({kind: 'rate-limited'}, 0, 120), {next: 300, backoff: 0}, 'no Retry-After waits 300 s');
    assertEqual(retryAfterError({kind: 'rate-limited', retryAfter: NaN}, 0, 120), {next: 300, backoff: 0}, 'NaN Retry-After waits 300 s');

    // Anything else: exponential backoff from the interval up to the cap.
    let b = 0;
    const seen = [];
    for (let i = 0; i < 6; i++) {
        const r = retryAfterError({kind: 'network'}, b, 120);
        assert(r.next === r.backoff, `retry ${i + 1}: next equals the new backoff`);
        b = r.backoff;
        seen.push(r.next);
    }
    assertEqual(seen, [120, 240, 480, 900, 900, 900], 'backoff doubles from the interval and caps at 900 s');
    assert(MAX_BACKOFF_SECONDS === 900, 'cap is 15 minutes');
    assertEqual(retryAfterError({kind: 'http'}, 0, 30), {next: 60, backoff: 60}, 'interval below a minute starts at 60 s');
    assertEqual(retryAfterError({kind: 'parse'}, 0, 3600), {next: 900, backoff: 900}, 'interval above the cap starts at the cap');
    assertEqual(retryAfterError({}, 0, 120), {next: 120, backoff: 120}, 'error without a kind backs off');
    assertEqual(retryAfterError(null, 240, 120), {next: 480, backoff: 480}, 'null error backs off');
    assertEqual(retryAfterError({kind: 'rate-limited', retryAfter: 90}, 480, 120), {next: 90, backoff: 0}, 'a rate limit after backoffs restarts the series');
    assertEqual(retryAfterError({kind: 'network'}, 0, 120), {next: 120, backoff: 120}, 'next failure restarts from the interval');
});
