# openclaw-agent-status

An OpenClaw plugin that exposes `GET /v1/agents/status` — a live status endpoint showing all configured agents, when they were last active, and what they're currently doing.

Use this to monitor your agent team remotely from anywhere: phone, terminal, ClawTalk, or any HTTP client.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/agents/status` | All configured agents |
| `GET` | `/v1/agents/status/:agentId` | Single agent by ID |

Both endpoints require a gateway Bearer token.

## Response format

### All agents (`GET /v1/agents/status`)

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
      "id": "main",
      "name": "Main",
      "status": "idle",
      "last_active": "2026-03-18T02:15:00.000Z",
      "last_active_ago_seconds": 780,
      "current_task": null
    },
    {
      "id": "alex",
      "name": "Alex",
      "status": "stale",
      "last_active": "2026-03-18T01:00:00.000Z",
      "last_active_ago_seconds": 5400,
      "current_task": null
    }
  ]
}
```

### Single agent (`GET /v1/agents/status/elysse`)

Returns the same object shape as a single entry (not wrapped in a list):

```json
{
  "id": "elysse",
  "name": "Elysse",
  "status": "active",
  "last_active": "2026-03-18T02:30:00.000Z",
  "last_active_ago_seconds": 120,
  "current_task": "Reviewing PR #45"
}
```

Returns `404` if the agent ID is not found.

## Response fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Agent identifier |
| `name` | string | Display name (from `identity.name`, `name`, or capitalized `id`) |
| `status` | `"active"` \| `"idle"` \| `"stale"` | Activity status |
| `last_active` | ISO 8601 string \| `null` | Timestamp of last session activity |
| `last_active_ago_seconds` | number \| `null` | Seconds since last activity |
| `current_task` | string \| `null` | Last assistant reply snippet (≤100 chars), or `null` |

## Status thresholds

| Status | Default | Meaning |
|--------|---------|---------|
| `active` | < 5 min | Recently active |
| `idle` | 5–30 min | No recent activity |
| `stale` | > 30 min | Inactive or never used |

Thresholds are configurable — see [Configuration](#configuration).

## Installation

```bash
mkdir -p ~/.openclaw/extensions/agent-status
cp index.ts ~/.openclaw/extensions/agent-status/
cp openclaw.plugin.json ~/.openclaw/extensions/agent-status/
```

Add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["agent-status"],
    "entries": {
      "agent-status": { "enabled": true }
    }
  }
}
```

Restart OpenClaw, then test:

```bash
curl http://localhost:18789/v1/agents/status \
  -H "Authorization: Bearer <your-token>"
```

## Configuration

Thresholds can be tuned in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "agent-status": {
        "enabled": true,
        "config": {
          "activeThresholdSeconds": 300,
          "idleThresholdSeconds": 1800
        }
      }
    }
  }
}
```

| Config key | Default | Description |
|------------|---------|-------------|
| `activeThresholdSeconds` | `300` | Seconds within which an agent is considered `active` (default: 5 min) |
| `idleThresholdSeconds` | `1800` | Seconds after which an agent becomes `stale` (default: 30 min) |

## Remote access

Pair with [Tailscale](https://tailscale.com) or a Cloudflare Tunnel to query from anywhere:

```bash
curl https://your-openclaw.example.com/v1/agents/status \
  -H "Authorization: Bearer <your-token>"
```

## How it works

- Agent list is read from `api.config.agents.list` — always reflects live `openclaw.json`
- Last active time comes from the session store (`~/.openclaw/agents/<id>/sessions/sessions.json`)
- The most recently updated session is used — whether it's Telegram, Discord, webchat, or heartbeat
- `current_task` scans the tail of the session transcript (JSONL) for the last assistant text reply
- File reads use a seek-to-end approach so large transcripts don't cause slowness

## Requirements

- OpenClaw gateway with HTTP endpoints enabled
- `gateway.http.endpoints.chatCompletions.enabled: true` (or equivalent) in `openclaw.json`
