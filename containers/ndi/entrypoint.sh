#!/bin/sh
# NDI bridge entrypoint — verifies NDI Library presence (downloads if license URL set).
set -e

if [ -z "$NDI_SDK_URL" ]; then
    echo "wave-ndi-bridge: NDI_SDK_URL unset — running in adapter-only mode (no protocol path)"
else
    : "${NDI_SDK_SHA256:?NDI_SDK_URL set but NDI_SDK_SHA256 missing}"
    DEST=/usr/local/lib/libndi.so
    if [ ! -f "$DEST" ]; then
        echo "wave-ndi-bridge: fetching NDI Library from $NDI_SDK_URL"
        curl -fsSL -o "$DEST.tmp" "$NDI_SDK_URL"
        actual=$(sha256sum "$DEST.tmp" | awk '{print $1}')
        if [ "$actual" != "$NDI_SDK_SHA256" ]; then
            echo "wave-ndi-bridge: SHA256 mismatch (got=$actual expected=$NDI_SDK_SHA256)" >&2
            rm -f "$DEST.tmp"
            exit 1
        fi
        mv "$DEST.tmp" "$DEST"
        ldconfig
    fi
fi

exec "$@"
