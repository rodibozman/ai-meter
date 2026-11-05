// Offline tests of src/i18n.js and of the translation files in src/po/:
// `gjs -m test/i18n.js` from the repo root.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {_, fmt, pickLanguage, parsePo, setCatalog, loadCatalog, loadCatalogSync, LANGUAGES} from '../src/i18n.js';
import {formatDuration, formatResetClock, limitName} from '../src/usage.js';
import {assert, assertEqual, assertThrows, main} from './harness.js';

function readText(path) {
    const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
    return new TextDecoder().decode(bytes);
}

// Every string literal passed to _() or N_() in src/.
function sourceMsgids() {
    const ids = new Set();
    const dir = Gio.File.new_for_path('src').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info = dir.next_file(null); info; info = dir.next_file(null)) {
        const name = info.get_name();
        if (!name.endsWith('.js'))
            continue;
        const text = readText(`src/${name}`);
        for (const m of text.matchAll(/\bN?_\((?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\)/g))
            ids.add((m[1] ?? m[2]).replace(/\\(.)/g, '$1'));
    }
    return ids;
}

// Things a translation must keep as they are: placeholders, commands, paths.
// A changed command or an added link in a language the reviewer cannot read
// is how a malicious translation would mislead users.
function keptParts(s) {
    return [
        ...[...s.matchAll(/\{\w+\}/g)].map(m => m[0]).sort(),
        ...[...s.matchAll(/`[^`]*`/g)].map(m => m[0]).sort(),
        ...[...s.matchAll(/~\/\S+/g)].map(m => m[0].replace(/[.,;]$/, '')).sort(),
    ];
}

main(async () => {
    // fmt
    assert(fmt('{a} and {b}', {a: 1, b: 'x'}) === '1 and x', 'placeholders replaced');
    assert(fmt('{a}{a}', {a: 2}) === '22', 'a placeholder used twice');
    assert(fmt('{missing} {a}', {a: 0}) === '{missing} 0', 'unknown placeholder kept, 0 shown');
    assert(fmt('{toString}', {}) === '{toString}', 'inherited properties are not values');

    // pickLanguage: the setting, else the system's first language with a
    // translation, else English.
    assertEqual(LANGUAGES.map(([code]) => code), ['en', 'ar', 'bn', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'pt_BR', 'ru', 'tr', 'ur', 'zh_CN'], 'English and 13 translations');
    assert(pickLanguage('it', ['fr_FR.UTF-8', 'fr_FR', 'fr', 'C']) === 'it', 'the setting wins');
    assert(pickLanguage('', ['fr_FR.UTF-8', 'fr_FR', 'fr', 'C']) === 'fr', 'empty setting follows the system');
    assert(pickLanguage('', ['it_CH.UTF-8@euro']) === 'it', 'region, encoding and modifier ignored');
    assert(pickLanguage('', ['de_DE.UTF-8', 'de', 'it', 'C']) === 'it', 'first system language with a translation');
    assert(pickLanguage('', ['de_DE.UTF-8', 'de_DE', 'de', 'C']) === 'en', 'no translation: English');
    assert(pickLanguage('', ['C']) === 'en', 'C locale: English');
    assert(pickLanguage('de', ['fr']) === 'fr', 'a setting without a translation follows the system');
    assert(pickLanguage('', ['en_GB.UTF-8', 'fr']) === 'en', 'English listed first wins over French');
    assert(pickLanguage('pt_BR', ['fr']) === 'pt_BR' && pickLanguage('pt', ['fr']) === 'fr', 'a setting must be a code exactly');
    assert(pickLanguage('', ['pt_BR.UTF-8', 'pt_BR', 'pt', 'C']) === 'pt_BR', 'Brazilian Portuguese');
    assert(pickLanguage('', ['pt_PT.UTF-8', 'pt_PT', 'pt', 'C']) === 'pt_BR', 'Portugal falls back to Brazilian Portuguese');
    assert(pickLanguage('', ['zh_CN.UTF-8', 'zh_CN', 'zh', 'C']) === 'zh_CN', 'Simplified Chinese');
    assert(pickLanguage('', ['zh_SG.UTF-8']) === 'zh_CN', 'Singapore uses Simplified Chinese');
    assert(pickLanguage('', ['zh_TW.UTF-8', 'zh_TW', 'zh', 'C']) === 'en', 'Traditional Chinese is not Simplified: English');
    assert(pickLanguage('', ['es_MX.UTF-8', 'es_MX', 'es', 'C']) === 'es', 'any Spanish region');
    assert(pickLanguage('', ['ar_EG.UTF-8']) === 'ar' && pickLanguage('', ['ur_PK']) === 'ur', 'Arabic and Urdu');

    // parsePo
    const po = parsePo([
        '# A comment',
        'msgid ""',
        'msgstr ""',
        '"Language: fr\\n"',
        '',
        '#: src/indicator.js',
        'msgid "Refresh"',
        'msgstr "Actualiser"',
        '',
        'msgid ""',
        '"Two "',
        '"lines"',
        'msgstr "Deux "',
        '"lignes"',
        'msgid "Escapes"',
        'msgstr "Say \\"hi\\"\\n\\\\ \\tok"',
        '',
        '#, fuzzy',
        'msgid "Fuzzy"',
        'msgstr "Flou"',
        '',
        'msgid "Empty"',
        'msgstr ""',
        '',
        'msgctxt "menu"',
        'msgid "Open"',
        'msgstr "Ouvrir"',
        '',
        'msgid "One file"',
        'msgid_plural "{n} files"',
        'msgstr[0] "Un fichier"',
        'msgstr[1] "{n} fichiers"',
        '',
        'garbage line',
        'msgid "Last"',
        'msgstr "Dernier"',
    ].join('\n'));
    assertEqual([...po.entries()], [
        ['Refresh', 'Actualiser'],
        ['Two lines', 'Deux lignes'],
        ['Escapes', 'Say "hi"\n\\ \tok'],
        ['Last', 'Dernier'],
    ], 'header, fuzzy, empty, context and plural entries skipped');
    assert(parsePo('').size === 0, 'empty file');
    assert(parsePo('msgid "a"\r\nmsgstr "b"\r\n').get('a') === 'b', 'CRLF line ends');

    // _() and the catalog.
    setCatalog(new Map([['Refresh', 'Actualiser']]));
    assert(_('Refresh') === 'Actualiser' && _('Settings') === 'Settings', 'translated, else English');
    setCatalog(new Map());
    assert(_('Refresh') === 'Refresh', 'empty catalog is English');

    assert((await loadCatalog('src', 'en')).size === 0 && loadCatalogSync('src', 'en').size === 0, 'English has no file');
    await assertThrows(() => loadCatalog('src', 'xx'), 'a missing file throws');

    // The translation files: the template lists every string of src/, each
    // language translates all of them and keeps what must not change.
    const ids = sourceMsgids();
    assert(ids.size > 50, `${ids.size} strings found in src/`);
    const pot = parsePo(readText('src/po/ai-meter.pot').replace(/^msgstr ""$/gm, 'msgstr "-"'));
    assertEqual([...pot.keys()].sort(), [...ids].sort(), 'src/po/ai-meter.pot lists exactly the strings of src/');
    for (const [code] of LANGUAGES.slice(1)) {
        const catalog = parsePo(readText(`src/po/${code}.po`));
        assertEqual(loadCatalogSync('src', code), catalog, `${code}: loadCatalogSync reads src/po/${code}.po`);
        assertEqual([...(await loadCatalog('src', code)).entries()], [...catalog.entries()], `${code}: loadCatalog reads the same`);
        assertEqual([...ids].filter(id => !catalog.has(id)), [], `${code}: every string translated`);
        assertEqual([...catalog.keys()].filter(id => !ids.has(id)), [], `${code}: no unused string`);
        for (const [id, str] of catalog) {
            assertEqual(keptParts(str), keptParts(id), `${code}: "${id}" keeps its placeholders, commands and paths`);
            for (const s of ['<', '>', '&', '://', 'http'])
                assert(id.includes(s) || !str.includes(s), `${code}: "${id}" adds no "${s}"`);
        }
    }

    // Formatting in another language.
    setCatalog(loadCatalogSync('src', 'fr'));
    assert(formatDuration((2 * 60 + 5) * 60000) === '2 h 05', 'French duration');
    assert(limitName({name: 'Weekly, Fable', scope: 'Fable'}) === 'Hebdomadaire, Fable', 'French scoped name keeps the model');
    assert(limitName({name: '5-hour window', scope: null}) === 'Fenêtre de 5 heures', 'French fixed name');
    const wednesday = GLib.DateTime.new_local(2026, 11, 4, 6, 0, 0).to_unix() * 1000;
    assert(formatResetClock(wednesday, wednesday - 86400000) === 'mer. 06:00', 'French day name');
    setCatalog(new Map());
    assert(formatResetClock(wednesday, wednesday - 86400000) === 'Wed 06:00', 'English day name, whatever the system locale');
    assert(limitName({name: 'Weekly, Fable', scope: 'Fable'}) === 'Weekly, Fable', 'English scoped name');
});
