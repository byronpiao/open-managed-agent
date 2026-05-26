#!/usr/bin/env bash
# install.sh — clone, build, and link magent from source
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/royhyang/cloudbase-managed-agent/main/install.sh | bash
#
# What it does:
#   1. Checks node/npm are available
#   2. Clones the repo to ~/.magent
#   3. Runs npm install
#   4. Runs npm link (creates global `magent` command)
#
# Environment overrides:
#   MAGENT_DIR    install location  (default: $HOME/.magent)
#   MAGENT_REF    git ref to check out (default: main)

set -euo pipefail

REPO="https://github.com/royhyang/cloudbase-managed-agent.git"
INSTALL_DIR="${MAGENT_DIR:-$HOME/.magent}"
REF="${MAGENT_REF:-main}"

# ── Colours ───────────────────────────────────────────────────────────────────
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  BOLD="$(tput bold)"; GREEN="$(tput setaf 2)"; YELLOW="$(tput setaf 3)"
  RED="$(tput setaf 1)"; CYAN="$(tput setaf 6)"; DIM="$(tput dim)"; RESET="$(tput sgr0)"
else
  BOLD="" GREEN="" YELLOW="" RED="" CYAN="" DIM="" RESET=""
fi

info()  { echo "${BOLD}${GREEN}▶${RESET} $*"; }
warn()  { echo "${BOLD}${YELLOW}⚠${RESET}  $*"; }
err()   { echo "${BOLD}${RED}✗${RESET}  $*" >&2; exit 1; }
step()  { echo "  ${DIM}$*${RESET}"; }

echo
echo "${BOLD}magent installer${RESET}"
echo "────────────────────────────────────────"
echo

# ── Prerequisites ─────────────────────────────────────────────────────────────
command -v git  >/dev/null 2>&1 || err "git is required. Install it first."
command -v node >/dev/null 2>&1 || err "Node.js is required.\n  Install from https://nodejs.org or via nvm:\n  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
command -v npm  >/dev/null 2>&1 || err "npm is required (ships with Node.js)."

NODE_VERSION="$(node -e 'process.stdout.write(process.versions.node)')"
NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  warn "Node.js v$NODE_VERSION — v18+ recommended. Upgrade: nvm install --lts"
fi

info "node $NODE_VERSION  npm $(npm -v)"
echo

# ── Clone / update ────────────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing install at $INSTALL_DIR ..."
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" checkout "$REF"
  git -C "$INSTALL_DIR" pull --ff-only origin "$REF" 2>/dev/null || true
else
  if [ -d "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR exists but is not a git repo — removing."
    rm -rf "$INSTALL_DIR"
  fi
  info "Cloning $REPO → $INSTALL_DIR ..."
  git clone --depth 1 --branch "$REF" "$REPO" "$INSTALL_DIR"
fi

echo

# ── Install dependencies ──────────────────────────────────────────────────────
info "Installing dependencies..."
cd "$INSTALL_DIR"
npm install

echo

# ── Build SDK (TypeScript) ────────────────────────────────────────────────────
info "Building SDK..."
npm run build:sdk 2>/dev/null || true

echo

# ── Link globally ─────────────────────────────────────────────────────────────
info "Linking magent globally (npm link)..."
npm link

echo

# ── Verify ────────────────────────────────────────────────────────────────────
if command -v magent >/dev/null 2>&1; then
  echo "${BOLD}${GREEN}✅ magent installed successfully!${RESET}"
  echo
  echo "  ${CYAN}$(command -v magent)${RESET}"
  echo
  echo "  Quick start:"
  step "magent --help"
  step "magent login"
  step "magent agent:list -e <envId>"
  echo
  echo "  To update later:"
  step "cd $INSTALL_DIR && git pull && npm install && npm link"
else
  warn "npm link completed but 'magent' not found in PATH."
  echo
  echo "  This usually means npm's global bin is not in PATH."
  echo "  Try adding this to your shell profile:"
  echo
  NPM_PREFIX="$(npm prefix -g)"
  echo "    export PATH=\"${NPM_PREFIX}/bin:\$PATH\""
  echo
fi

echo "────────────────────────────────────────"
echo "${BOLD}Source:${RESET} $INSTALL_DIR"
echo "${BOLD}Docs:${RESET}   https://github.com/royhyang/cloudbase-managed-agent#readme"
echo
