// The widgets of the dropdown and the top bar: a cairo bar and one meter row.
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatDuration, formatResetClock} from './usage.js';

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
export const Bar = GObject.registerClass(
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
export const MeterItem = GObject.registerClass(
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
