// Offline tests of readCredentials (and the plan name it derives), on
// temporary files: `gjs -m test/credentials.js` from the repo root.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {readCredentials, watchCredentials, defaultCredentialsPath} from '../src/usage.js';
import {assert, assertThrows, main} from './harness.js';

const dir = GLib.dir_make_tmp('ai-meter-test-XXXXXX');
const file = GLib.build_filenamev([dir, 'creds.json']);

function write(content) {
    GLib.file_set_contents(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
}

// Calls `action`, then waits `ms` on the main loop and returns how many times
// the watcher fired.
function firesAfter(action, ms = 500) {
    let fired = 0;
    const monitor = watchCredentials(file, () => fired++);
    action();
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            monitor.cancel();
            resolve(fired);
            return GLib.SOURCE_REMOVE;
        });
    });
}

async function plan(subscriptionType, rateLimitTier) {
    write({claudeAiOauth: {accessToken: 'tok', subscriptionType, rateLimitTier}});
    return (await readCredentials(file)).plan;
}

main(async () => {
    try {
        assert(defaultCredentialsPath() === `${GLib.get_home_dir()}/.claude/.credentials.json`, 'default path is ~/.claude/.credentials.json');

        // Happy path.
        write({claudeAiOauth: {accessToken: 'sk-ant-oat01-abc', refreshToken: 'never-used', expiresAt: 1767225600000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x'}});
        const c = await readCredentials(file);
        assert(c.accessToken === 'sk-ant-oat01-abc', 'access token read');
        assert(c.expiresAt === 1767225600000, 'expiresAt read as a number');
        assert(!('refreshToken' in c), 'refresh token is not exposed');
        write({claudeAiOauth: {accessToken: 'tok'}});
        assert((await readCredentials(file)).expiresAt === 0, 'missing expiresAt is 0');
        write({claudeAiOauth: {accessToken: 'tok', expiresAt: '1767225600000'}});
        assert((await readCredentials(file)).expiresAt === 1767225600000, 'string expiresAt converted');

        // Plan name.
        assert(await plan('max', 'default_claude_max_5x') === 'Max 5x', 'max + max_5x is "Max 5x"');
        assert(await plan('max', 'default_claude_max_20x') === 'Max 20x', 'max + max_20x is "Max 20x"');
        assert(await plan('pro', 'default_claude_pro') === 'Pro', 'pro + pro is "Pro"');
        assert(await plan('team', 'default_claude_max_5x') === 'Team · Max 5x', 'team + max_5x keeps both');
        assert(await plan('enterprise', 'default_claude_enterprise') === 'Enterprise', 'same name once');
        assert(await plan('max', undefined) === 'Max', 'subscription only');
        assert(await plan(undefined, 'default_claude_max_5x') === 'Max 5x', 'tier only');
        assert(await plan('', 'something_else') === '', 'nothing recognisable is empty');
        assert(await plan(undefined, undefined) === '', 'no plan fields is empty');

        // Failures, each with its kind and without the token in the message.
        await assertThrows(() => readCredentials(`${dir}/missing.json`), 'missing file', e => e.kind === 'no-credentials' && e.message.includes('missing.json'));
        write('{not json');
        await assertThrows(() => readCredentials(file), 'invalid JSON', e => e.kind === 'bad-credentials');
        write({});
        await assertThrows(() => readCredentials(file), 'no claudeAiOauth block', e => e.kind === 'bad-credentials');
        write({claudeAiOauth: {accessToken: ''}});
        await assertThrows(() => readCredentials(file), 'empty access token', e => e.kind === 'bad-credentials');
        write({claudeAiOauth: {accessToken: 12345}});
        await assertThrows(() => readCredentials(file), 'non-string access token', e => e.kind === 'bad-credentials');
        write('null');
        await assertThrows(() => readCredentials(file), 'JSON null', e => e.kind === 'bad-credentials');
        write('[]');
        await assertThrows(() => readCredentials(file), 'JSON array', e => e.kind === 'bad-credentials');

        // Watching: every way Claude Code may rewrite the file is seen.
        write({});
        const tmp = `${dir}/creds.json.tmp`;
        assert(await firesAfter(() => {
            const stream = Gio.File.new_for_path(file).replace(null, false, Gio.FileCreateFlags.NONE, null);
            stream.close(null);
        }) >= 1, 'watcher sees g_file_replace');
        assert(await firesAfter(() => write({claudeAiOauth: {accessToken: 'new'}})) >= 1, 'watcher sees an atomic write');
        assert(await firesAfter(() => {
            GLib.file_set_contents(tmp, '{}');
            GLib.rename(tmp, file);
        }) >= 1, 'watcher sees a file renamed over it');
        assert(await firesAfter(() => {
            const stream = Gio.File.new_for_path(file).open_readwrite(null);
            stream.truncate(0, null);
            stream.close(null);
        }) >= 1, 'watcher sees an in-place write');
        assert(await firesAfter(() => GLib.unlink(file)) === 0, 'watcher ignores a deletion');
        assert(await firesAfter(() => write({})) >= 1, 'watcher sees the file created again');
        assert(await firesAfter(() => GLib.file_set_contents(`${dir}/other.json`, '{}')) === 0, 'watcher ignores other files');
        GLib.unlink(`${dir}/other.json`);
    } finally {
        GLib.unlink(file);
        GLib.rmdir(dir);
    }
});
