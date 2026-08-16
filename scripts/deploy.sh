#!/bin/sh
# Sync the plugin's runtime files into the web profile's installed copy.
# Usage: scripts/deploy.sh   (then restart the DSH desktop app)
#
# When the profile installs this package as a link/symlink to the workspace
# (the usual `dsh plugin --profile web add /path/to/dsh-input-history` layout),
# the files are already in place and this script is a no-op safety net.
set -eu

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web/node_modules/dsh-input-history}"

if [ ! -d "$DEST" ]; then
	echo "not installed at $DEST — run: dsh plugin --profile web add $SRC" >&2
	exit 1
fi

cp "$SRC/package.json" "$DEST/package.json"
cp "$SRC/cordis.patch.yml" "$DEST/cordis.patch.yml"
cp "$SRC/lib/index.js" "$DEST/lib/index.js"
cp "$SRC/lib/client.js" "$DEST/lib/client.js"

echo "deployed to $DEST — restart the DSH desktop app and refresh the page"
