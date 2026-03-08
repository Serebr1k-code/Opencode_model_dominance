# Opencode Model Dominance

Adds a `/swarm` command and two tools (`swarm`, `swarm_report`) for OpenCode. The command switches the main model into a delegation-only mode where it creates a plan for small models and waits for their short reports.

## Install (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/Serebr1k-code/Opencode_model_dominance/main/install.sh | bash
```

Restart OpenCode after installation.

## Usage

1) Create a `SMALL_AGENTS.md` file in the project root where you run `opencode`.
   This becomes the base prompt for small models.

2) Run the command and include the task in the same line:

```text
/swarm "GPT-5 Mini" "Copilot Pool" 5 Your task goes here
```

Arguments:

- MODEL_NAME: model name or id to match
- PROVIDER_NAME: provider name or id to match
- COUNT: number of workers to spawn (1-10)

Behavior:

- The main model builds a plan with a task per worker index and which workers to wait for.
- Workers only send back short summaries via the `swarm_report` tool.
- Detailed outputs or code are only produced if the main model asks a worker for them.

## How it works

- `swarm` tool: creates or reuses worker sessions, sends tasks, and returns only the reports workers submitted.
- `swarm_report` tool: called by workers to send a short summary back to the main model.
- Each worker has its own session, so it remembers prior tasks from the main model.

## Install (local)

```bash
bash scripts/install.sh
```

## Uninstall

Remove these files:

- `~/.config/opencode/plugins/opencode-swarm.js`
- `~/.config/opencode/commands/swarm.md`

## License

MIT
