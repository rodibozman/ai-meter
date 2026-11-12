// Translations: one JSON file per language in locale/, built from the gettext
// .po files of the repository's po/ and read by the extension itself rather
// than through GNOME's gettext, which follows the language of the whole Shell
// and so could not honour the language setting.
// No GNOME Shell import, so `gjs -m` can test it.

import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

/**
 * The languages with a translation, English being the source text: the
 * code of po/<code>.po and the language's name in that language.
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

/** The file of `lang`'s translations in `dir`, built from po/<lang>.po by `make locale`. */
export function catalogFile(dir, lang) {
    return Gio.File.new_for_path(`${dir}/locale/${lang}.json`);
}

/** The translations in the bytes of a catalogFile(), msgid -> translation. */
export function parseCatalog(bytes) {
    return new Map(Object.entries(JSON.parse(new TextDecoder().decode(bytes))));
}

/** The translations of `lang` from `dir`/locale/, empty for English. */
export async function loadCatalog(dir, lang, cancellable = null) {
    if (lang === 'en')
        return new Map();
    const [bytes] = await catalogFile(dir, lang).load_contents_async(cancellable);
    return parseCatalog(bytes);
}
