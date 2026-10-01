# Data sharing and consent

What leaves the machine, to whom, and the consent and dialog rules.

Voice runs on OpenAI's GPT-Live API (`gpt-live-1`), billed to the OpenAI API
key Pi uses for its `openai` provider. Audio, speech transcripts, the conversation
leading to each request, progress notes (Pi's narration and tools used, including
typed work), and Pi's final replies are shared with OpenAI. While Pi works, voice
receives short quiet progress notes; when Pi finishes, voice summarizes its reply
aloud. HTTP/WebSocket proxy settings do not establish WebRTC/ICE media proxying.
In browser mode, each spoken request and the current page URL and title are also
sent to TypeSafe's Jev model for routing when a TypeSafe key is set, and page
content read through `live_browser` reaches OpenAI through Pi.

Consent identifies the execution host, OpenAI GPT-Live, microphone and speakers,
the conversation, progress and reply sharing, and proxy limitations. Reported non-live extension dialogs fence
voice when their delayed notification arrives. Shortcut-opened and unreported
nested dialogs can leave voice active; stop voice before opening them when
capture and delivery must stop. Voice never answers or grants an approval.
