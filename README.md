# openclaw-agent-status

An OpenClaw plugin that exposes `GET /v1/agents/status` — a live status endpoint showing all configured agents, when they were last active, and what they're currently doing.

Use this to monitor your agent team remotely from anywhere: phone, terminal, ClawTalk, or any HTTP client.

## Response format

```json
{
  "object": "list",
  "data": [
    {
      "id": "elysse",
      "name": "Elysse",
      "status": "active",
      "last_active": "2026-03-18T02:30:00.000Z",
      "last_active_ago_seconds": 120,
      "current_task": "Reviewing PR #45"
    },
    {
      "id": "max",
      "name": "Max",
      "status": "idle",
      "last_active": "2026-03-18T02:15:00.000Z",
      "last_active_ago_seconds": 780,
      "current_task": null
    },
    {
      "id": "clive",
      "name": "Clive",
      "status": "stale",
      "last_active": "2026-03-18T01:00:00.000Z",
      "last_active_ago_seconds": 5400,
      "current_task": null
    }
  ]
}
```

**Status values:**
- `active` — last message within 5 minutes
- `idle` — last message within 30 minutes
- `stale` — no activity for >30 minutes

## Installation

```bash
mkdir -p ~/.openclaw/extensions/agent-status
cp index.ts ~/.openclaw/extensions/agent-status/
cp openclaw.plugin.json ~/.openclaw/extensions/agent-status/
```

Add to `openclaw.json`:
```json
"plugins": {
  "allow": ["agent-status"],
  "entries": { "agent-status": { "enabled": true } }
}
```

Restart OpenClaw, then test:
```bash
curl http://localhost:18789/v1/agents/status \
  -H "Authorization: Bearer <your-token>"
```

## Remote access

Pair with [openclaw-network-setup](https://github.com/sinkers/openclaw-network-setup) (Tailscale or Cloudflare Tunnel) to query from anywhere:

```bash
curl https://your-openclaw.example.com/v1/agents/status \
  -H "Authorization: Bearer <your-token>"
```
