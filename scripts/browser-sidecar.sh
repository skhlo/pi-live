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
# TYPESAFE_API_KEY        Jev key (or JEV_API_KEY), from the environment or
# SIDECAR_KEY_FILE        an env file holding one of them
#                         (default: the checkout's .env, if present)
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
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$key_file" |
    head -n 1 | sed -E 's/[[:space:]]+#.*$//' | tr -d '"'"'"'\r' | sed 's/[[:space:]]*$//'
}

key="${TYPESAFE_API_KEY:-${JEV_API_KEY:-}}"
key_file="${SIDECAR_KEY_FILE:-$(dirname "$0")/../.env}"
if [ -z "$key" ] && { [ -n "${SIDECAR_KEY_FILE:-}" ] || [ -e "$key_file" ]; }; then
  [ -f "$key_file" ] && [ -r "$key_file" ] || {
    echo "key file is not a readable file: $key_file" >&2
    exit 1
  }
  key="$(key_from_file TYPESAFE_API_KEY)"
  [ -n "$key" ] || key="$(key_from_file JEV_API_KEY)"
fi
[ -n "$key" ] || {
  echo "set TYPESAFE_API_KEY or JEV_API_KEY, in the environment, the checkout's .env or SIDECAR_KEY_FILE" >&2
  exit 1
}

chrome="${SIDECAR_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$chrome" ] || {
  echo "Chrome executable is missing: $chrome" >&2
  exit 1
}
profile="${SIDECAR_CHROME_PROFILE:-${XDG_CACHE_HOME:-$HOME/.cache}/pi-live/browser-profile}"
mkdir -p "$profile"
chrome_pid=
voice_browser_pid=
cleanup() {
  # Wait for both children so the caller can await this script's shutdown.
  kill $voice_browser_pid $chrome_pid 2>/dev/null || true
  wait $voice_browser_pid $chrome_pid 2>/dev/null || true
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
