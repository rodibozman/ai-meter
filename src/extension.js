import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {newPollState, pollTiming} from './polling.js';
import {Indicator} from './indicator.js';
import {pickLanguage, loadCatalog, setCatalog} from './i18n.js';

export default class AiMeterExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        // Three numbers kept across disable()/enable(), see pollTiming().
        this._timing = pollTiming(newPollState());
    }

    enable() {
        this._settings = this.getSettings();
        this._pollState = newPollState(this._timing);
        this._indicator = null;
        this._languageCancellable = null;
        this._positionId = this._settings.connect('changed::panel-position', () => {
            if (this._indicator)
                this._replaceIndicator();
        });
        this._languageId = this._settings.connect('changed::language', () => this._loadLanguage());
        this._loadLanguage();
    }

    disable() {
        this._settings.disconnect(this._positionId);
        this._positionId = 0;
        this._settings.disconnect(this._languageId);
        this._languageId = 0;
        this._languageCancellable.cancel();
        this._languageCancellable = null;
        if (this._indicator)
            this._removeIndicator();
        setCatalog(new Map());
        this._timing = pollTiming(this._pollState);
        this._pollState = null;
        this._settings = null;
    }

    // The indicator is built once the texts of the language are read, and
    // built again when the language setting changes, so that every label
    // is in the new language. A load still running is cancelled.
    async _loadLanguage() {
        this._languageCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._languageCancellable = cancellable;
        const lang = pickLanguage(this._settings.get_string('language'), GLib.get_language_names());
        let catalog;
        try {
            catalog = await loadCatalog(this.path, lang, cancellable);
        } catch (e) {
            if (cancellable.is_cancelled())
                return;
            console.warn(`[ai-meter] cannot read the ${lang} translation, using English: ${e.message}`);
            catalog = new Map();
        }
        if (cancellable.is_cancelled())
            return;
        setCatalog(catalog);
        this._replaceIndicator();
    }

    _replaceIndicator() {
        if (this._indicator)
            this._removeIndicator();
        this._indicator = new Indicator(this, this._settings, this._pollState);
        Main.panel.addToStatusArea(this.uuid, this._indicator, this._settings.get_int('panel-position'), 'right');
    }

    _removeIndicator() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
