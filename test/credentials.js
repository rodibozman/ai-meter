// Offline tests of readCredentials (and the plan name it derives), on
// temporary files: `gjs -m test/credentials.js` from the repo root.
import GLib from 'gi://GLib';
import {readCredentials, defaultCredentialsPath} from '../src/usage.js';
import {assert, assertThrows, main} from './harness.js';

const dir = GLib.dir_make_tmp('ai-meter-test-XXXXXX');
const file = GLib.build_filenamev([dir, 'creds.json']);

function write(content) {
    GLib.file_set_contents(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
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
    } finally {
        GLib.unlink(file);
        GLib.rmdir(dir);
    }
});
