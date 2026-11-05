import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {_, N_, LANGUAGES, pickLanguage, loadCatalogSync, setCatalog} from './i18n.js';

const DISPLAY_MODES = [
    ['percent', N_('Percentage')],
    ['bar', N_('Small bar')],
    ['both', N_('Percentage and bar')],
];

export default class AiMeterPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const lang = pickLanguage(settings.get_string('language'), GLib.get_language_names());
        try {
            setCatalog(loadCatalogSync(this.path, lang));
        } catch (e) {
            console.warn(`[ai-meter] cannot read the ${lang} translation, using English: ${e.message}`);
        }

        const page = new Adw.PreferencesPage({title: 'AI Meter', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const general = new Adw.PreferencesGroup();
        page.add(general);
        // Language names stay in their own language, so anyone can find theirs.
        general.add(this._combo(settings, 'language', _('Language'),
            _('Automatic follows the system language, or English when there is no translation for it. Reopen this window to see it in the new language.'),
            [['', _('Automatic')], ...LANGUAGES]));

        const panel = new Adw.PreferencesGroup({title: _('Top bar')});
        page.add(panel);
        panel.add(this._combo(settings, 'panel-display', _('Show'), _('What the 5-hour window looks like in the bar'),
            DISPLAY_MODES.map(([key, label]) => [key, _(label)])));
        panel.add(this._switch(settings, 'show-icon', _('Show icon')));
        panel.add(this._switch(settings, 'show-weekly', _('Also show the weekly percentage'),
            _('Shown after the 5-hour one, e.g. "12% · 40%"')));
        panel.add(this._spin(settings, 'panel-position', _('Position'), 0, 20, 1,
            _('0 is the leftmost slot of the right-hand cluster, next to app indicators')));

        const colors = new Adw.PreferencesGroup({title: _('Colors'), description: _('Percentages from which the indicator changes color')});
        page.add(colors);
        colors.add(this._spin(settings, 'warn-threshold', _('Amber from'), 1, 100, 5));
        colors.add(this._spin(settings, 'crit-threshold', _('Red from'), 1, 100, 5));

        const data = new Adw.PreferencesGroup({title: _('Data')});
        page.add(data);
        data.add(this._spin(settings, 'refresh-interval', _('Refresh every (seconds)'), 150, 3600, 30,
            _('The usage API allows only a few calls per few minutes, shared with Claude Code')));
        const path = new Adw.EntryRow({
            title: _('Claude Code credentials file'),
            text: settings.get_string('credentials-path'),
            show_apply_button: true,
        });
        path.connect('apply', row => settings.set_string('credentials-path', row.text));
        data.add(path);
        const hint = new Adw.ActionRow({
            title: _('Leave empty for ~/.claude/.credentials.json'),
            subtitle: _('The file Claude Code writes when you sign in. Only the access token is read; nothing is written.'),
        });
        data.add(hint);
    }

    // A drop-down for a string key, `choices` being [value, label] pairs.
    _combo(settings, key, title, subtitle, choices) {
        const row = new Adw.ComboRow({
            title,
            subtitle,
            model: Gtk.StringList.new(choices.map(([, label]) => label)),
        });
        const current = settings.get_string(key);
        row.selected = Math.max(0, choices.findIndex(([value]) => value === current));
        row.connect('notify::selected', r => settings.set_string(key, choices[r.selected][0]));
        return row;
    }

    _switch(settings, key, title, subtitle = null) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _spin(settings, key, title, lower, upper, step, subtitle = null) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 4}),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
