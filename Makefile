UUID := ai-meter@rodibozman.github.io
DIST := dist
ZIP  := $(DIST)/$(UUID).shell-extension.zip
TESTS := test/parse.js test/credentials.js test/http.js test/polling.js test/i18n.js

.PHONY: install uninstall zip check lint test schema locale clean

install:
	./install.sh

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf "$${XDG_DATA_HOME:-$$HOME/.local/share}/gnome-shell/extensions/$(UUID)"

# Zip in the layout extensions.gnome.org and `gnome-extensions install` expect.
# No gschemas.compiled: both compile the schema at install time. No .po: the
# translations ship as the JSON of src/locale/.
zip: schema
	rm -rf $(DIST) && mkdir -p $(DIST)
	cd src && zip -qr ../$(ZIP) . -x '*.orig' '*~' 'schemas/gschemas.compiled'
	@echo "wrote $(ZIP)"

check: lint schema test

# eslint at the exact versions of package-lock.json, reinstalled when it changes.
node_modules/.package-lock.json: package-lock.json
	npm ci --ignore-scripts --no-audit --no-fund

lint: node_modules/.package-lock.json
	./node_modules/.bin/eslint .
	@if command -v shellcheck >/dev/null 2>&1; then shellcheck -s sh install.sh; else echo "shellcheck not found, install.sh not checked"; fi

schema:
	glib-compile-schemas --strict src/schemas

# The JSON catalogs the extension reads, from po/. Committed, so that install.sh
# and the zip need no build step; make test fails when they are out of date.
locale:
	gjs -m tools/build-locale.js

test:
	@for t in $(TESTS); do echo "== $$t"; gjs -m $$t || exit 1; done

clean:
	rm -rf $(DIST) src/schemas/gschemas.compiled
