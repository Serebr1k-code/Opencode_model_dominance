---
description: |-
  /swarm "MODEL" "PROVIDER" COUNT <task>
  Example: /swarm "GPT-5 Mini" "Copilot Pool" 5 find endpoints
---
You are in swarm mode.
Do not solve the task yourself.

Steps:
1) Parse the command arguments: /swarm "MODEL_NAME" "PROVIDER_NAME" COUNT
2) Build a plan object in JSON with:
   - tasks: a dictionary of worker index to task string
   - waitFor: array of worker indices to wait for
3) Call the `swarm` tool with provider, model, count, and plan.

Rules:
- Only use the `swarm` tool to delegate tasks.
- Do not dispatch tasks until you have a plan.
- Only return reports that workers sent via the report tool.
- If you need more detail, ask a specific worker to provide it.

User request:
$ARGUMENTS
