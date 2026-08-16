# let-me-explain — VS Code button

One status-bar button: **"I'm done"**. It appears only while a `let-me-try` is waiting on you,
and clicking it hands your work back to Claude for review.

Everything else works without this extension — the tutorial always carries a checkbox you can
tick, and `let-me-explain done` works from any terminal. This just turns two keystrokes into one
click.

## Install

```bash
cd vscode-extension
npm install
npm run package          # produces let-me-explain-0.1.0.vsix
code --install-extension let-me-explain-0.1.0.vsix
```

## How it finds the daemon

It polls `GET /active` on the daemon every 2 seconds, reading the port and token from the same
file the CLI uses (`$XDG_RUNTIME_DIR/let-me-explain/daemon.json`).

Polling rather than a socket, because the daemon may not be running, may restart, and gets a
fresh port each time — a 2 s poll of a loopback endpoint costs nothing and needs no reconnection
logic. When the daemon is absent the button simply stays hidden; that is a normal state, not an
error worth showing.

The path and discovery rules are duplicated from the main package's `src/core/paths.ts` and `src/core/discovery.ts`
rather than imported, because this is a separate build targeting the VS Code runtime. **They have
to stay in step with those files.**
