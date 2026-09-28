# Pi Live

Pi Live adds host-local voice conversation to an existing Pi coding session.
Voice and coding have separate lifetimes and permissions.

## Language

**Pi session**:
The coding conversation and its branch history. Ending voice does not end its
admitted coding work.
_Avoid_: Call, voice session

**Voice call**:
One explicitly consented voice conversation using the execution host's microphone
and speakers. It cannot silently reconnect or move to another terminal.
_Avoid_: Pi session

**Call attempt**:
One requested start, including consent and setup, whether or not it reaches an
active voice call. A later attempt requires fresh consent.

**Call generation**:
The identity of one call attempt, used to distinguish its effects from those of
stopped or later attempts.
_Avoid_: Pi run ID

**Call ownership**:
The exclusive right of one cooperating Pi Live invocation to run a call under
one operating-system account's certified canonical local home. It is not ownership of the
microphone against other applications or users.

**Muted call**:
An active voice call whose microphone capture and outgoing samples are stopped.
Speaker playback can continue; muted does not mean silent.

**Releasing call**:
A call attempt whose voice resources are confirmed stopped but whose ownership
release has not yet settled. New calls in the same Pi process remain refused
until it settles, including after reload.
_Avoid_: Blocked call, active voice call

**Blocked call**:
A call attempt with unconfirmed resource shutdown past its allowed wait,
uncertain ownership acquisition, or a confirmed ownership failure. Its Pi process
cannot start another call, even if late resource cleanup later succeeds.
_Avoid_: Off, retryable failure, releasing call

**Coding delegation**:
A voice request sent into the existing Pi conversation. Pi handles it alongside
other input. Stopping voice does not stop Pi work.

**Browser mode**:
A voice call started with `/live browser`, whose handoffs are routed per request
to browser delegation or coding delegation. The choice holds for that call only.
_Avoid_: Browser call, browser session

**Web task**:
A browser-mode request needing more than one browser action or a judgment,
such as comparing, reading or filling a form. It becomes a coding delegation
that Pi handles with `live_browser` at low thinking.
_Avoid_: Multi-step command

**Browser sidecar**:
The Chrome and voice-browser processes launched together by
`scripts/browser-sidecar.sh`. Pi Live offers to start one after confirmation and
owns it until Pi session shutdown (quitting Pi, `/new`, `/resume`, `/fork` or
`/reload`), across voice calls. A controller already running is reused without
taking ownership. A Pi crash leaves the sidecar running.

**Codex browser server**:
The MCP server in `src/mcp.ts` that gives Codex the `live_browser` actions and
refusals as its `browser` tool, on the same Chrome. When none answers at a
`127.0.0.1` address, it starts one on the sidecar's profile and owns it until Codex closes the server; a Chrome
already running is reused without taking ownership. It plays no part in Pi Live
calls.
_Avoid_: Codex browser mode

**Browser delegation**:
A single-step voice request in a browser-mode call, sent to a separately running
voice-browser controller instead of Pi. The controller decides and acts; voice
relays its observed outcome. Web tasks needing more than one step, and requests
the controller refuses or fails, become coding delegations that Pi handles with
its `live_browser` tool at low thinking. Stopping voice does not
undo browser actions.
_Avoid_: Coding delegation

**Home certification**:
Setup's evidence that a particular canonical account home is suitable local
storage for Pi Live ownership. A resolved pathname alone is not certification.
`/live setup` writes it as `setup.json` in the state directory, naming the home
and state directory identities it checked on a local disk.
