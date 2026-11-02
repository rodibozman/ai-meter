import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {newPollState, pollTiming} from './polling.js';
import {Indicator} from './indicator.js';

export default class AiMeterExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        // Three numbers kept across disable()/enable(), see pollTiming().
        this._timing = pollTiming(newPollState());
    }

    enable() {
        this._settings = this.getSettings();
        this._pollState = newPollState(this._timing);
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
        this._timing = pollTiming(this._pollState);
        this._pollState = null;
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
