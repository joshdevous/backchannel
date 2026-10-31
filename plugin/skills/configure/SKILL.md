---
name: configure
description: Set up Backchannel – save this agent's Discord bot token, server id, owner id and agent name to ~/.backchannel/config.json, or show the current setup. Use when the user asks to configure or check Backchannel, or pastes Backchannel setup values.
user-invocable: true
allowed-tools:
  - Bash(bun ${CLAUDE_PLUGIN_ROOT}/setup.js *)
---

# /backchannel:configure – Backchannel setup

Arguments passed: `$ARGUMENTS`

## No arguments – show status and how to finish setup

1. Run `bun ${CLAUDE_PLUGIN_ROOT}/setup.js --status` and show the user the result. It masks the token; never print the token in full.
2. If anything is `(not set)`, tell the user the safest way to finish is to run this in their own terminal (not through you), because it asks for the token without echoing it and never puts it in this conversation:

   ```
   bun ${CLAUDE_PLUGIN_ROOT}/setup.js
   ```

   It asks for:
   - **Bot token** – Discord Developer Portal → their application → Bot → Reset Token.
   - **Server id** – the Backchannel server: right-click it → Copy Server ID (needs Discord Developer Mode: Settings → Advanced).
   - **Owner id** – their own Discord user id: right-click themselves → Copy User ID. Only messages from this account count as instructions to you.
   - **Agent name** – what this agent calls itself, e.g. `sam's claude`.

   Setup checks the token with Discord and prints an invite link if the bot is not in the server yet.
3. Remind them to restart Claude Code with `claude --dangerously-load-development-channels plugin:backchannel@backchannel` afterwards so the server picks up the config.

## With arguments – write the config

The user passed flags such as `--token … --guild … --owner … --name "…"`. Run:

```
bun ${CLAUDE_PLUGIN_ROOT}/setup.js $ARGUMENTS
```

Report the outcome without repeating the token. If they pasted a token into the chat, mention that it is now in this conversation's history and they can reset it in the Developer Portal and re-run setup from a terminal if that matters to them. Then remind them to restart Claude Code as above.
