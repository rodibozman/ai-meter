import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DISPLAY_MODES = [
    ['percent', 'Percentage'],
    ['bar', 'Small bar'],
    ['both', 'Percentage and bar'],
];

export default class AiMeterPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'AI Meter', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        // Top bar
        const panel = new Adw.PreferencesGroup({title: 'Top bar'});
        page.add(panel);

        const display = new Adw.ComboRow({
            title: 'Show',
            subtitle: 'What the 5-hour window looks like in the bar',
            model: Gtk.StringList.new(DISPLAY_MODES.map(([, label]) => label)),
        });
        const current = settings.get_string('panel-display');
        display.selected = Math.max(0, DISPLAY_MODES.findIndex(([key]) => key === current));
        display.connect('notify::selected', row => settings.set_string('panel-display', DISPLAY_MODES[row.selected][0]));
        panel.add(display);

        panel.add(this._switch(settings, 'show-icon', 'Show icon'));
        panel.add(this._switch(settings, 'show-weekly', 'Also show the weekly percentage',
            'Shown after the 5-hour one, e.g. "12% · 40%"'));
        panel.add(this._spin(settings, 'panel-position', 'Position', 0, 20, 1,
            '0 is the leftmost slot of the right-hand cluster, next to app indicators'));

        // Thresholds
        const colors = new Adw.PreferencesGroup({title: 'Colors', description: 'Percentages from which the indicator changes color'});
        page.add(colors);
        colors.add(this._spin(settings, 'warn-threshold', 'Amber from', 1, 100, 5));
        colors.add(this._spin(settings, 'crit-threshold', 'Red from', 1, 100, 5));

        // Data
        const data = new Adw.PreferencesGroup({title: 'Data'});
        page.add(data);
        data.add(this._spin(settings, 'refresh-interval', 'Refresh every (seconds)', 60, 3600, 30,
            'The usage API allows only a few calls per few minutes, shared with Claude Code'));
        const path = new Adw.EntryRow({
            title: 'Claude Code credentials file',
            text: settings.get_string('credentials-path'),
            show_apply_button: true,
        });
        path.connect('apply', row => settings.set_string('credentials-path', row.text));
        data.add(path);
        const hint = new Adw.ActionRow({
            title: 'Leave empty for ~/.claude/.credentials.json',
            subtitle: 'The file Claude Code writes when you sign in. Only the access token is read; nothing is written.',
        });
        data.add(hint);
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
