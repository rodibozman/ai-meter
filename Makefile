UUID := ai-meter@rodibozman.github.io
DIST := dist
ZIP  := $(DIST)/$(UUID).shell-extension.zip

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

schema:
	glib-compile-schemas --strict src/schemas

test:
	gjs -m test/parse.js

clean:
	rm -rf $(DIST) src/schemas/gschemas.compiled
