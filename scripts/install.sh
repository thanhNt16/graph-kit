#!/bin/sh
# GraphKit installer — `curl -fsSL <raw-url>/scripts/install.sh | sh`
#
# Detects os/arch, downloads the matching release tarball, and swaps it in
# atomically (no blanket `rm -rf` of the install dir). Never uses sudo: point
# GK_BIN_DIR at a root-owned dir yourself if that's what you want.
#
# Env overrides:
#   GK_BIN_DIR   install directory (default: $HOME/.local/bin)
#   GK_VERSION   release tag (default: latest)
set -eu

REPO="thanhNt16/graph-kit"
GK_BIN_DIR="${GK_BIN_DIR:-$HOME/.local/bin}"
GK_VERSION="${GK_VERSION:-latest}"

die() { printf 'gk-install: %s\n' "$1" >&2; exit 1; }

# --- platform detection -----------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) die "unsupported OS '$OS' — download a tarball manually from https://github.com/$REPO/releases" ;;
esac
case "$ARCH" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) die "unsupported architecture '$ARCH' — download a tarball manually from https://github.com/$REPO/releases" ;;
esac

# --- resolve the release ----------------------------------------------------
if [ "$GK_VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/gk-$os-$arch.tar.gz"
else
  url="https://github.com/$REPO/releases/download/$GK_VERSION/gk-$os-$arch.tar.gz"
fi

# --- download + swap --------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf 'gk-install: downloading %s\n' "$url"
curl -fsSL "$url" -o "$TMP/gk.tar.gz" || die "download failed — check your network or the release tag"
tar -xzf "$TMP/gk.tar.gz" -C "$TMP" || die "extraction failed"

[ -f "$TMP/gk" ] || die "tarball did not contain a gk binary — release layout changed?"

mkdir -p "$GK_BIN_DIR"
# Move any previous install aside first, then swap: `tar -xz` overlays and never
# removes files a newer release dropped, which is how stale kit files survive.
if [ -e "$GK_BIN_DIR/gk" ] || [ -e "$GK_BIN_DIR/share/gk" ]; then
  OLD="$TMP/old"
  mkdir -p "$OLD"
  mv "$GK_BIN_DIR/gk" "$OLD/gk" 2>/dev/null || true
  mv "$GK_BIN_DIR/share/gk" "$OLD/gk-share" 2>/dev/null || true
fi
mv "$TMP/gk" "$GK_BIN_DIR/gk"
if [ -d "$TMP/share" ]; then
  mkdir -p "$GK_BIN_DIR/share"
  mv "$TMP/share/gk" "$GK_BIN_DIR/share/gk"
fi
chmod +x "$GK_BIN_DIR/gk"

# --- PATH check (never edit rc files unasked) -------------------------------
case ":$PATH:" in
  *":$GK_BIN_DIR:"*) ;;
  *)
    printf 'gk-install: %s is not on your PATH — add this to your shell rc:\n' "$GK_BIN_DIR" >&2
    printf '  export PATH="%s:$PATH"\n' "$GK_BIN_DIR" >&2
    ;;
esac

"$GK_BIN_DIR/gk" --version
printf 'gk-install: installed into %s — run `gk init` in a project, then `gk doctor`\n' "$GK_BIN_DIR"
