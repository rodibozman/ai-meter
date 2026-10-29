// Offline tests of the parsing and formatting in src/usage.js:
// `gjs -m test/parse.js` from the repo root.
import GLib from 'gi://GLib';
import {parseUsage, formatDuration, formatResetClock, UsageError} from '../src/usage.js';
import {assert, assertEqual, assertThrows, main} from './harness.js';

main(async () => {
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
    assert(u.session.locked === false, 'null locked_reason is not locked');
    assert(u.weekly.percent === 6, 'weekly percent');
    assert(u.scoped.length === 1 && u.scoped[0].name === 'Weekly, Fable' && u.scoped[0].percent === 4, 'scoped model limit');
    assert(u.extra === null, 'no extra usage');

    // Scope names: surface fallback, then a generic one.
    const scopes = parseUsage({
        limits: [
            {kind: 'session', percent: 1},
            {kind: 'weekly_scoped', percent: 2, scope: {model: null, surface: 'cowork'}},
            {kind: 'weekly_scoped', percent: 3, scope: null},
            {kind: 'weekly_scoped', percent: 4, scope: {model: {display_name: ''}, surface: ''}},
        ],
    });
    assertEqual(scopes.scoped.map(s => s.name), ['Weekly, cowork', 'Weekly, scoped', 'Weekly, scoped'], 'scope name fallbacks');

    // Older shape: no `limits` array, per-model fields.
    const old = {
        five_hour: {utilization: 97.6, resets_at: '2026-10-29T13:00:00+00:00', locked_reason: 'limit'},
        seven_day: {utilization: 40, resets_at: null},
        seven_day_opus: {utilization: 12, resets_at: '2026-11-04T05:00:00+00:00'},
        seven_day_sonnet: null,
        extra_usage: {is_enabled: true, monthly_limit: 50, used_credits: 12.5, utilization: 25, currency: 'USD'},
    };
    const o = parseUsage(old);
    assert(o.session.percent === 98, 'rounded utilization');
    assert(o.session.locked === true, 'locked_reason string means locked');
    assert(o.weekly.resetsAt === null, 'null reset tolerated');
    assert(o.scoped.length === 1 && o.scoped[0].name === 'Weekly, Opus', 'legacy per-model field');
    assert(o.extra.enabled && o.extra.used === 12.5 && o.extra.limit === 50 && o.extra.percent === 25, 'extra usage block');

    // Spend block takes precedence when enabled.
    const spend = {...sample, spend: {used: {amount_minor: 1234, currency: 'EUR', exponent: 2}, limit: {amount_minor: 5000, currency: 'EUR', exponent: 2}, percent: 25, enabled: true}};
    const s = parseUsage(spend);
    assert(s.extra.used === 12.34 && s.extra.limit === 50 && s.extra.currency === 'EUR', 'spend block parsed');
    const noExp = parseUsage({...sample, spend: {used: {amount_minor: 250}, limit: null, percent: null, enabled: true}});
    assert(noExp.extra.used === 2.5 && noExp.extra.limit === null && noExp.extra.currency === 'USD' && noExp.extra.percent === null, 'spend without exponent, currency or limit');

    // Clamping and bad values.
    assert(parseUsage({five_hour: {utilization: 137.2}}).session.percent === 100, 'percent capped at 100');
    assert(parseUsage({five_hour: {utilization: -3}}).session.percent === 0, 'percent floored at 0');
    assert(parseUsage({five_hour: {utilization: 0}, seven_day: {percent: 0, utilization: 50}}).weekly.percent === 0, 'percent 0 wins over utilization');
    assert(parseUsage({five_hour: {utilization: 'abc'}, seven_day: {utilization: 1}}).session === null, 'non-numeric percent drops the period');
    assert(parseUsage({five_hour: {utilization: 1, resets_at: 'tomorrow'}}).session.resetsAt === null, 'bad ISO date gives null reset');
    assert(parseUsage({five_hour: {utilization: 1, resets_at: 42}}).session.resetsAt === null, 'non-string reset gives null');

    // Rejections.
    await assertThrows(() => parseUsage({}), 'empty response rejected', e => e instanceof UsageError && e.kind === 'parse');
    await assertThrows(() => parseUsage(null), 'null response rejected', e => e.kind === 'parse');
    await assertThrows(() => parseUsage('x'), 'string response rejected', e => e.kind === 'parse');
    await assertThrows(() => parseUsage({limits: [{kind: 'weekly_scoped', percent: 3}]}), 'scoped only is not enough', e => e.kind === 'parse');

    // formatDuration: rounds up for countdowns.
    assert(formatDuration(45 * 60000) === '45m', 'duration minutes');
    assert(formatDuration((2 * 60 + 13) * 60000) === '2h 13m', 'duration hours');
    assert(formatDuration((5 * 24 + 19) * 3600000) === '5d 19h', 'duration days');
    assert(formatDuration(2 * 3600000 + 5 * 60000) === '2h 05m', 'minutes zero-padded after hours');
    assert(formatDuration(1000) === '1m', 'one second rounds up to 1m');
    assert(formatDuration(-1) === null, 'past duration');
    assert(formatDuration(0) === null, 'zero duration');
    assert(formatDuration(null) === null && formatDuration(undefined) === null, 'unknown duration');
    // Ages round down, and the first minute is "just now" (null).
    assert(formatDuration(5000, false) === null, 'age under a minute is null');
    assert(formatDuration(59999, false) === null, 'age of 59.999 s is still null');
    assert(formatDuration(60000, false) === '1m', 'age of 60 s is 1m');
    assert(formatDuration(119999, false) === '1m', 'age of 119 s is still 1m');
    assert(formatDuration(3 * 3600000 + 59 * 60000 + 59000, false) === '3h 59m', 'age rounds down after hours');

    // formatResetClock: local clock, day name only when not today. Built with
    // GLib local times so the test does not depend on the machine's zone.
    const today = GLib.DateTime.new_now_local();
    const at = (dayOffset, hour) => GLib.DateTime.new_local(today.get_year(), today.get_month(), today.get_day_of_month(), hour, 0, 0).add_days(dayOffset);
    const nowMs = at(0, 10).to_unix() * 1000;
    assert(formatResetClock(at(0, 13).to_unix() * 1000, nowMs) === '13:00', 'reset today shows the hour only');
    const tomorrow = at(1, 6);
    assert(formatResetClock(tomorrow.to_unix() * 1000, nowMs) === `${tomorrow.format('%a')} 06:00`, 'reset tomorrow shows the day name');
    const lastYear = at(0, 13).add_years(-1);
    assert(formatResetClock(lastYear.to_unix() * 1000, nowMs) === `${lastYear.format('%a')} 13:00`, 'same day-of-year in another year is not today');
    assert(formatResetClock(null) === null && formatResetClock(undefined) === null, 'unknown reset clock');
});
