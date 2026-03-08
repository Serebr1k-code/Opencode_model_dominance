import fs from "node:fs"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"

let sharedClient = null

const swarmState = new Map()
const workerReports = new Map()
const DEFAULT_BASE_PROMPT = `You are a small helper model.\nBe concise and practical.\nOnly return details when asked.\nUse the report tool to send short summaries.`


const normalize = (value) => (value ?? "").toString().trim().toLowerCase()

const getFields = (result) => {
  if (!result) return {}
  if (typeof result === "object" && "data" in result && result.data) return result.data
  return result
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
  if (!worktree) return DEFAULT_BASE_PROMPT
  const filePath = path.join(worktree, "SMALL_AGENTS.md")
  if (!fs.existsSync(filePath)) return DEFAULT_BASE_PROMPT
  const content = fs.readFileSync(filePath, "utf8").trim()
  return content.length ? content : DEFAULT_BASE_PROMPT
}


const toArray = (value) => {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object") return Object.values(value)
  return []
}

const resolveProviderModel = async (providerInput, modelInput) => {
  if (!sharedClient) throw new Error("Swarm plugin not initialized")
  const result = await sharedClient.config.providers()
  const data = getFields(result)
  const providers = toArray(data.providers)
  if (!providers.length) {
    throw new Error("No providers available from config")
  }

  const providerMatch = matchBest(providerInput, providers, ["id", "name", "label"])
  if (!providerMatch) {
    throw new Error(`Provider not found: ${providerInput}`)
  }

  const models = toArray(providerMatch.models)
  if (!models.length) {
    throw new Error(`No models available for provider '${providerMatch.id ?? providerMatch.name}'`)
  }

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
      throw new Error(
        "plan must be valid JSON string, e.g. {\"tasks\":{\"1\":\"...\"},\"waitFor\":[1]}",
      )
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
  if (!selected.length) {
    throw new Error("Plan tasks were empty; nothing to dispatch")
  }
  return selected
}

const formatReports = (reports, providerName, modelName) => {
  if (!reports.length) {
    throw new Error(
      `No swarm reports received yet (${providerName}/${modelName}). ` +
        "Workers must call swarm_report before results can be returned.",
    )
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
