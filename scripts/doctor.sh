#!/usr/bin/env bash
# Why can't this machine's CodeBuddy ACP child start?
#
# The dsh subagent plugin does NOT need a logged-in CLI: it injects
# CODEBUDDY_API_KEY read from the `envFile` in its own bundle config. Four
# things decide whether that works, and none of them is obvious from the
# harness UI:
#
#   1. the binary must be spawnable from a GUI host's PATH;
#   2. the envFile must exist, be readable, and be non-empty;
#   3. the key must be validated against the RIGHT site — the domestic
#      (copilot.tencent.com) and international (codebuddy.ai) sites reject each
#      other's keys, and the machine's choice of site comes from a cache file
#      that a fresh install does not have;
#   4. the CLI must be able to reach that site at all.
#
# Usage:  bash scripts/doctor.sh
#         bash scripts/doctor.sh --no-run     (skip the live probes)
set -u

RUN_TEST=1
[ "${1:-}" = "--no-run" ] && RUN_TEST=0

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

# macOS ships no `timeout`; coreutils installs it as gtimeout.
TMO=""
if command -v timeout >/dev/null 2>&1; then TMO="timeout 90"
elif command -v gtimeout >/dev/null 2>&1; then TMO="gtimeout 90"
fi

# A GUI-launched harness never has Homebrew on PATH; probe with the PATH the
# plugin now builds for its child, not the one this shell happens to have.
PROBE_PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"

echo "host: $(hostname -s)  user: $(id -un)  home: $HOME  arch: $(uname -m)"
echo "macOS: $(sw_vers -productVersion 2>/dev/null)"

# ---------------------------------------------------------------- 1. binary
hdr "1. codebuddy binary"
BIN="$(command -v codebuddy 2>/dev/null || true)"
for c in /opt/homebrew/bin/codebuddy /usr/local/bin/codebuddy "$HOME/.local/bin/codebuddy"; do
  if [ -x "$c" ]; then
    [ -z "$BIN" ] && BIN="$c"
    ok "present: $c -> $(readlink "$c" 2>/dev/null || echo "$c")"
  fi
done
if [ -n "$BIN" ]; then
  printf '       version: %s\n' "$("$BIN" --version 2>&1 | head -1)"
else
  bad "no codebuddy binary in any of the usual places — install it first"
fi
# The harness's own log is the authority on whether IT can spawn the binary: a
# GUI app's PATH is not this shell's PATH, so guessing is useless.
LOG="$HOME/.dsh/logs/subagent-codebuddy/index.log"
if [ -f "$LOG" ]; then
  STARTS=$(grep -c 'START' "$LOG" 2>/dev/null || echo 0)
  FAILS=$(grep -c 'FAIL' "$LOG" 2>/dev/null || echo 0)
  printf '       harness run log: %s START / %s FAIL\n' "$STARTS" "$FAILS"
  if grep 'FAIL' "$LOG" 2>/dev/null | tail -1 | grep -q 'ENOENT'; then
    bad "the most recent failure was ENOENT — the harness cannot find the binary"
    echo "       This script's probe below uses the PATH the plugin now injects;"
    echo "       if it passes, restart the harness so the new plugin build loads."
  elif [ "$STARTS" -gt "$FAILS" ]; then
    ok "the harness has spawned this binary successfully before — PATH is fine"
  fi
  grep 'FAIL' "$LOG" 2>/dev/null | tail -2 | sed 's/^/       last fail: /'
else
  warn "no run log at $LOG — this machine has never completed a delegation"
fi

# -------------------------------------------------------------- 2. envFile
hdr "2. plugin config -> envFile"
# The row lives in the bundle's OWN cordis.patch.yml; a profile may override
# it. Look only at those files, never recursively: profiles/node_modules holds
# hundreds of linked packages.
CANDIDATES=""
for d in "$HOME"/.dsh/profiles/*/; do
  CANDIDATES="$CANDIDATES$d/node_modules/dsh-subagent-codebuddy/cordis.patch.yml
$d/cordis.patch.yml
$d/cordis.yml
"
done
ENVFILE=""
SITE_ENV=""
SEEN=""
for f in $CANDIDATES; do
  [ -f "$f" ] || continue
  case "$SEEN" in *"|$f|"*) continue ;; esac
  SEEN="$SEEN|$f|"
  raw=$(grep -E '^[^#]*envFile:' "$f" 2>/dev/null | tail -1 | sed -E 's/.*envFile:[[:space:]]*//')
  site=$(grep -E '^[^#]*CODEBUDDY_INTERNET_ENVIRONMENT:' "$f" 2>/dev/null | tail -1 | sed -E 's/.*:[[:space:]]*//' | tr -d "\"' ")
  [ -z "$raw" ] && [ -z "$site" ] && continue
  printf '       %s\n         envFile: %s   site: %s\n' "${f#$HOME/}" "${raw:-（未配置）}" "${site:-（未配置）}"
  [ -z "$ENVFILE" ] && [ -n "$raw" ] && ENVFILE=$(printf '%s' "$raw" | sed -E 's/[[:space:]]+#.*$//' | tr -d "\"'" | sed -E 's/[[:space:]]+$//')
  [ -z "$SITE_ENV" ] && [ -n "$site" ] && SITE_ENV="$site"
done
if [ -z "$ENVFILE" ]; then
  bad "nothing configures envFile — this machine has no file-based key"
  echo "       Every delegation then depends on a CLI login that probably never happened."
fi

if [ -n "$ENVFILE" ]; then
  case "$ENVFILE" in
    /*) ;;
    *) warn "not absolute — the plugin resolves it against the harness launch directory" ;;
  esac
  case "$ENVFILE" in
    "/Users/"*) case "$ENVFILE" in "/Users/$(id -un)/"*) ;; *) bad "names another user's home — wrong path on this machine" ;; esac ;;
  esac
  EXPANDED=$(printf '%s' "$ENVFILE" | sed "s|^~|$HOME|")
  if [ -f "$EXPANDED" ]; then
    ok "exists ($(stat -f%z "$EXPANDED") bytes, mode $(stat -f%Lp "$EXPANDED"), owner $(stat -f%Su "$EXPANDED"))"
    if [ -r "$EXPANDED" ]; then
      N=$(tr -d '[:space:]' < "$EXPANDED" | wc -c | tr -d ' ')
      if [ "$N" -eq 0 ]; then
        bad "file is empty — nothing to inject"
      else
        ok "readable, $N chars, prefix '$(cut -c1-3 "$EXPANDED")'"
      fi
    else
      bad "NOT readable by $(id -un) — chown/chmod it"
    fi
  else
    bad "MISSING: $EXPANDED"
    echo "       The usual cause: a secrets/ directory is skipped by most sync jobs"
    echo "       (rsync --exclude, git-ignored, cloud-drive filters)."
  fi
fi

# ------------------------------------------------------------ 3. site choice
hdr "3. which site the key is validated against"
printf '       config says: %s\n' "${SITE_ENV:-（unset → the CLI decides）}"
CACHE="$HOME/.codebuddy/local_storage"
if [ -d "$CACHE" ] && grep -qlx '"internal"' "$CACHE"/*.info 2>/dev/null; then
  ok "~/.codebuddy remembers the domestic site (marker \"internal\" present)"
  echo "       fix (already in this repo's cordis.patch.yml):"
  echo "         env:"
  echo "           CODEBUDDY_INTERNET_ENVIRONMENT: internal"
elif [ -d "$CACHE" ]; then
  warn "~/.codebuddy exists but never recorded a site choice"
  echo "       That is a deadlock: the CLI only writes the choice after a"
  echo "       successful run, and a domestic key fails on the international"
  echo "       site, so it can never bootstrap itself onto the right one."
  echo "       fix: put this in the row's config —"
  echo "         env:"
  echo "           CODEBUDDY_INTERNET_ENVIRONMENT: internal"
else
  warn "no ~/.codebuddy/local_storage — this machine never ran the desktop app,"
  echo "       so an unset CODEBUDDY_INTERNET_ENVIRONMENT selects the INTERNATIONAL"
  echo "       site (codebuddy.ai) and a domestic ck_ key answers 401 there."
  echo "       fix: put this in the row's config —"
  echo "         env:"
  echo "           CODEBUDDY_INTERNET_ENVIRONMENT: internal"
fi

# ------------------------------------------------------------ 4. live probes
hdr "4. live probe (one tiny prompt)"
if [ "$RUN_TEST" -eq 0 ]; then
  echo "       skipped (--no-run)"
  exit 0
fi
if [ -z "$BIN" ]; then
  bad "cannot probe without the binary"
  exit 1
fi

# probe <label> <key> [extra env assignments]
# Runs scrubbed (env -i) like the plugin does: an embedding app may inject
# CODEBUDDY_GATEWAY_* vars that make the CLI try to host a server instead of
# answering one prompt.
probe() {
  local label="$1" key="$2" extra="${3:-}" out
  out=$(env -i HOME="$HOME" PATH="$PROBE_PATH" TERM=dumb $extra CODEBUDDY_API_KEY="$key" \
    $TMO "$BIN" -p "reply with exactly: ok" 2>&1 | tail -3)
  printf '       [%s] %s\n' "$label" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)" >&2
  case "$out" in
    *"Authentication required"*) echo 1 ; return ;;
    *"401"*) echo 1 ; return ;;
    *ok*) echo 0 ; return ;;
    *) echo 2 ; return ;;
  esac
}

if [ -n "${EXPANDED:-}" ] && [ -r "${EXPANDED:-/nonexistent}" ]; then
  KEY=$(tr -d '[:space:]' < "$EXPANDED")
  R1=$(probe "key, site as configured" "$KEY" "")
  case "$R1" in
    0) ok "key works as configured — the plugin will authenticate this machine" ;;
    *)
      warn "key rejected that way; trying the domestic site explicitly"
      R2=$(probe "key + internal site" "$KEY" "CODEBUDDY_INTERNET_ENVIRONMENT=internal")
      if [ "$R2" -eq 0 ]; then
        bad "the key is valid but this machine was talking to the wrong site"
        echo "       Add to the plugin row (this is already in the repo's cordis.patch.yml):"
        echo "         env:"
        echo "           CODEBUDDY_INTERNET_ENVIRONMENT: internal"
        echo "       then restart the harness so it reloads the config."
      else
        bad "rejected by both sites — the key is expired, revoked, or not a CLI key"
      fi
      ;;
  esac
else
  warn "no readable envFile; probing the CLI's own login state instead"
  R=$(probe "login state" "")
  if [ "$R" -eq 0 ]; then
    ok "this machine has a CLI login — delegations work even without envFile"
  else
    bad "unauthenticated — exactly the failure the plugin reports"
  fi
fi
