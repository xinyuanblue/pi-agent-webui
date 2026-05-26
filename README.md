# Pi SDK WebUI

A small local WebUI for `@earendil-works/pi-coding-agent`.

## Run

```bash
npm install --ignore-scripts
npm run dev
```

Open:

```text
http://localhost:4317
```

The server reuses your normal Pi config and auth from `~/.pi/agent`.

## Working Directory

By default, Pi runs in the directory where you start the server. To point the agent at another project:

```bash
PI_WEBUI_CWD=/path/to/project npm run dev
```

You can also change the port:

```bash
PORT=4321 npm run dev
```

## What Works

- Chat prompt submission through the Pi SDK
- Streaming assistant text over Server-Sent Events
- Tool start/end status display
- Model switching from the WebUI, using authenticated models from Pi
- Current-project session history list with click-to-switch
- Create a new session from the sidebar
- Abort current run
- Continue using Pi's existing model, settings, sessions, skills, extensions, and auth discovery
- Chinese UI by default

## Notes

This is intentionally a local development UI. It has no authentication layer, so do not expose it directly to the public internet.
