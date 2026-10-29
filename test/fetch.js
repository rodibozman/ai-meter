// Live check of src/usage.js against the real endpoint, using Claude Code's
// login on this machine: `gjs -m test/fetch.js`. Prints the parsed usage only.
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import {fetchUsage, defaultCredentialsPath, USER_AGENT} from '../src/usage.js';

const loop = new GLib.MainLoop(null, false);
const session = new Soup.Session({timeout: 15, user_agent: USER_AGENT});
fetchUsage(session, ARGV[0] ?? defaultCredentialsPath())
    .then(r => print(JSON.stringify(r, null, 2)))
    .catch(e => {
        print(`${e.name}${e.kind ? ` (${e.kind})` : ''}: ${e.message}`);
        imports.system.exit(1);
    })
    .finally(() => loop.quit());
loop.run();
