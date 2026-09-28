#!/bin/bash
# Starts a visible Chrome with its own profile and voice-browser attached to it
# over DevTools, for `/live browser`. Then start Pi in another terminal with the
# same key, from the trusted root of this checkout (elsewhere, add
# -e <pi-live checkout>/index.ts):
#   PI_LIVE_BROWSER_CDP=http://127.0.0.1:9333 pi
# or with both set in the checkout's .env (see .env.example).
#
# Pi Live can also launch this script after an interactive offer, passing its
# browser settings from the environment or the checkout's .env.
# VOICE_BROWSER_DIR       voice-browser checkout with dependencies installed
#                         (github.com/moritzkremb/jev-voice-browser)
# TYPESAFE_API_KEY        Jev key (or JEV_API_KEY)
# SIDECAR_CHROME          Chrome binary (default: Google Chrome on macOS)
# SIDECAR_CHROME_PROFILE  Chrome profile
#                         (default: ${XDG_CACHE_HOME:-~/.cache}/pi-live/browser-profile)
# SIDECAR_KEY_FILE        env file for the settings above that the
#                         environment leaves unset
#                         (default: the checkout's .env, if present)
# SIDECAR_STOP_SECONDS    how long stopping waits before killing (default: 5)
# Ctrl+C stops voice-browser and Chrome.
set -euo pipefail

cdp_port=9333
cdp_url="http://127.0.0.1:$cdp_port"

key_file="${SIDECAR_KEY_FILE:-$(dirname "$0")/../.env}"

# Reads NAME=value from the env file: optional `export`, spaces, quotes and a
# trailing ` # comment`.
setting_from_file() {
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$key_file" |
    head -n 1 | sed -E 's/[[:space:]]+#.*$//' | tr -d '"'"'"'\r' | sed 's/[[:space:]]*$//'
}

# The environment's value for NAME, else the env file's.
setting() {
  local value="${!1:-}"
  if [ -z "$value" ] && [ -f "$key_file" ] && [ -r "$key_file" ]; then
    value="$(setting_from_file "$1")"
  fi
  printf '%s' "$value"
}

voice_browser_dir="$(setting VOICE_BROWSER_DIR)"
[ -n "$voice_browser_dir" ] && [ -f "$voice_browser_dir/src/server.js" ] || {
  echo "set VOICE_BROWSER_DIR to a voice-browser checkout, in the environment or the env file" >&2
  exit 1
}

key="${TYPESAFE_API_KEY:-${JEV_API_KEY:-}}"
if [ -z "$key" ] && { [ -n "${SIDECAR_KEY_FILE:-}" ] || [ -e "$key_file" ]; }; then
  [ -f "$key_file" ] && [ -r "$key_file" ] || {
    echo "key file is not a readable file: $key_file" >&2
    exit 1
  }
  key="$(setting_from_file TYPESAFE_API_KEY)"
  [ -n "$key" ] || key="$(setting_from_file JEV_API_KEY)"
fi
[ -n "$key" ] || {
  echo "set TYPESAFE_API_KEY or JEV_API_KEY, in the environment, the checkout's .env or SIDECAR_KEY_FILE" >&2
  exit 1
}

chrome="$(setting SIDECAR_CHROME)"
chrome="${chrome:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$chrome" ] || {
  echo "Chrome executable is missing: $chrome" >&2
  exit 1
}
profile="$(setting SIDECAR_CHROME_PROFILE)"
profile="${profile:-${XDG_CACHE_HOME:-$HOME/.cache}/pi-live/browser-profile}"
mkdir -p "$profile"
stop_seconds="${SIDECAR_STOP_SECONDS:-5}"
[[ "$stop_seconds" =~ ^[1-9][0-9]*$ ]] || stop_seconds=5
chrome_pid=
voice_browser_pid=
cleanup() {
  # Stop both children and wait for them, so the caller can await this
  # script's shutdown. Kill any that outlast the bound; Pi's quit waits here.
  local pids=()
  [ -z "$voice_browser_pid" ] || pids+=("$voice_browser_pid")
  [ -z "$chrome_pid" ] || pids+=("$chrome_pid")
  # macOS /bin/bash 3.2 treats an empty "${pids[@]}" as unbound under set -u.
  [ "${#pids[@]}" -gt 0 ] || return 0
  kill "${pids[@]}" 2>/dev/null || true
  for _ in $(seq 1 $((stop_seconds * 10))); do
    kill -0 "${pids[@]}" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "${pids[@]}" 2>/dev/null; then
    echo "browser sidecar: forced to stop after ${stop_seconds}s" >&2
    kill -9 "${pids[@]}" 2>/dev/null || true
  fi
  wait "${pids[@]}" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$chrome" \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$cdp_port" \
  --user-data-dir="$profile" --no-first-run --no-default-browser-check \
  --window-size=1280,900 about:blank >"$profile/chrome.log" 2>&1 &
chrome_pid=$!

ready=
for _ in $(seq 1 50); do
  # Bash defers TERM while a foreground command runs. Bound each request so
  # Pi can stop this script even if DevTools accepts HTTP but never responds.
  if curl --max-time 1 -sf "$cdp_url/json/version" >/dev/null; then
    ready=1
    break
  fi
  kill -0 "$chrome_pid" 2>/dev/null || break
  sleep 0.2
done
[ -n "$ready" ] || {
  echo "Chrome DevTools did not answer at $cdp_url; see $profile/chrome.log:" >&2
  tail -n 5 "$profile/chrome.log" >&2
  exit 1
}

cd "$voice_browser_dir"
TYPESAFE_API_KEY="$key" node src/server.js --port 8787 --cdp "$cdp_url" --start-url https://example.com/ &
voice_browser_pid=$!
wait "$voice_browser_pid"
