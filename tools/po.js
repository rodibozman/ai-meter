// Turns the gettext .po files of po/ into the JSON catalogs the extension
// reads from src/locale/, so that the package ships no translation source.
// No GNOME Shell import, so `gjs -m` can run and test it.

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

/** The content of src/locale/<code>.json for the translations `map` of parsePo(). */
export function catalogJson(map) {
    return `${JSON.stringify(Object.fromEntries(map), null, 4)}\n`;
}
