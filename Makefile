UUID := ai-meter@rodibozman.github.io
DIST := dist
ZIP  := $(DIST)/$(UUID).shell-extension.zip
TESTS := test/parse.js test/credentials.js test/http.js test/polling.js

.PHONY: install uninstall zip check lint test schema clean

install:
	./install.sh

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf "$${XDG_DATA_HOME:-$$HOME/.local/share}/gnome-shell/extensions/$(UUID)"

# Zip in the layout extensions.gnome.org and `gnome-extensions install` expect.
zip: schema
	rm -rf $(DIST) && mkdir -p $(DIST)
	cd src && zip -qr ../$(ZIP) . -x '*.orig' '*~'
	@echo "wrote $(ZIP)"

check: lint schema test

lint:
	npx --yes eslint@9 .
	@if command -v shellcheck >/dev/null 2>&1; then shellcheck -s sh install.sh; else echo "shellcheck not found, install.sh not checked"; fi

schema:
	glib-compile-schemas --strict src/schemas

test:
	@for t in $(TESTS); do echo "== $$t"; gjs -m $$t || exit 1; done

clean:
	rm -rf $(DIST) src/schemas/gschemas.compiled
