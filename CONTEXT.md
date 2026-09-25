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

**Home certification**:
Setup's evidence that a particular canonical account home is suitable local
storage for Pi Live ownership. A resolved pathname alone is not certification.
