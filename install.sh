#!/bin/sh
# GraphKit installer: curl -fsSL https://raw.githubusercontent.com/thanhNt16/graph-kit/main/install.sh | sh
set -eu

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS/$ARCH" in
  Darwin/arm64) ASSET=gk-darwin-arm64.tar.gz ;;
  Linux/x86_64) ASSET=gk-linux-x64.tar.gz ;;
  *)
    echo "graph-kit: no prebuilt release for $OS/$ARCH (available: darwin-arm64, linux-x64)" >&2
    exit 1
    ;;
esac

BIN="$HOME/.local/bin"
mkdir -p "$BIN"
# The tarball holds `gk` plus `share/gk/kits/` beside it; tar overlays and never
# removes files a newer release dropped, so clear both paths first.
rm -rf "$BIN/gk" "$BIN/share"

echo "Installing graph-kit ($ASSET) to $BIN ..."
curl -# -fL "https://github.com/thanhNt16/graph-kit/releases/latest/download/$ASSET" | tar -xz -C "$BIN"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    echo "NOTE: $BIN is not on your PATH. Add to your shell rc:"
    echo "  export PATH=\"$BIN:\$PATH\""
    ;;
esac

"$BIN/gk" --version
echo "Next: cd into a project and run 'gk init' (add --target cursor|opencode|codex|pi)."
