# Neiro AI Mobs

**Living AI settlements for Minecraft Bedrock Dedicated Server**

Most addons give mobs scripts. Neiro AI Mobs gives them a **mind** — powered by a local LLM via Ollama.

Mobs talk, hold roles, build and repair houses, follow daily schedules, hand out quests, run night raids between village and monster city, and react to the world (hits, fire, etc.) without relying on chat.

**Pack version:** 0.5.0  
**Bridge version:** 0.1.0

---

## Features

### Living settlements
- On first join of a fresh world, a **friendly village** and a **monster city** are generated automatically (houses, mobs, roles)
- Roles: elder, guards, builders, friends of humans / gang leader, raiders
- Golems
- House and wall repairs
- Night raids (village ↔ monster city)
- Gang leader orders
- Quests from the witch / elder
- Daily schedules
- Reactions to hits, fire and other events (no chat spam)

### AI conversation
- Local bridge to Ollama (default model: `qwen3:14b`)
- Per-character and faction memory
- Chat commands and dialogue via `!talk`

---

## Requirements

| Component | Purpose |
|-----------|---------|
| **Minecraft Bedrock Dedicated Server** | Server |
| **Ollama** + model (recommended: `qwen3:14b`) | Local LLM |
| **Node.js ≥ 18** | Run the AI bridge |
| **Beta APIs / GameTest** experiment | Required in the world |

Minimum engine version: `1.26.0`

---

## Quick start

1. Install [Ollama](https://ollama.com) and pull a model:
   ```bash
   ollama pull qwen3:14b