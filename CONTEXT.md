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

**Blocked call**:
A call attempt whose cleanup or ownership release could not be established.
Its Pi process cannot start another call, even if late cleanup later succeeds.
_Avoid_: Off, retryable failure

**Coding delegation**:
One coding request admitted from voice into the existing Pi session. Stopping
voice prevents subsequent voice delivery, not completion of the coding work.

**Home certification**:
Setup's evidence that a particular canonical account home is suitable local
storage for Pi Live ownership. A resolved pathname alone is not certification.
