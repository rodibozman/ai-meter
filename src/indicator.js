// The top-bar button, its dropdown and the polling loop that feeds them.
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    fetchUsage, CredentialsWatcher, defaultCredentialsPath, formatDuration, USER_AGENT,
} from './usage.js';
import {
    severity, fetchWait, retryAfterError, isCredentialsError, initialDelay,
} from './polling.js';
import {Bar, MeterItem} from './meter.js';

const MENU_TICK_SECONDS = 30;
// Delay between a write of the credentials file and the fetch it triggers,
// so the several events of one write give a single fetch.
const CREDENTIALS_SETTLE_SECONDS = 1;

export const Indicator = GObject.registerClass(
class AiMeterIndicator extends PanelMenu.Button {
    _init(extension, settings, state) {
        super._init(0.5, 'AI Meter', false);
        this._extension = extension;
        this._settings = settings;
        this._http = new Soup.Session({timeout: 15, user_agent: USER_AGENT});
        // Cancelled by destroy(): stops a fetch under way and tells its
        // caller not to touch the destroyed indicator.
        this._cancellable = new Gio.Cancellable();
        this._timerId = 0;
        this._menuTickId = 0;
        // Shared with the extension and any indicator created after this one.
        this._state = state;
        this._refreshing = false;
        this._credentialsWatcher = null;
        // Set when the credentials file changes during a fetch.
        this._credentialsChanged = false;

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
            settings.connect('changed::credentials-path', () => {
                this._watchCredentials();
                this._schedule(0);
            }),
            settings.connect('changed', () => this._render()),
        ];
        this.menu.connect('open-state-changed', (_m, open) => this._onMenuToggled(open));

        this._watchCredentials();
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

    _watchCredentials() {
        this._credentialsWatcher?.destroy();
        this._credentialsWatcher = null;
        try {
            this._credentialsWatcher = new CredentialsWatcher(this._credentialsPath(), () => this._onCredentialsChanged());
        } catch (e) {
            // Not fatal: a new login is still seen at the next refresh.
            console.warn(`[ai-meter] cannot watch the credentials file: ${e.message}`);
        }
    }

    // Claude Code renews its token (it lasts 8 hours) only when it runs, so
    // after a night off the meter shows `expired` until it does: fetch as
    // soon as the file is rewritten instead of at the next refresh. Only
    // while the last fetch failed on the login, so a working meter makes no
    // extra calls.
    _onCredentialsChanged() {
        if (this._refreshing) {
            this._credentialsChanged = true;
            return;
        }
        if (!isCredentialsError(this._state.error))
            return;
        // That wait was only there to see a new login; the minimum gap stays.
        this._state.nextTry = 0;
        this._schedule(CREDENTIALS_SETTLE_SECONDS);
    }

    _schedule(seconds) {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
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
        if (this._refreshing)
            return;
        const now = Date.now();
        const wait = fetchWait(this._state, now);
        if (wait > 0) {
            // Too soon (manual refresh spam, or a Retry-After still running).
            this._schedule(Math.ceil(wait / 1000));
            return;
        }
        this._refreshing = true;
        this._credentialsChanged = false;
        this._state.lastAttempt = now;
        this._render();
        const cancellable = this._cancellable;
        let next;
        try {
            const {usage, plan} = await fetchUsage(this._http, this._credentialsPath(), cancellable);
            Object.assign(this._state, {usage, plan, error: null, fetchedAt: Date.now(), nextTry: 0, backoff: 0});
            next = this._settings.get_int('refresh-interval');
        } catch (e) {
            // destroy() cancelled the fetch (disable, lock screen, position
            // change): not an error worth a log line or a retry.
            if (cancellable.is_cancelled())
                return;
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
        if (this._credentialsChanged && isCredentialsError(this._state.error)) {
            // The file was rewritten while this fetch used the old login.
            this._state.nextTry = 0;
            next = CREDENTIALS_SETTLE_SECONDS;
        }
        this._render();
        this._schedule(next);
    }

    _thresholds() {
        return [this._settings.get_int('warn-threshold'), this._settings.get_int('crit-threshold')];
    }

    _render() {
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
            return 'Claude Code login expired. Open Claude Code (run `claude` in a terminal) to renew it; the meter picks it up as soon as it does.';
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
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._menuTickId) {
            GLib.source_remove(this._menuTickId);
            this._menuTickId = 0;
        }
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._credentialsWatcher?.destroy();
        this._credentialsWatcher = null;
        this._cancellable.cancel();
        this._cancellable = null;
        this._http.abort();
        this._http = null;
        super.destroy();
    }
});
