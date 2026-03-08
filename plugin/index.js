import fs from "node:fs"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"

let sharedClient = null

const swarmState = new Map()
const workerReports = new Map()
const DEFAULT_BASE_PROMPT = `You are a small helper model.\nBe concise and practical.\nOnly return details when asked.\nUse the report tool to send short summaries.`

const DEFAULT_AGENTS_PROMPT = `# AGENTS.md\n\n## Purpose\nYou are the main agent for CTF tasks on the user's server. You orchestrate work, review results from small agents, and produce the final solution and write-up.\n\n## Core rules\n- Use small agents for reconnaissance and specialist subtasks. Delegate early.\n- After solving each task, document the full solution in README.md.\n- When you obtain a flag, share it with the user and ask for feedback before proceeding.\n\n## Dependencies\n- Use uv add to add dependencies, uv remove to remove them, uv run to run files.\n- If uv isn't installed, run curl -LsSf https://astral.sh/uv/install.sh | sh then source the env:\n  - sh/bash/zsh: source $HOME/.local/bin/env\n  - fish: source $HOME/.local/bin/env.fish\n\n## SecLists\n- SecLists are in $SECLISTS.\n- Check $SECLISTS/README.md for useful paths.\n\n## Category rules\nFollow category-specific rules strictly.\n\n### Reverse and PWN\n- Use ida-pro-mcp.\n- For pwn, use uv add pwntools.\n- Inspect decompilation and add comments with findings.\n- Rename variables and functions to be descriptive; adjust types if needed.\n- If more detail is necessary, disassemble and add comments with findings.\n- Never convert number bases manually; use Python for conversions.\n- Do not brute-force; derive solutions from disassembly and simple scripts.\n\n### Web and Pentest\n- Do not brute-force manually with curl or custom Python; prefer ffuf and feroxbuster.\n- Pipeline: nmap -sV -sC, searchsploit <service> <version>, uv add sploitscan, sploitscan <CVE>.\n- For exploits, implement payloads in a Python script rather than invoking exploit tools directly.\n\n### Crypto\n- Favor symbolic reasoning and Python scripts; use sage or sympy via uv add when available.\n- Never brute-force large keyspaces; look for mathematical weaknesses.\n- Document assumptions, equations, and scripts in README.md.\n\n### Forensics\n- Capture timestamps, hashes, and metadata during acquisition before analysis.\n- Use uv add volatility-framework or other tools; follow their official docs for plugins.\n- Automate repetitive extraction with Python helpers for reproducible results.\n`

const DEFAULT_SMALL_PROMPT = `# SMALL_AGENTS.md\n\nYou are a small helper model working for the main agent on CTF tasks.\n\n## Behavior\n- Be concise and practical. Minimize verbosity.\n- Do not produce final solutions or flags unless explicitly asked.\n- Use tools freely; cost is not a concern for you.\n- Keep answers short and structured: findings, evidence, next steps.\n\n## Reporting\n- When you finish a subtask, call swarm_report with a 3-7 line summary.\n- Include concrete evidence: commands run, key outputs, file paths, hashes, or URLs.\n- If you need input from the main agent, ask a direct question in the report.\n\n## Constraints\n- Follow category-specific rules from the main agent.\n- Do not brute-force unless explicitly instructed.\n\n## Preferred format for report\n\n1) What I did\n2) Key findings\n3) Evidence (commands/output/paths)\n4) Suggested next step\n`

const normalize = (value) => (value ?? "").toString().trim().toLowerCase()

const getFields = (result) => {
  if (!result) return {}
  if (typeof result === "object" && "data" in result && result.data) return result.data
  return result
}

const extractText = (parts) => {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

const matchBest = (input, items, fields) => {
  const needle = normalize(input)
  if (!needle) return null

  let exact = null
  let prefix = null
  let partial = null

  for (const item of items) {
    for (const field of fields) {
      const value = normalize(item?.[field])
      if (!value) continue
      if (value === needle) {
        exact = item
        break
      }
      if (!prefix && value.startsWith(needle)) {
        prefix = item
      }
      if (!partial && value.includes(needle)) {
        partial = item
      }
    }
    if (exact) break
  }

  return exact ?? prefix ?? partial
}

const readSmallAgentsPrompt = (worktree) => {
  const filePath = path.join(worktree, "SMALL_AGENTS.md")
  if (!fs.existsSync(filePath)) return DEFAULT_BASE_PROMPT
  const content = fs.readFileSync(filePath, "utf8").trim()
  return content.length ? content : DEFAULT_BASE_PROMPT
}

const ensureAgentFiles = (worktree) => {
  if (!worktree || worktree === "/") return
  let stats = null
  try {
    stats = fs.statSync(worktree)
  } catch (error) {
    return
  }
  if (!stats.isDirectory()) return

  const agentsPath = path.join(worktree, "AGENTS.md")
  const smallPath = path.join(worktree, "SMALL_AGENTS.md")

  try {
    if (!fs.existsSync(agentsPath)) {
      fs.writeFileSync(agentsPath, DEFAULT_AGENTS_PROMPT, "utf8")
    }
    if (!fs.existsSync(smallPath)) {
      fs.writeFileSync(smallPath, DEFAULT_SMALL_PROMPT, "utf8")
    }
  } catch (error) {
    return
  }
}

const resolveProviderModel = async (providerInput, modelInput) => {
  if (!sharedClient) throw new Error("Swarm plugin not initialized")
  const result = await sharedClient.config.providers()
  const data = getFields(result)
  const providers = data.providers ?? []

  const providerMatch = matchBest(providerInput, providers, ["id", "name", "label"])
  if (!providerMatch) {
    throw new Error(`Provider not found: ${providerInput}`)
  }

  const models = providerMatch.models ?? []
  const modelMatch = matchBest(modelInput, models, ["id", "name", "label"])
  if (!modelMatch) {
    throw new Error(`Model not found in provider '${providerMatch.id ?? providerMatch.name}': ${modelInput}`)
  }

  return {
    providerID: providerMatch.id ?? providerMatch.name,
    modelID: modelMatch.id ?? modelMatch.name,
    providerName: providerMatch.name ?? providerMatch.id,
    modelName: modelMatch.name ?? modelMatch.id,
  }
}

const getSwarmKey = (providerID, modelID) => `${providerID}::${modelID}`

const getWorkerPool = (sessionID, swarmKey) => {
  if (!swarmState.has(sessionID)) swarmState.set(sessionID, new Map())
  const sessionPools = swarmState.get(sessionID)
  if (!sessionPools.has(swarmKey)) sessionPools.set(swarmKey, [])
  return sessionPools.get(swarmKey)
}

const setWorkerReport = (sessionID, workerSessionID, report) => {
  if (!workerReports.has(sessionID)) workerReports.set(sessionID, new Map())
  workerReports.get(sessionID).set(workerSessionID, report)
}

const getWorkerReport = (sessionID, workerSessionID) => {
  if (!workerReports.has(sessionID)) return null
  return workerReports.get(sessionID).get(workerSessionID)
}

const ensureWorkers = async ({
  sessionID,
  providerID,
  modelID,
  count,
  basePrompt,
}) => {
  const swarmKey = getSwarmKey(providerID, modelID)
  const pool = getWorkerPool(sessionID, swarmKey)

  while (pool.length < count) {
    const index = pool.length + 1
    const title = `swarm-${providerID}-${modelID}-${index}`
    const session = getFields(
      await sharedClient.session.create({
        body: { title },
      }),
    )
    const workerSessionID = session.id ?? session.info?.id
    if (!workerSessionID) throw new Error("Failed to create swarm worker session")

    await sharedClient.session.prompt({
      path: { id: workerSessionID },
      body: {
        noReply: true,
        model: { providerID, modelID },
        parts: [
          {
            type: "text",
            text: `${basePrompt}\n\nYou are worker #${index}. Remember prior tasks from this session.\nWhen you finish a task, call the report tool with a concise summary.`,
          },
        ],
      },
    })

    pool.push({ sessionID: workerSessionID, index })
  }

  return pool.slice(0, count)
}

const sendWorkerTask = async ({ worker, providerID, modelID, task, mainSessionID }) => {
  await sharedClient.session.prompt({
    path: { id: worker.sessionID },
    body: {
      model: { providerID, modelID },
      parts: [
        {
          type: "text",
          text: `Task from the main model:\n${task}\n\nIf you finish, call the report tool. Do not send the final answer directly unless asked.`,
        },
        {
          type: "text",
          text: `Main session id: ${mainSessionID}`,
        },
      ],
    },
  })
}

const parsePlan = (plan) => {
  if (plan === undefined || plan === null || plan === "") {
    throw new Error("plan is required")
  }
  let data = plan
  if (typeof data === "string") {
    try {
      data = JSON.parse(data)
    } catch (error) {
      throw new Error("plan must be valid JSON")
    }
  }
  if (!data || typeof data !== "object") {
    throw new Error("plan must be an object")
  }
  const tasks = data.tasks
  if (!tasks || typeof tasks !== "object") {
    throw new Error("plan.tasks must be an object mapping worker indexes to tasks")
  }
  const waitFor = Array.isArray(data.waitFor) ? data.waitFor : []
  return { tasks, waitFor }
}

const selectWorkers = (pool, tasks) => {
  const selected = []
  for (const [key, task] of Object.entries(tasks)) {
    const index = Number(key)
    if (!Number.isFinite(index) || index < 1 || index > pool.length) {
      throw new Error(`Invalid worker index in plan: ${key}`)
    }
    if (typeof task !== "string" || !task.trim()) {
      throw new Error(`Task for worker ${key} must be a non-empty string`)
    }
    selected.push({ worker: pool[index - 1], task: task.trim() })
  }
  return selected
}

const formatReports = (reports, providerName, modelName) => {
  if (!reports.length) {
    return `Swarm reports (${providerName}/${modelName}):\nNo reports yet.`
  }

  const text = reports
    .map((report) => {
      const summary = report.summary?.trim() || "(no summary)"
      return `#${report.index}: ${summary}`
    })
    .join("\n\n")

  return `Swarm reports (${providerName}/${modelName}):\n\n${text}`
}



export const SwarmPlugin = async ({ client }) => {
  sharedClient = client

  return {
    event: async ({ event }) => {
      if (event?.type === "session.created") {
        const worktree = event?.properties?.worktree
        if (worktree) ensureAgentFiles(worktree)
      }
    },
    tool: {
      swarm: tool({
        description:
          "Dispatch tasks to small models based on a plan and collect their reports.",
        args: {
          provider: tool.schema.string().describe("Provider name or id"),
          model: tool.schema.string().describe("Model name or id"),
          count: tool.schema
            .number()
            .int()
            .min(1)
            .max(10)
            .describe("How many workers to spawn"),
          plan: tool.schema
            .any()
            .describe(
              "Plan object: { tasks: { [index]: string }, waitFor?: number[] }",
            ),
        },
        async execute(args, context) {
          ensureAgentFiles(context.worktree ?? context.directory)
          const { provider, model, count, plan } = args
          const { providerID, modelID, providerName, modelName } =
            await resolveProviderModel(provider, model)

          const { tasks, waitFor } = parsePlan(plan)
          const workers = await ensureWorkers({
            sessionID: context.sessionID,
            providerID,
            modelID,
            count,
            basePrompt: readSmallAgentsPrompt(context.worktree ?? context.directory),
          })

          const assignments = selectWorkers(workers, tasks)

          await Promise.all(
            assignments.map(({ worker, task }) =>
              sendWorkerTask({
                worker,
                providerID,
                modelID,
                task,
                mainSessionID: context.sessionID,
              }),
            ),
          )

          const indicesToWait = Array.isArray(waitFor) && waitFor.length
            ? waitFor
            : assignments.map(({ worker }) => worker.index)

          const reports = assignments
            .filter(({ worker }) => indicesToWait.includes(worker.index))
            .map(({ worker }) => {
              const report = getWorkerReport(context.sessionID, worker.sessionID)
              if (!report) return null
              return { index: worker.index, summary: report.summary }
            })
            .filter(Boolean)

          return formatReports(reports, providerName, modelName)
        },
      }),
      swarm_report: tool({
        description:
          "Workers call this to send a short report back to the main model.",
        args: {
          mainSessionID: tool.schema
            .string()
            .describe("Session id of the main model"),
          summary: tool.schema.string().describe("Short summary of results"),
        },
        async execute(args, context) {
          const { mainSessionID, summary } = args
          setWorkerReport(mainSessionID, context.sessionID, {
            summary: summary.trim(),
            timestamp: Date.now(),
          })
          return "Report stored."
        },
      }),
    },
  }
}
