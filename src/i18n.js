// Translations: one gettext .po file per language in po/, read by the
// extension itself rather than through GNOME's gettext, which follows the
// language of the whole Shell and so could not honour the language setting.
// No GNOME Shell import, so `gjs -m` can test it.

import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

/**
 * The languages with a translation, English being the source text: the
 * code of src/po/<code>.po and the language's name in that language.
 */
export const LANGUAGES = [
    ['en', 'English'],
    ['ar', 'العربية'],
    ['bn', 'বাংলা'],
    ['es', 'Español'],
    ['fr', 'Français'],
    ['hi', 'हिन्दी'],
    ['id', 'Bahasa Indonesia'],
    ['it', 'Italiano'],
    ['ja', '日本語'],
    ['pt_BR', 'Português (Brasil)'],
    ['ru', 'Русский'],
    ['tr', 'Türkçe'],
    ['ur', 'اردو'],
    ['zh_CN', '简体中文'],
];

// System languages served by the translation of another code: Portugal's
// Portuguese by Brazil's, Singapore's Chinese (simplified) by China's.
const FALLBACKS = {pt: 'pt_BR', zh_SG: 'zh_CN'};

let catalog = new Map();

/** The translation of `msgid` in the current language, else `msgid`. */
export function _(msgid) {
    return catalog.get(msgid) ?? msgid;
}

/** Marks a string for translation where it is defined; `_()` translates it where it is shown. */
export function N_(msgid) {
    return msgid;
}

/** Replaces each `{name}` in `template` with `values[name]`. */
export function fmt(template, values) {
    return template.replace(/\{(\w+)\}/g, (all, name) => Object.hasOwn(values, name) ? String(values[name]) : all);
}

/** Makes `map` (msgid -> translation) the texts `_()` returns. */
export function setCatalog(map) {
    catalog = map;
}

/**
 * The language to show: `setting` when it has a translation, otherwise the
 * first of `systemNames` (GLib.get_language_names(), e.g. ['fr_FR.UTF-8',
 * 'fr_FR', 'fr', 'C']) that has one, by language and region ('pt_BR') then
 * by language alone ('fr' for 'fr_CA'), otherwise English.
 */
export function pickLanguage(setting, systemNames) {
    const codes = LANGUAGES.map(([code]) => code);
    if (codes.includes(setting))
        return setting;
    for (const name of systemNames) {
        const locale = name.split(/[.@]/)[0];
        for (const candidate of [locale, locale.split('_')[0]]) {
            if (codes.includes(candidate))
                return candidate;
            if (Object.hasOwn(FALLBACKS, candidate))
                return FALLBACKS[candidate];
        }
    }
    return 'en';
}

function unquote(s) {
    const escapes = {n: '\n', t: '\t', '"': '"', '\\': '\\'};
    return s.slice(1, -1).replace(/\\(.)/g, (_all, c) => escapes[c] ?? c);
}

/**
 * The translations of a .po file, msgid -> msgstr. Skipped like gettext
 * does: the header, empty and fuzzy translations; and what this extension
 * never uses: contexts and plural forms.
 */
export function parsePo(text) {
    const map = new Map();
    let entry = {};
    let field = null;
    const flush = () => {
        const {msgid, msgstr, msgctxt, msgid_plural: plural, fuzzy} = entry;
        if (msgid && msgstr && msgctxt === undefined && plural === undefined && !fuzzy)
            map.set(msgid, msgstr);
        entry = {};
        field = null;
    };
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '') {
            flush();
        } else if (line.startsWith('#')) {
            if (field)
                flush();
            if (/^#,.*\bfuzzy\b/.test(line))
                entry.fuzzy = true;
        } else if (line.startsWith('"') && line.endsWith('"') && line.length > 1) {
            if (field)
                entry[field] += unquote(line);
        } else {
            const m = line.match(/^(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+(".*")$/);
            if (!m) {
                field = null;
                continue;
            }
            // A new entry without the blank line between the two.
            if ((m[1] === 'msgid' && field && field !== 'msgctxt') || (m[1] === 'msgctxt' && field))
                flush();
            field = m[1];
            entry[field] = unquote(m[2]);
        }
    }
    flush();
    return map;
}

function poFile(dir, lang) {
    return Gio.File.new_for_path(`${dir}/po/${lang}.po`);
}

/** The translations of `lang` from `dir`/po/, empty for English. */
export async function loadCatalog(dir, lang, cancellable = null) {
    if (lang === 'en')
        return new Map();
    const [bytes] = await poFile(dir, lang).load_contents_async(cancellable);
    return parsePo(new TextDecoder().decode(bytes));
}

/** loadCatalog() for the preferences window, which runs outside the Shell. */
export function loadCatalogSync(dir, lang) {
    if (lang === 'en')
        return new Map();
    const [, bytes] = poFile(dir, lang).load_contents(null);
    return parsePo(new TextDecoder().decode(bytes));
}
