#!/bin/sh
# GraphKit installer: curl -fsSL https://raw.githubusercontent.com/thanhNt16/graph-kit/main/install.sh | sh
# Fast path: npm/bun global install (~1MB). Fallback: standalone binary tarball (22-39MB, no runtime needed).
# Force the binary: GRAPHKIT_INSTALL=binary sh install.sh
set -eu

install_npm() {
  if command -v bun >/dev/null 2>&1; then
    echo "Installing graphkit-gk via bun ..."
    if bun add -g graphkit-gk 2>&1; then
      return 0
    fi
    echo "bun add failed; falling back to npm/binary ..." >&2
  fi
  if command -v npm >/dev/null 2>&1; then
    echo "Installing graphkit-gk via npm ..."
    if npm install -g graphkit-gk 2>&1; then
      return 0
    fi
    echo "npm install failed; falling back to binary ..." >&2
  fi
  return 1
}

install_binary() {
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
}

if [ "${GRAPHKIT_INSTALL:-auto}" = "binary" ]; then
  install_binary
elif ! install_npm; then
  echo "No bun/npm found; falling back to standalone binary ..."
  install_binary
fi

if ! command -v gk >/dev/null 2>&1; then
  echo "gk installed but not on PATH - open a new shell or add the install dir to PATH." >&2
  exit 0
fi
gk --version
echo "Next: cd into a project and run 'gk init' (add --target cursor|opencode|codex|pi)."
