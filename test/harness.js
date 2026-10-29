// Tiny test harness for `gjs -m`: `assert` counts failures, `main` runs a
// suite (sync or async) under a main loop and exits 1 when anything failed.
import GLib from 'gi://GLib';
import System from 'system';

let failures = 0;

export function assert(cond, what) {
    if (cond) {
        print(`ok: ${what}`);
    } else {
        failures++;
        print(`FAIL: ${what}`);
    }
}

export function assertEqual(actual, expected, what) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    assert(a === e, `${what}${a === e ? '' : ` (got ${a}, want ${e})`}`);
}

/** Runs `fn`, expects it to throw, and returns the error (or null). */
export async function assertThrows(fn, what, check = () => true) {
    try {
        await fn();
    } catch (e) {
        assert(check(e), `${what} (threw ${e.name}${e.kind ? ` ${e.kind}` : ''}: ${e.message})`);
        return e;
    }
    assert(false, `${what} (did not throw)`);
    return null;
}

export function main(suite) {
    const loop = new GLib.MainLoop(null, false);
    let exitCode = 0;
    Promise.resolve()
        .then(suite)
        .catch(e => {
            printerr(`ERROR: ${e.message}\n${e.stack ?? ''}`);
            exitCode = 1;
        })
        .finally(() => {
            if (failures > 0) {
                print(`${failures} failure(s)`);
                exitCode = 1;
            } else if (exitCode === 0) {
                print('all tests passed');
            }
            loop.quit();
        });
    loop.run();
    System.exit(exitCode);
}
