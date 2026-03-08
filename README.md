# opencode-swarm-plugin

Adds a `/swarm` command and a `swarm` tool for OpenCode. The command forces the main model to delegate work to small models and return their results without solving the task itself.

## Usage

1) Create a `SMALL_AGENTS.md` file in the project root where you run `opencode`.

2) Run the command:

```text
/swarm "GPT-5 Mini" "Copilot Pool" 5
```

Arguments:

- MODEL_NAME: model name or id to match
- PROVIDER_NAME: provider name or id to match
- COUNT: number of workers to spawn (1-10)
- The plan for which workers do what is created by the main model and sent via the `swarm` tool.
- Workers only send back short summaries via `swarm_report`.

## Install (local)

```bash
bash scripts/install.sh
```

## Notes

- Each worker gets its own session, so it keeps a private history.
- The base prompt is loaded from `SMALL_AGENTS.md` per project.

## Uninstall

Remove these files:

- `~/.config/opencode/plugins/opencode-swarm.js`
- `~/.config/opencode/commands/swarm.md`
```
