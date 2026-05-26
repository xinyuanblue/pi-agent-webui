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

## Feishu Bridge

The server can also run a Feishu bot bridge that forwards approved Feishu messages to Pi agent sessions.

Copy `.env.example` to `.env`, fill the Feishu app credentials, then start the server normally:

```bash
npm run dev
```

Optional settings:

```bash
FEISHU_DOMAIN=feishu              # feishu or lark
FEISHU_REQUIRE_MENTION=true       # group chats only respond to @bot by default
FEISHU_ALLOWED_USERS=*            # development only; allow everyone
FEISHU_DEBUG=true                 # verbose SDK logs
```

Required Feishu app setup:

- Enable Bot capability.
- Subscribe to `im.message.receive_v1`.
- Use WebSocket long connection mode in the Feishu developer console.
- Grant message send/receive permissions for the scenarios you need.

Status endpoint:

```text
http://localhost:4317/api/feishu/status
```

Implemented behavior:

- WebSocket long connection through the official Feishu/Lark Node SDK
- Direct-message bot replies
- Group replies only when the bot is mentioned
- User allowlist by Feishu `open_id`
- Independent Pi sessions per Feishu DM, group user, or thread
- Serial execution inside the same Feishu session
- Final Pi output replied back to Feishu after completion

## What Works

- Chat prompt submission through the Pi SDK
- Streaming assistant text over Server-Sent Events
- Tool start/end status display
- Model switching from the WebUI, using authenticated models from Pi
- Current-project session history list with click-to-switch
- Create a new session from the sidebar
- Abort current run
- Feishu WebSocket bridge for approved users
- Continue using Pi's existing model, settings, sessions, skills, extensions, and auth discovery
- Chinese UI by default

## Notes

This is intentionally a local development UI. It has no authentication layer, so do not expose it directly to the public internet.
