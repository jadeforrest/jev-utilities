#!/bin/bash
# Build the CLI and install bin/jev-categorize as a symlink in $PREFIX/bin
# (default ~/.local/bin). A symlink, so a rebuild here is live; the bin finds
# node itself, so it also runs under launchd's minimal PATH.
#   ./install.sh              build, then create the link; never replaces anything else
#   ./install.sh --uninstall  remove the link, only if it points here
set -eu
here="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/bin/jev-categorize"
dest="${PREFIX:-$HOME/.local}/bin/jev-categorize"
linked() { [ "$(readlink "$dest" 2>/dev/null)" = "$src" ]; }

case "${1:-}" in
    --uninstall)
        if linked; then rm "$dest"; echo "removed $dest"
        else echo "not installed from here, left alone: $dest"; fi ;;
    "")
        [ -d "$here/node_modules" ] || npm --prefix "$here" ci
        npm --prefix "$here" run build --silent
        if linked; then echo "already installed: $dest"; exit 0; fi
        if [ -e "$dest" ] || [ -L "$dest" ]; then
            echo "refusing to replace existing $dest" >&2; exit 1
        fi
        mkdir -p "$(dirname "$dest")"
        ln -s "$src" "$dest"; echo "installed $dest -> $src" ;;
    *) echo "usage: $0 [--uninstall]" >&2; exit 2 ;;
esac
