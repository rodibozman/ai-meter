// Offline test of src/usage.js: run with `gjs -m test/parse.js` from the repo root.
import {parseUsage, formatDuration, UsageError} from '../src/usage.js';

let failures = 0;
function assert(cond, what) {
    if (!cond) {
        failures++;
        print(`FAIL: ${what}`);
    } else {
        print(`ok: ${what}`);
    }
}

const sample = {
    five_hour: {utilization: 6.4, resets_at: '2026-10-29T13:00:00.097194+00:00', locked_reason: null},
    seven_day: {utilization: 6.0, resets_at: '2026-11-04T05:00:00.097216+00:00'},
    seven_day_opus: null,
    extra_usage: {is_enabled: false},
    limits: [
        {kind: 'session', group: 'session', percent: 6, severity: 'normal', resets_at: '2026-10-29T13:00:00.097194+00:00', scope: null, is_active: true},
        {kind: 'weekly_all', group: 'weekly', percent: 6, severity: 'normal', resets_at: '2026-11-04T05:00:00.097216+00:00', scope: null},
        {kind: 'weekly_scoped', group: 'weekly', percent: 4, severity: 'normal', resets_at: '2026-11-04T05:00:00.097377+00:00', scope: {model: {id: null, display_name: 'Fable'}, surface: null}},
    ],
    spend: {used: {amount_minor: 0, currency: 'USD', exponent: 2}, limit: null, percent: 0, enabled: false},
};

const u = parseUsage(sample);
assert(u.session.percent === 6, 'session percent from limits');
assert(u.session.resetsAt === Date.parse('2026-10-29T13:00:00.097Z'), 'session reset parsed, milliseconds kept');
assert(u.weekly.percent === 6, 'weekly percent');
assert(u.scoped.length === 1 && u.scoped[0].name === 'Weekly, Fable' && u.scoped[0].percent === 4, 'scoped model limit');
assert(u.extra === null, 'no extra usage');

// Older shape: no `limits` array, per-model fields.
const old = {
    five_hour: {utilization: 97.6, resets_at: '2026-10-29T13:00:00+00:00'},
    seven_day: {utilization: 40, resets_at: null},
    seven_day_opus: {utilization: 12, resets_at: '2026-11-04T05:00:00+00:00'},
    seven_day_sonnet: null,
    extra_usage: {is_enabled: true, monthly_limit: 50, used_credits: 12.5, utilization: 25, currency: 'USD'},
};
const o = parseUsage(old);
assert(o.session.percent === 98, 'rounded utilization');
assert(o.weekly.resetsAt === null, 'null reset tolerated');
assert(o.scoped.length === 1 && o.scoped[0].name === 'Weekly, Opus', 'legacy per-model field');
assert(o.extra.enabled && o.extra.used === 12.5 && o.extra.limit === 50 && o.extra.percent === 25, 'extra usage block');

// Spend block takes precedence when enabled.
const spend = {...sample, spend: {used: {amount_minor: 1234, currency: 'EUR', exponent: 2}, limit: {amount_minor: 5000, currency: 'EUR', exponent: 2}, percent: 25, enabled: true}};
const s = parseUsage(spend);
assert(s.extra.used === 12.34 && s.extra.limit === 50 && s.extra.currency === 'EUR', 'spend block parsed');

let threw = false;
try {
    parseUsage({});
} catch (e) {
    threw = e instanceof UsageError && e.kind === 'parse';
}
assert(threw, 'empty response rejected');

assert(formatDuration(45 * 60000) === '45m', 'duration minutes');
assert(formatDuration((2 * 60 + 13) * 60000) === '2h 13m', 'duration hours');
assert(formatDuration((5 * 24 + 19) * 3600000) === '5d 19h', 'duration days');
assert(formatDuration(-1) === null, 'past duration');

if (failures > 0) {
    print(`${failures} failure(s)`);
    imports.system.exit(1);
}
print('all tests passed');
