// Fetching and parsing of Claude usage. Depends only on GLib, Gio and Soup,
// so it can be exercised outside GNOME Shell with `gjs -m`.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const USER_AGENT = 'ai-meter/0.1.0 (+https://github.com/rodibozman/ai-meter)';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

export function defaultCredentialsPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
}

/**
 * Error raised by this module. `kind` is one of:
 * 'no-credentials' (file missing or unreadable), 'bad-credentials'
 * (no OAuth token in it), 'expired' (server rejected the token),
 * 'rate-limited' (with `retryAfter` in seconds), 'http', 'network', 'parse'.
 */
export class UsageError extends Error {
    constructor(kind, message) {
        super(message);
        this.name = 'UsageError';
        this.kind = kind;
    }
}

/**
 * Reads Claude Code's credentials file.
 *
 * @param {string} path
 * @returns {Promise<{accessToken: string, expiresAt: number, plan: string}>}
 */
export async function readCredentials(path) {
    let bytes;
    try {
        [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
    } catch (e) {
        throw new UsageError('no-credentials', `cannot read ${path}: ${e.message}`);
    }
    let json;
    try {
        json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new UsageError('bad-credentials', `${path} is not valid JSON`);
    }
    const oauth = json?.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || oauth.accessToken === '')
        throw new UsageError('bad-credentials', `${path} has no Claude login`);
    return {
        accessToken: oauth.accessToken,
        expiresAt: Number(oauth.expiresAt ?? 0),
        plan: planName(oauth.subscriptionType, oauth.rateLimitTier),
    };
}

function planName(subscription, tier) {
    const plan = typeof subscription === 'string' && subscription !== ''
        ? subscription[0].toUpperCase() + subscription.slice(1)
        : '';
    let label = '';
    if (typeof tier === 'string') {
        // e.g. "default_claude_max_5x" -> "Max 5x"
        const m = tier.match(/claude_(\w+?)_(\d+x)$/) ?? tier.match(/claude_(\w+)$/);
        if (m) {
            const name = m[1][0].toUpperCase() + m[1].slice(1);
            label = m[2] ? `${name} ${m[2]}` : name;
        }
    }
    // "Max" + "Max 5x" is just "Max 5x"; "Team" + "Max 5x" is "Team · Max 5x".
    if (label === '')
        return plan;
    if (plan === '' || label === plan || label.startsWith(`${plan} `))
        return label;
    return `${plan} · ${label}`;
}

function isoToMs(iso) {
    if (typeof iso !== 'string')
        return null;
    const dt = GLib.DateTime.new_from_iso8601(iso, null);
    return dt ? dt.to_unix() * 1000 + Math.floor(dt.get_microsecond() / 1000) : null;
}

function clampPercent(v) {
    if (v === null || v === undefined || Number.isNaN(Number(v)))
        return null;
    return Math.max(0, Math.round(Number(v)));
}

function fromPeriod(p, name) {
    if (!p || typeof p !== 'object')
        return null;
    const percent = clampPercent(p.percent ?? p.utilization);
    if (percent === null)
        return null;
    return {
        name,
        percent,
        resetsAt: isoToMs(p.resets_at),
        locked: typeof p.locked_reason === 'string' && p.locked_reason !== '',
    };
}

function money(obj) {
    if (!obj || typeof obj !== 'object' || typeof obj.amount_minor !== 'number')
        return null;
    const exponent = typeof obj.exponent === 'number' ? obj.exponent : 2;
    return {amount: obj.amount_minor / 10 ** exponent, currency: obj.currency ?? 'USD'};
}

/**
 * Turns the raw usage JSON into a stable shape:
 * {
 *   session: {name, percent, resetsAt, locked} | null,   // 5-hour window
 *   weekly:  {name, percent, resetsAt, locked} | null,   // 7-day, all models
 *   scoped:  [{name, percent, resetsAt, locked}],        // 7-day per model / surface
 *   extra:   {enabled, used, limit, currency, percent} | null,
 * }
 *
 * @param {object} data parsed JSON from USAGE_URL
 */
export function parseUsage(data) {
    if (!data || typeof data !== 'object')
        throw new UsageError('parse', 'usage response is not an object');

    const limits = Array.isArray(data.limits) ? data.limits : [];
    const byKind = kind => limits.find(l => l?.kind === kind);

    const session = fromPeriod(byKind('session'), '5-hour window') ??
        fromPeriod(data.five_hour, '5-hour window');
    const weekly = fromPeriod(byKind('weekly_all'), 'Weekly, all models') ??
        fromPeriod(data.seven_day, 'Weekly, all models');

    let scoped = limits
        .filter(l => l?.kind === 'weekly_scoped')
        .map(l => fromPeriod(l, scopeName(l.scope)))
        .filter(Boolean);
    if (scoped.length === 0) {
        scoped = [
            fromPeriod(data.seven_day_opus, 'Weekly, Opus'),
            fromPeriod(data.seven_day_sonnet, 'Weekly, Sonnet'),
            fromPeriod(data.seven_day_cowork, 'Weekly, Cowork'),
            fromPeriod(data.seven_day_oauth_apps, 'Weekly, apps'),
        ].filter(Boolean);
    }

    let extra = null;
    const spend = data.spend;
    if (spend && typeof spend === 'object' && spend.enabled) {
        const used = money(spend.used);
        const limit = money(spend.limit);
        extra = {
            enabled: true,
            used: used?.amount ?? null,
            limit: limit?.amount ?? null,
            currency: used?.currency ?? limit?.currency ?? 'USD',
            percent: clampPercent(spend.percent),
        };
    } else if (data.extra_usage?.is_enabled) {
        const x = data.extra_usage;
        extra = {
            enabled: true,
            used: typeof x.used_credits === 'number' ? x.used_credits : null,
            limit: typeof x.monthly_limit === 'number' ? x.monthly_limit : null,
            currency: x.currency ?? 'USD',
            percent: clampPercent(x.utilization),
        };
    }

    if (!session && !weekly)
        throw new UsageError('parse', 'usage response has no limits');

    return {session, weekly, scoped, extra};
}

function scopeName(scope) {
    const model = scope?.model?.display_name;
    const surface = scope?.surface;
    if (typeof model === 'string' && model !== '')
        return `Weekly, ${model}`;
    if (typeof surface === 'string' && surface !== '')
        return `Weekly, ${surface}`;
    return 'Weekly, scoped';
}

/**
 * Calls the usage endpoint with Claude Code's token.
 *
 * @param {Soup.Session} session
 * @param {string} credentialsPath
 * @returns {Promise<{usage: object, plan: string}>}
 */
export async function fetchUsage(session, credentialsPath) {
    const creds = await readCredentials(credentialsPath);
    const msg = Soup.Message.new('GET', USAGE_URL);
    msg.request_headers.append('Authorization', `Bearer ${creds.accessToken}`);
    msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
    msg.request_headers.append('Accept', 'application/json');

    let bytes;
    try {
        bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        throw new UsageError('network', e.message);
    }
    // `status_code` is a plain integer; `get_status()` throws in GJS on codes
    // missing from the Soup.Status enum (429 is one of them).
    const status = msg.status_code;
    if (status === 401 || status === 403) {
        const stale = creds.expiresAt > 0 && Date.now() > creds.expiresAt;
        throw new UsageError('expired', stale
            ? 'Claude Code login expired: run claude in a terminal to renew it'
            : `login rejected (HTTP ${status})`);
    }
    if (status === 429) {
        const retry = Number.parseInt(msg.response_headers.get_one('Retry-After') ?? '', 10);
        const err = new UsageError('rate-limited', 'rate limited by the usage API');
        err.retryAfter = Number.isFinite(retry) && retry > 0 ? retry : 300;
        throw err;
    }
    if (status < 200 || status >= 300)
        throw new UsageError('http', `HTTP ${status} ${msg.reason_phrase ?? ''}`.trim());

    let data;
    try {
        data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
    } catch {
        throw new UsageError('parse', 'usage response is not JSON');
    }
    return {usage: parseUsage(data), plan: creds.plan};
}

/**
 * "2h 13m", "45m", "5d 19h"; null when `ms` is in the past or unknown.
 * Rounds up to the next minute ("resets in 1m" until it does); with
 * `roundUp` false it rounds down instead, and the first minute is null
 * (an age: "updated just now").
 */
export function formatDuration(ms, roundUp = true) {
    if (ms === null || ms === undefined || ms <= 0)
        return null;
    const minutes = roundUp ? Math.ceil(ms / 60000) : Math.floor(ms / 60000);
    if (minutes === 0)
        return null;
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
}

/** Local clock time of a reset: "13:00" today, "Wed 06:00" otherwise. */
export function formatResetClock(resetsAtMs, nowMs = Date.now()) {
    if (resetsAtMs === null || resetsAtMs === undefined)
        return null;
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(resetsAtMs / 1000));
    const now = GLib.DateTime.new_from_unix_local(Math.floor(nowMs / 1000));
    const sameDay = dt.get_year() === now.get_year() && dt.get_day_of_year() === now.get_day_of_year();
    return dt.format(sameDay ? '%H:%M' : '%a %H:%M');
}
