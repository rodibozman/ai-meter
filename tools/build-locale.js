// Writes src/locale/<code>.json from po/<code>.po for each language of
// src/i18n.js: `make locale` from the repo root, after any change in po/.
import Gio from 'gi://Gio';

import {LANGUAGES} from '../src/i18n.js';
import {parsePo, catalogJson} from './po.js';

for (const [code] of LANGUAGES.slice(1)) {
    const [, bytes] = Gio.File.new_for_path(`po/${code}.po`).load_contents(null);
    const json = catalogJson(parsePo(new TextDecoder().decode(bytes)));
    Gio.File.new_for_path(`src/locale/${code}.json`).replace_contents(
        new TextEncoder().encode(json), null, false, Gio.FileCreateFlags.NONE, null);
    print(`src/locale/${code}.json`);
}
