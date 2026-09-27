#!/bin/bash
# Starts a visible Chrome with its own profile and voice-browser attached to it
# over DevTools, for `/live browser`. Then start Pi in another terminal with the
# same key, from this checkout (or elsewhere with -e <pi-live checkout>/index.ts):
#   PI_LIVE_BROWSER_CDP=http://127.0.0.1:9333 pi
#
# Only this script reads these; Pi reads the key from its own environment.
# VOICE_BROWSER_DIR       voice-browser checkout with dependencies installed
#                         (github.com/moritzkremb/jev-voice-browser)
# TYPESAFE_API_KEY        Jev key (or JEV_API_KEY), from the environment or
# SIDECAR_KEY_FILE        an optional env file holding one of them
# SIDECAR_CHROME          Chrome binary (default: Google Chrome on macOS)
# SIDECAR_CHROME_PROFILE  Chrome profile
#                         (default: ${XDG_CACHE_HOME:-~/.cache}/pi-live/browser-profile)
# Ctrl+C stops voice-browser and Chrome.
set -euo pipefail

cdp_port=9333
cdp_url="http://127.0.0.1:$cdp_port"

voice_browser_dir="${VOICE_BROWSER_DIR:-}"
[ -n "$voice_browser_dir" ] && [ -f "$voice_browser_dir/src/server.js" ] || {
  echo "set VOICE_BROWSER_DIR to a voice-browser checkout" >&2
  exit 1
}

# Reads NAME=value from an env file: optional `export`, spaces, quotes and a
# trailing ` # comment`.
key_from_file() {
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$SIDECAR_KEY_FILE" |
    head -n 1 | sed -E 's/[[:space:]]+#.*$//' | tr -d '"'"'"'\r' | sed 's/[[:space:]]*$//'
}

key="${TYPESAFE_API_KEY:-${JEV_API_KEY:-}}"
if [ -z "$key" ] && [ -n "${SIDECAR_KEY_FILE:-}" ]; then
  [ -r "$SIDECAR_KEY_FILE" ] || {
    echo "SIDECAR_KEY_FILE is not a readable file: $SIDECAR_KEY_FILE" >&2
    exit 1
  }
  key="$(key_from_file TYPESAFE_API_KEY)"
  [ -n "$key" ] || key="$(key_from_file JEV_API_KEY)"
fi
[ -n "$key" ] || {
  echo "set TYPESAFE_API_KEY or JEV_API_KEY, or SIDECAR_KEY_FILE to a file holding one" >&2
  exit 1
}

chrome="${SIDECAR_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
profile="${SIDECAR_CHROME_PROFILE:-${XDG_CACHE_HOME:-$HOME/.cache}/pi-live/browser-profile}"
mkdir -p "$profile"
"$chrome" \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$cdp_port" \
  --user-data-dir="$profile" --no-first-run --no-default-browser-check \
  --window-size=1280,900 about:blank >"$profile/chrome.log" 2>&1 &
chrome_pid=$!
voice_browser_pid=
trap 'kill $voice_browser_pid "$chrome_pid" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ready=
for _ in $(seq 1 50); do
  if curl -sf "$cdp_url/json/version" >/dev/null; then
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
