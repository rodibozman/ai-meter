import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    fetchUsage, defaultCredentialsPath, formatDuration, formatResetClock, USER_AGENT,
} from './usage.js';
import {severity, fetchWait, retryAfterError, initialDelay, newPollState} from './polling.js';

const MENU_TICK_SECONDS = 30;

// St.BoxLayout's `vertical` is deprecated from GNOME 48 in favour of
// `orientation`, which GNOME 45 to 47 do not have.
const VERTICAL = St.BoxLayout.find_property('orientation')
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

const COLORS = {
    ok: [0.21, 0.52, 0.89],    // GNOME blue 3
    warn: [0.96, 0.76, 0.07],  // GNOME yellow 3
    crit: [0.93, 0.20, 0.23],  // GNOME red 2
};

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

/** A small horizontal bar drawn with cairo; track in the theme's text colour. */
const Bar = GObject.registerClass(
class AiMeterBar extends St.DrawingArea {
    _init(params) {
        super._init(params);
        this._percent = 0;
        this._severity = 'ok';
        this.connect('repaint', () => this._repaint());
    }

    setValue(percent, sev) {
        this._percent = Math.max(0, Math.min(100, percent ?? 0));
        this._severity = sev;
        this.queue_repaint();
    }

    _repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const fg = this.get_theme_node().get_foreground_color();
        const r = h / 2;

        cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.25);
        roundedRect(cr, 0, 0, w, h, r);
        cr.fill();

        const fill = Math.round(w * this._percent / 100);
        if (fill > 0) {
            const [cr_, cg, cb] = COLORS[this._severity] ?? COLORS.ok;
            cr.setSourceRGBA(cr_, cg, cb, 1);
            roundedRect(cr, 0, 0, Math.max(fill, h), h, r);
            cr.fill();
        }
        cr.$dispose();
    }
});

/** One limit in the dropdown: name, percentage, bar, reset line. */
const MeterItem = GObject.registerClass(
class AiMeterMeterItem extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({reactive: false, can_focus: false});
        const box = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'ai-meter-meter'});
        const row = new St.BoxLayout({x_expand: true});
        this._name = new St.Label({style_class: 'ai-meter-meter-name', x_expand: true});
        this._pct = new St.Label({style_class: 'ai-meter-meter-pct'});
        row.add_child(this._name);
        row.add_child(this._pct);
        this._bar = new Bar({x_expand: true, height: 8, style_class: 'ai-meter-meter-bar'});
        this._reset = new St.Label({style_class: 'ai-meter-meter-reset'});
        box.add_child(row);
        box.add_child(this._bar);
        box.add_child(this._reset);
        this.add_child(box);
    }

    update(limit, sev, now) {
        this._name.text = limit.name;
        this._pct.text = `${limit.percent}%`;
        this._pct.remove_style_class_name('ai-meter-warn');
        this._pct.remove_style_class_name('ai-meter-crit');
        if (sev !== 'ok')
            this._pct.add_style_class_name(`ai-meter-${sev}`);
        this._bar.setValue(limit.percent, sev);
        const left = formatDuration(limit.resetsAt === null ? null : limit.resetsAt - now);
        const clock = formatResetClock(limit.resetsAt, now);
        if (left === null)
            this._reset.text = limit.locked ? 'Limit reached' : '';
        else
            this._reset.text = `${limit.locked || limit.percent >= 100 ? 'Limit reached, resets' : 'Resets'} in ${left} (${clock})`;
        this._reset.visible = this._reset.text !== '';
    }
});

const Indicator = GObject.registerClass(
class AiMeterIndicator extends PanelMenu.Button {
    _init(extension, settings, state) {
        super._init(0.5, 'AI Meter', false);
        this._extension = extension;
        this._settings = settings;
        this._http = new Soup.Session({timeout: 15, user_agent: USER_AGENT});
        this._timerId = 0;
        this._menuTickId = 0;
        // Shared with the extension and any indicator created after this one.
        this._state = state;
        this._destroyed = false;
        this._refreshing = false;

        // Top bar content.
        const box = new St.BoxLayout({style_class: 'ai-meter-panel-box', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/ai-meter-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this._panelBar = new Bar({width: 28, height: 6, y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({style_class: 'ai-meter-panel-label', y_align: Clutter.ActorAlign.CENTER, text: '…'});
        box.add_child(this._icon);
        box.add_child(this._panelBar);
        box.add_child(this._label);
        this.add_child(box);

        // Dropdown.
        this._buildMenu();

        this._settingsIds = [
            settings.connect('changed::refresh-interval', () => this._schedule(0)),
            settings.connect('changed::credentials-path', () => this._schedule(0)),
            settings.connect('changed', () => this._render()),
        ];
        this.menu.connect('open-state-changed', (_m, open) => this._onMenuToggled(open));

        this._render();
        this._schedule(initialDelay(this._state, settings.get_int('refresh-interval'), Date.now()));
    }

    _buildMenu() {
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const hbox = new St.BoxLayout({x_expand: true});
        hbox.add_child(new St.Label({text: 'Claude usage', style_class: 'ai-meter-menu-header', x_expand: true}));
        this._planLabel = new St.Label({style_class: 'ai-meter-menu-plan', y_align: Clutter.ActorAlign.CENTER});
        hbox.add_child(this._planLabel);
        header.add_child(hbox);
        this.menu.addMenuItem(header);

        this._metersSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._metersSection);

        this._message = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._messageLabel = new St.Label({style_class: 'ai-meter-menu-message', x_expand: true});
        this._messageLabel.clutter_text.line_wrap = true;
        this._message.add_child(this._messageLabel);
        this.menu.addMenuItem(this._message);

        this._extraItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const ebox = new St.BoxLayout({x_expand: true});
        ebox.add_child(new St.Label({text: 'Extra usage', style_class: 'ai-meter-meter-name', x_expand: true}));
        this._extraLabel = new St.Label({style_class: 'ai-meter-meter-pct'});
        ebox.add_child(this._extraLabel);
        this._extraItem.add_child(ebox);
        this.menu.addMenuItem(this._extraItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const footer = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const fbox = new St.BoxLayout({x_expand: true, style_class: 'ai-meter-footer'});
        this._updatedLabel = new St.Label({style_class: 'ai-meter-footer-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const refresh = new St.Button({label: 'Refresh', style_class: 'button', can_focus: true});
        refresh.connect('clicked', () => this._schedule(0));
        const prefs = new St.Button({label: 'Settings', style_class: 'button', can_focus: true});
        prefs.connect('clicked', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        fbox.add_child(this._updatedLabel);
        fbox.add_child(refresh);
        fbox.add_child(prefs);
        footer.add_child(fbox);
        this.menu.addMenuItem(footer);
    }

    _credentialsPath() {
        const p = this._settings.get_string('credentials-path').trim();
        return p === '' ? defaultCredentialsPath() : p.replace(/^~(?=\/|$)/, GLib.get_home_dir());
    }

    _schedule(seconds) {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._destroyed)
            return;
        if (seconds <= 0) {
            this._refresh();
            return;
        }
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timerId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        if (this._destroyed || this._refreshing)
            return;
        const now = Date.now();
        const wait = fetchWait(this._state, now);
        if (wait > 0) {
            // Too soon (manual refresh spam, or a Retry-After still running).
            this._schedule(Math.ceil(wait / 1000));
            return;
        }
        this._refreshing = true;
        this._state.lastAttempt = now;
        this._render();
        let next;
        try {
            const {usage, plan} = await fetchUsage(this._http, this._credentialsPath());
            Object.assign(this._state, {usage, plan, error: null, fetchedAt: Date.now(), nextTry: 0, backoff: 0});
            next = this._settings.get_int('refresh-interval');
        } catch (e) {
            this._state.error = e;
            const kind = e.kind ?? 'unknown';
            if (kind !== 'no-credentials' && kind !== 'expired')
                console.warn(`[ai-meter] refresh failed (${kind}): ${e.message}`);
            // Honours Retry-After (the budget is shared with Claude Code),
            // otherwise backs off exponentially.
            const retry = retryAfterError(e, this._state.backoff, this._settings.get_int('refresh-interval'));
            this._state.backoff = retry.backoff;
            next = retry.next;
            this._state.nextTry = Date.now() + next * 1000;
        } finally {
            this._refreshing = false;
        }
        if (this._destroyed)
            return;
        this._render();
        this._schedule(next);
    }

    _thresholds() {
        return [this._settings.get_int('warn-threshold'), this._settings.get_int('crit-threshold')];
    }

    _render() {
        if (this._destroyed)
            return;
        const now = Date.now();
        const {usage, plan, error, fetchedAt} = this._state;
        const [warn, crit] = this._thresholds();
        const display = this._settings.get_string('panel-display');

        this._icon.visible = this._settings.get_boolean('show-icon');
        this._label.remove_style_class_name('ai-meter-warn');
        this._label.remove_style_class_name('ai-meter-crit');

        // Top bar.
        if (usage?.session) {
            const s = usage.session;
            const sev = severity(s.percent, warn, crit);
            const exhausted = s.locked || s.percent >= 100;
            let text;
            if (exhausted) {
                const left = formatDuration(s.resetsAt === null ? null : s.resetsAt - now);
                text = left === null ? '100%' : `↻ ${left}`;
            } else {
                text = `${s.percent}%`;
            }
            if (this._settings.get_boolean('show-weekly') && usage.weekly)
                text += ` · ${usage.weekly.percent}%`;
            this._label.text = text;
            this._label.visible = display !== 'bar' || exhausted;
            this._panelBar.visible = display !== 'percent';
            this._panelBar.setValue(s.percent, sev);
            if (sev !== 'ok')
                this._label.add_style_class_name(`ai-meter-${sev}`);
        } else {
            this._label.visible = true;
            this._panelBar.visible = false;
            if (!error)
                this._label.text = '…';
            else if (error.kind === 'no-credentials' || error.kind === 'bad-credentials')
                this._label.text = 'no login';
            else if (error.kind === 'expired')
                this._label.text = 'expired';
            else
                this._label.text = '–';
        }

        // Dropdown.
        this._planLabel.text = plan ?? '';
        this._metersSection.removeAll();
        if (usage) {
            const limits = [usage.session, usage.weekly, ...usage.scoped].filter(Boolean);
            for (const limit of limits) {
                const item = new MeterItem();
                item.update(limit, severity(limit.percent, warn, crit), now);
                this._metersSection.addMenuItem(item);
            }
        }
        if (usage?.extra?.enabled) {
            const x = usage.extra;
            const fmt = v => v === null ? '?' : `${v.toFixed(2)} ${x.currency}`;
            this._extraLabel.text = x.limit === null ? fmt(x.used) : `${fmt(x.used)} / ${fmt(x.limit)}`;
            this._extraItem.visible = true;
        } else {
            this._extraItem.visible = false;
        }
        this._messageLabel.text = error ? this._explain(error) : '';
        this._message.visible = Boolean(error);

        if (fetchedAt) {
            const age = formatDuration(now - fetchedAt, false);
            this._updatedLabel.text = age === null ? 'Updated just now' : `Updated ${age} ago`;
        } else {
            this._updatedLabel.text = this._refreshing ? 'Fetching…' : 'Not fetched yet';
        }
    }

    _explain(error) {
        switch (error.kind) {
        case 'no-credentials':
            return `No Claude Code login found at ${this._credentialsPath()}. Install Claude Code and run \`claude\` once to sign in.`;
        case 'bad-credentials':
            return 'The credentials file has no Claude login. Run `claude` in a terminal and sign in.';
        case 'expired':
            return 'Claude Code login expired. Open Claude Code (run `claude` in a terminal) to renew it; the meter picks it up on the next refresh.';
        case 'rate-limited': {
            const left = formatDuration(this._state.nextTry - Date.now());
            return `The usage API allows only a few calls per few minutes per account, shared with Claude Code. Next try in ${left ?? 'a moment'}.`;
        }
        case 'network':
            return `Network error: ${error.message}`;
        default:
            return `Could not fetch usage: ${error.message}`;
        }
    }

    _onMenuToggled(open) {
        if (this._menuTickId) {
            GLib.source_remove(this._menuTickId);
            this._menuTickId = 0;
        }
        if (!open)
            return;
        this._render();
        // Refresh on open only when the data is older than the interval.
        const interval = this._settings.get_int('refresh-interval') * 1000;
        if (Date.now() - this._state.fetchedAt > interval)
            this._schedule(0);
        this._menuTickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MENU_TICK_SECONDS, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._timerId)
            GLib.source_remove(this._timerId);
        if (this._menuTickId)
            GLib.source_remove(this._menuTickId);
        this._timerId = this._menuTickId = 0;
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._http.abort();
        this._http = null;
        super.destroy();
    }
});

export default class AiMeterExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // Plain data (last values, timestamps) kept across disable()/enable()
        // on purpose: the lock screen disables the extension, and a fetch on
        // every unlock would eat the rate limit shared with Claude Code.
        this._pollState ??= newPollState();
        this._addIndicator();
        this._positionId = this._settings.connect('changed::panel-position', () => {
            this._removeIndicator();
            this._addIndicator();
        });
    }

    disable() {
        if (this._positionId) {
            this._settings.disconnect(this._positionId);
            this._positionId = 0;
        }
        this._removeIndicator();
        this._settings = null;
    }

    _addIndicator() {
        this._indicator = new Indicator(this, this._settings, this._pollState);
        Main.panel.addToStatusArea(this.uuid, this._indicator, this._settings.get_int('panel-position'), 'right');
    }

    _removeIndicator() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
