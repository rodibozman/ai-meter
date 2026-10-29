#!/bin/sh
# Installs AI Meter for the current user. Works from a clone of the repo
# (./install.sh) or piped from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/rodibozman/ai-meter/main/install.sh | sh
set -eu

UUID="ai-meter@rodibozman.github.io"
REPO="rodibozman/ai-meter"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

say() { printf '%s\n' "$*"; }
die() { say "error: $*" >&2; exit 1; }

command -v gnome-shell >/dev/null 2>&1 || die "gnome-shell not found: this extension is for GNOME Shell (Ubuntu's default desktop)."
command -v glib-compile-schemas >/dev/null 2>&1 || die "glib-compile-schemas not found: install it with 'sudo apt install libglib2.0-dev-bin' (Ubuntu) or your distro's equivalent."

# Where do the sources come from?
here="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || here=""
tmp=""
if [ -n "$here" ] && [ -f "$here/src/metadata.json" ]; then
    src="$here/src"
else
    command -v curl >/dev/null 2>&1 || die "curl not found."
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    say "Downloading $REPO (main)..."
    curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$tmp"
    src="$tmp/ai-meter-main/src"
    [ -f "$src/metadata.json" ] || die "download did not contain src/metadata.json"
fi

# Shell version check (warn only).
shell_major="$(gnome-shell --version 2>/dev/null | sed -n 's/^GNOME Shell \([0-9]*\).*/\1/p')"
if [ -n "$shell_major" ] && ! grep -q "\"$shell_major\"" "$src/metadata.json"; then
    say "warning: GNOME Shell $shell_major is not listed in metadata.json; the extension may refuse to load."
fi

# Install (replace any previous copy of this very extension).
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$src" "$DEST"
glib-compile-schemas "$DEST/schemas"
say "Installed to $DEST"

if command -v gnome-extensions >/dev/null 2>&1; then
    if gnome-extensions enable "$UUID" 2>/dev/null; then
        say "Enabled $UUID"
    else
        say "Run 'gnome-extensions enable $UUID' after your next login."
    fi
fi

if [ "${XDG_SESSION_TYPE:-}" = "x11" ]; then
    say "Restart GNOME Shell to load it: press Alt+F2, type r, press Enter."
else
    say "Log out and back in to load it (GNOME Shell on Wayland cannot reload extensions live)."
fi
