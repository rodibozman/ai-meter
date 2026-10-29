// Tests of fetchUsage against a local Soup.Server (no network):
// `gjs -m test/http.js` from the repo root. Checks the headers sent, every
// status the extension handles, and that a cross-host redirect does not
// carry the token (a libsoup property the extension relies on).
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import {fetchUsage, USER_AGENT} from '../src/usage.js';
import {assert, assertEqual, assertThrows, main} from './harness.js';

const dir = GLib.dir_make_tmp('ai-meter-test-XXXXXX');
const file = GLib.build_filenamev([dir, 'creds.json']);
function creds(expiresAt = 0) {
    GLib.file_set_contents(file, JSON.stringify({claudeAiOauth: {accessToken: 'tok-123', expiresAt}}));
    return file;
}

const OK_BODY = JSON.stringify({
    limits: [
        {kind: 'session', percent: 12, resets_at: '2026-10-29T13:00:00+00:00'},
        {kind: 'weekly_all', percent: 34, resets_at: '2026-11-04T05:00:00+00:00'},
    ],
});

// One handler per test: `reply` is replaced before each call.
let reply = null;
const requests = [];
function serve(path, handler) {
    const server = new Soup.Server();
    server.add_handler(path, (_server, msg) => {
        const headers = {};
        msg.get_request_headers().foreach((name, value) => (headers[name] = value));
        requests.push({path: msg.get_uri().get_path(), headers});
        handler(msg);
    });
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    return [server, server.get_uris()[0].get_port()];
}
function respond(msg, status, body, headers = {}) {
    msg.set_status(status, null);
    for (const [k, v] of Object.entries(headers))
        msg.get_response_headers().append(k, v);
    if (body !== null)
        msg.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode(body));
}

main(async () => {
    const [server, port] = serve('/usage', msg => reply(msg));
    const [other, otherPort] = serve('/elsewhere', msg => respond(msg, 200, OK_BODY));
    const url = `http://127.0.0.1:${port}/usage`;
    const session = new Soup.Session({timeout: 5, user_agent: USER_AGENT});
    const last = () => requests[requests.length - 1];

    try {
        // 200: parsed usage and plan, with the expected headers.
        reply = msg => respond(msg, 200, OK_BODY);
        const r = await fetchUsage(session, creds(), url);
        assert(r.usage.session.percent === 12 && r.usage.weekly.percent === 34, '200 gives parsed usage');
        assert(r.plan === '', 'plan empty when the file has none');
        assert(last().headers['Authorization'] === 'Bearer tok-123', 'bearer token sent');
        assert(last().headers['anthropic-beta'] === 'oauth-2025-04-20', 'oauth beta header sent');
        assert(last().headers['Accept'] === 'application/json', 'accept header sent');
        assert(last().headers['User-Agent'].startsWith('ai-meter/'), 'user agent is ours');

        // 401 / 403: expired, with a hint that depends on expiresAt.
        reply = msg => respond(msg, 401, '{"error":"unauthorized"}');
        let e = await assertThrows(() => fetchUsage(session, creds(Date.now() - 1000), url), '401 with a stale token is "expired"', e => e.kind === 'expired');
        assert(e?.message.includes('login expired'), 'stale token message says the login expired');
        e = await assertThrows(() => fetchUsage(session, creds(Date.now() + 3600000), url), '401 with a fresh token is still "expired"', e => e.kind === 'expired');
        assert(e?.message === 'login rejected (HTTP 401)', 'fresh token message gives the status');
        reply = msg => respond(msg, 403, null);
        await assertThrows(() => fetchUsage(session, creds(), url), '403 is "expired"', e => e.kind === 'expired' && e.message.includes('403'));

        // 429: rate limited, Retry-After in seconds, or a default.
        reply = msg => respond(msg, 429, '{}', {'Retry-After': '77'});
        e = await assertThrows(() => fetchUsage(session, creds(), url), '429 is "rate-limited"', e => e.kind === 'rate-limited');
        assert(e?.retryAfter === 77, 'Retry-After in seconds honoured');
        reply = msg => respond(msg, 429, '{}');
        e = await assertThrows(() => fetchUsage(session, creds(), url), '429 without Retry-After', e => e.kind === 'rate-limited');
        assert(e?.retryAfter === 300, 'defaults to 300 s');
        reply = msg => respond(msg, 429, '{}', {'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT'});
        e = await assertThrows(() => fetchUsage(session, creds(), url), '429 with an HTTP-date Retry-After', e => e.kind === 'rate-limited');
        assert(e?.retryAfter === 300, 'HTTP-date falls back to 300 s');
        reply = msg => respond(msg, 429, '{}', {'Retry-After': '0'});
        e = await assertThrows(() => fetchUsage(session, creds(), url), '429 with Retry-After 0', e => e.kind === 'rate-limited');
        assert(e?.retryAfter === 300, 'zero falls back to 300 s');

        // Other statuses and bodies.
        reply = msg => respond(msg, 500, 'oops');
        e = await assertThrows(() => fetchUsage(session, creds(), url), '500 is "http"', e => e.kind === 'http');
        assert(e?.message.startsWith('HTTP 500'), 'http error names the status');
        assert(!e?.message.includes('oops'), 'http error does not echo the body');
        reply = msg => respond(msg, 404, null);
        await assertThrows(() => fetchUsage(session, creds(), url), '404 is "http"', e => e.kind === 'http' && e.message.startsWith('HTTP 404'));
        reply = msg => respond(msg, 200, 'not json');
        await assertThrows(() => fetchUsage(session, creds(), url), '200 with a non-JSON body is "parse"', e => e.kind === 'parse');
        reply = msg => respond(msg, 200, '{"limits":[]}');
        await assertThrows(() => fetchUsage(session, creds(), url), '200 without limits is "parse"', e => e.kind === 'parse');
        reply = msg => respond(msg, 204, null);
        await assertThrows(() => fetchUsage(session, creds(), url), '204 is "parse"', e => e.kind === 'parse');

        // Credentials problems never reach the network.
        const before = requests.length;
        await assertThrows(() => fetchUsage(session, `${dir}/missing.json`, url), 'missing credentials', e => e.kind === 'no-credentials');
        assert(requests.length === before, 'no request without credentials');

        // Network: nothing listens there.
        const closed = new Soup.Server();
        closed.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
        const closedPort = closed.get_uris()[0].get_port();
        closed.disconnect();
        await assertThrows(() => fetchUsage(session, creds(), `http://127.0.0.1:${closedPort}/usage`), 'connection refused is "network"', e => e.kind === 'network');

        // A cross-host redirect must not carry the token (libsoup strips it).
        reply = msg => msg.set_redirect(302, `http://localhost:${otherPort}/elsewhere`);
        await fetchUsage(session, creds(), url);
        const hop = last();
        assert(hop.path === '/elsewhere', 'redirect followed');
        assertEqual(hop.headers['Authorization'], undefined, 'token not sent to the other host');
    } finally {
        server.disconnect();
        other.disconnect();
        GLib.unlink(file);
        GLib.rmdir(dir);
    }
});
