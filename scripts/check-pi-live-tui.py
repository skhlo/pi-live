"""Real Pi/TUI PTY checks, with the production adapter and fake media/provider."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

REPO = Path(__file__).resolve().parent.parent
POLICY = "(version 1) (allow default) (deny network*)"
CASES = ["cancel", "late", "controls", "shortcut-no", "shortcut-cancel", "task-stop", "conversation", "sidecar"] + [
    f"{kind}-{answer}"
    for kind, answers in {
        "confirm": ["yes", "no", "cancel"], "select": ["beta", "cancel"],
        "input": ["text", "cancel"], "editor": ["text", "cancel"],
        "custom": ["text", "cancel"],
    }.items() for answer in answers
]


def run(case):
    root = REPO / "preview" / "issue-5-checks" / f"tui-{case}-{time.time_ns()}"
    root.mkdir(parents=True)
    for name in ("home", "agent", "work", "tmp", "xdg"):
        (root / name).mkdir(mode=0o700)
    env = {
        "HOME": str(root / "home"), "PI_CODING_AGENT_DIR": str(root / "agent"),
        "TMPDIR": str(root / "tmp"), "XDG_CONFIG_HOME": str(root / "xdg"),
        "PI_LIVE_FIXTURE_ROOT": str(root), "PATH": "/opt/homebrew/bin:/usr/bin:/bin",
        "TERM": "xterm-256color", "LANG": "en_US.UTF-8", "PI_OFFLINE": "1",
        "PI_TELEMETRY": "0", "PI_SKIP_VERSION_CHECK": "1",
    }
    if case == "sidecar":
        env["PI_LIVE_SIDECAR_FIXTURE"] = "1"
    argv = ["/usr/bin/sandbox-exec", "-p", POLICY, "/opt/homebrew/bin/node", "--no-addons", str(REPO / "scripts/pi-live-tui-probe.ts")]
    (root / "command.json").write_text(json.dumps({"argv": argv, "env": env}, indent=2))
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(root / "work")
        os.execve(argv[0], argv, env)
    os.set_blocking(master, False)
    raw = bytearray()
    def drain():
        while select.select([master], [], [], 0)[0]:
            try:
                data = os.read(master, 65536)
                if not data:
                    break
                raw.extend(data)
            except (BlockingIOError, OSError):
                break
    def pause(seconds=.15):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            drain()
            time.sleep(.02)
    def events():
        file = root / "events.jsonl"
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []
    def wait(kind, after=0, timeout=10):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            drain()
            found = [e for e in events()[after:] if e["type"] == kind]
            if found:
                return found[-1]
            time.sleep(.02)
        raise AssertionError(f"{case}: missing {kind}; events={events()[-4:]}; screen={bytes(raw[-1500:])!r}")
    def key(text):
        os.write(master, text.encode() if isinstance(text, str) else text)
    def command(text):
        key(text + "\r")
    def state():
        before = len(events())
        command("/fixture state")
        return wait("state", before)
    def size(columns):
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, columns, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    def start(shortcut=False):
        before = len(events())
        if shortcut:
            key(b"\x1b[76;6u")
        else:
            command("/live start")
        prompt = wait("prompt-start", before)
        assert prompt["title"] == "Start Pi Live voice?"
        pause()
        key("\r")
        wait("prompt-end", before)
        pause()
        assert state()["state"] == "active"
    try:
        size(100)
        wait("ready", timeout=15)
        pause(.4)
        if case == "sidecar":
            command("/live browser")
            prompt = wait("prompt-start")
            assert prompt["title"] == "Start the browser sidecar?"
            assert prompt["resourcesCreated"] == 0 and prompt["sidecarStarts"] == 0
            pause()
            key("\r")
            started = wait("sidecar-start")
            assert started["resourcesCreated"] == 0
            pause()
            assert b"Start Pi Live voice in browser mode?" in raw
            key("\r")
            pause()
            assert state()["state"] == "active"
            command("/live stop")
            pause()
            stopped = state()
            assert stopped["state"] == "off" and stopped["sidecarStops"] == 0
            before = len(events())
            command("/live browser")
            prompt = wait("prompt-start", before)
            assert prompt["title"] == "Start Pi Live voice in browser mode?"
            pause()
            key("\r")
            pause()
            assert state()["state"] == "active"
            command("/live stop")
            pause()
            key("\x04")
            # InteractiveMode exits the process after dispatching shutdown.
            disposed = wait("sidecar-stop")
            assert disposed["sidecarStarts"] == 1 and disposed["sidecarStops"] == 1
            assert b"third-party voice-browser" in raw and b"TypeSafe key" in raw
            screen = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", bytes(raw))
            screen = re.sub(rb"\x1b\][^\x07]*\x07", b"", screen)
            assert b"until this Pi session ends" in b" ".join(screen.split())
            (root / "screen.txt").write_bytes(screen)
            (root / "receipt.json").write_text(json.dumps({"case": case, "passed": True, "final": disposed}, indent=2))
            print(f"PASS {case}: {root}", flush=True)
            return
        elif case in ("cancel", "late"):
            if case == "late":
                command("/fixture late")
                wait("late-armed")
            command("/live help")
            pause()
            command("/live start")
            wait("prompt-start")
            pause()
            key("\r" if case == "late" else "\x1b")
            wait("prompt-end")
            pause()
            current = state()
            assert current["state"] == "off" and current["resourcesCreated"] == 0 and current["timers"] == 0
        elif case == "controls":
            start(shortcut=True)
            command("/fixture speech")
            wait("speech")
            for width in [38, 120, 60, 100]:
                size(width)
                pause()
            key("ordinary draft-é 你好 🙂 Space Escape Ctrl+C")
            pause()
            before = len(events())
            key(b"\x1b[74;6u")
            assert wait("editor-draft", before)["text"] == "ordinary draft-é 你好 🙂 Space Escape Ctrl+C"
            key("\x15")
            pause()
            command("/live mute")
            pause()
            assert state()["muted"]
            command("/live unmute")
            pause()
            assert not state()["muted"]
            key(b"\x1b[76;6u")
            pause()
            assert state()["state"] == "off"
        elif case.startswith("shortcut-"):
            start()
            before = len(events())
            key(b"\x1b[75;6u")
            pending = wait("shortcut-pending", before)
            assert pending["state"] == "active" and pending["captured"] > 0
            assert not any(e["type"] == "prompt-start" for e in events()[before:])
            key("\x1b[B\r" if case.endswith("no") else "\x1b")
            result = wait("shortcut-result", before)
            assert result["result"] is False and result["state"] == "active"
            command("/live stop")
            pause()
            assert state()["state"] == "off"
        elif case == "conversation":
            start()
            before = len(events())
            command("/fixture task")
            wait("tool-start", before)
            command("/fixture followup")
            command("Typed clarification while Pi is working")
            settled = wait("agent-settled", before)
            assert settled["state"] == "active"
            for text in ["Voice follow-up while Pi is working", "Typed clarification while Pi is working"]:
                assert any(text in context for context in settled["inputs"]), text
            assert any('"delegation_id":"terminal-two"' in frame and 'session.commentary.append' in frame for frame in settled["framesContent"])
            command("/live stop")
            pause()
        elif case == "task-stop":
            start()
            command("/fixture task")
            wait("tool-start")
            command("/live stop")
            pause()
            current = state()
            assert current["state"] == "off"
            wait("tool-end")
            settled = wait("agent-settled")
            assert settled["frames"] == current["frames"]
            assert not any("session.commentary.append" in frame for frame in settled["framesContent"])
        else:
            kind, answer = case.split("-")
            start()
            before = len(events())
            command("/fixture " + kind)
            prompt = wait("prompt-start", before)
            assert prompt["kind"] == kind and prompt["state"] != "active"
            assert prompt["captured"] == prompt["before"]
            pause()
            if answer == "cancel":
                key("\x1b")
            elif kind == "confirm":
                key("\x1b[B\r" if answer == "no" else "\r")
            elif kind == "select":
                key("\x1b[B\r")
            elif kind == "custom":
                key("x")
            else:
                key("typed-é\r")
            result = wait("dialog-result", before)
            expected = {"confirm": answer == "yes", "select": "Beta", "custom": "x", "input": "typed-é", "editor": "initialtyped-é"}[kind]
            if answer == "cancel":
                expected = False if kind == "confirm" else None
            assert result["result"] == expected, result
            pause()
        current = state()
        assert current["state"] == "off" and current["timers"] == 0, current
        drain()
        assert b"Start Pi Live voice?" in raw
        assert b"OpenAI GPT-Live" in raw
        (root / "receipt.json").write_text(json.dumps({"case": case, "passed": True, "final": current}, indent=2))
        print(f"PASS {case}: {root}", flush=True)
    finally:
        try:
            key("\x04")
        except OSError:
            pass  # The sidecar case already quit normally.
        pause(.3)
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if not done:
                os.kill(pid, signal.SIGTERM)
                os.waitpid(pid, 0)
        except ProcessLookupError:
            pass
        drain()
        (root / "pty.raw").write_bytes(raw)
        os.close(master)


for selected in CASES if sys.argv[1:] == ["all"] else sys.argv[1:] or ["cancel"]:
    run(selected)
