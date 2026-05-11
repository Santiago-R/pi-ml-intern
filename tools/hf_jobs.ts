/**
 * hf_jobs — HF compute job submission & management.
 *
 * Submit Python scripts or Docker containers to HF cloud infrastructure
 * (CPU, GPU, TPU). Supports: run, ps, logs, inspect, cancel, and
 * scheduled job operations.
 *
 * Uses the HF REST API directly (POST/GET /api/jobs/...).
 * Requires HF_TOKEN for authentication. Jobs are billed against the
 * authenticated user's namespace credits.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { fetchWithRetry, ok, err, hfHeaders } from "../utils/api";

const HF_API = "https://huggingface.co/api";

// ── Hardware flavors ──
const CPU_FLAVORS = ["cpu-basic", "cpu-upgrade"] as const;
const GPU_FLAVORS = [
  "t4-small", "t4-medium",
  "a10g-small", "a10g-large", "a10g-largex2", "a10g-largex4",
  "a100-large", "a100x4", "a100x8",
  "l4x1", "l4x4",
  "l40sx1", "l40sx4", "l40sx8",
] as const;
const SPECIALIZED_FLAVORS = ["inf2x6"] as const;

const CPU_FLAVORS_DESC = "cpu-basic(2vCPU/16GB), cpu-upgrade(8vCPU/32GB)";
const GPU_FLAVORS_DESC =
  "t4-small(4vCPU/15GB/GPU 16GB), t4-medium(8vCPU/30GB/GPU 16GB), " +
  "a10g-small(4vCPU/15GB/GPU 24GB), a10g-large(12vCPU/46GB/GPU 24GB), " +
  "a10g-largex2(24vCPU/92GB/GPU 48GB), a10g-largex4(48vCPU/184GB/GPU 96GB), " +
  "a100-large(12vCPU/142GB/GPU 80GB), a100x4(48vCPU/568GB/GPU 320GB), a100x8(96vCPU/1136GB/GPU 640GB), " +
  "l4x1(8vCPU/30GB/GPU 24GB), l4x4(48vCPU/186GB/GPU 96GB), " +
  "l40sx1(8vCPU/62GB/GPU 48GB), l40sx4(48vCPU/382GB/GPU 192GB), l40sx8(192vCPU/1534GB/GPU 384GB)";

const ALL_HARDWARE = [...CPU_FLAVORS, ...GPU_FLAVORS, ...SPECIALIZED_FLAVORS];

// Default Docker image for UV-based Python scripts
const UV_DEFAULT_IMAGE = "ghcr.io/astral-sh/uv:python3.12-bookworm";

// Default environment variables for clean, agent-friendly output
const DEFAULT_ENV: Record<string, string> = {
  HF_HUB_DISABLE_PROGRESS_BARS: "1",
  TQDM_DISABLE: "1",
  TRANSFORMERS_VERBOSITY: "warning",
  HF_HUB_ENABLE_HF_TRANSFER: "1",
  UV_NO_PROGRESS: "1",
};

// ── ANSI strip ──
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// ── Helpers ──

function addDefaultEnv(env?: Record<string, string>): Record<string, string> {
  const result = { ...DEFAULT_ENV };
  if (env) Object.assign(result, env);
  return result;
}

function addSecrets(secrets?: Record<string, string>, hfToken?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (secrets) Object.assign(result, secrets);
  // Inject HF_TOKEN as secret so it's available inside the job
  if (hfToken) {
    result["HF_TOKEN"] = hfToken;
    result["HUGGINGFACE_HUB_TOKEN"] = hfToken;
  }
  return result;
}

/**
 * Build a UV-based command from a script + dependencies.
 * Handles URLs, inline scripts (base64-encoded stdin), and file paths.
 */
function buildUvCommand(
  script: string,
  deps?: string[],
  python?: string,
  scriptArgs?: string[],
): string[] {
  const parts = ["uv", "run"];

  if (deps && deps.length > 0) {
    for (const dep of deps) {
      parts.push("--with", dep);
    }
  }
  if (!deps || !deps.includes("hf-transfer")) {
    parts.push("--with", "hf-transfer");
  }

  if (python) {
    parts.push("-p", python);
  }

  // For URLs: use directly
  if (script.startsWith("http://") || script.startsWith("https://")) {
    parts.push(script);
  } else if (script.includes("\n")) {
    // Inline script: base64-encode and pipe via stdin
    const encoded = Buffer.from(script, "utf-8").toString("base64");
    const uvCmd = parts.join(" ") + " -";
    const scriptArgsStr = scriptArgs ? " " + scriptArgs.join(" ") : "";
    return ["/bin/sh", "-lc", `echo "${encoded}" | base64 -d | ${uvCmd}${scriptArgsStr}`];
  } else {
    // File path
    parts.push(script);
  }

  if (scriptArgs && scriptArgs.length > 0) {
    parts.push(...scriptArgs);
  }

  return parts;
}

// ── API helpers ──

async function apiPost(path: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const res = await fetchWithRetry(`${HF_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

async function apiGet(path: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetchWithRetry(`${HF_API}${path}`, { headers, timeoutMs: 30_000 });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

// ── Formatting helpers ──

function formatJobUrl(job: JobInfo): string {
  const ns = job.owner?.name || "unknown";
  return `https://huggingface.co/jobs/${ns}/${job.id}`;
}

interface JobInfo {
  id: string;
  status?: { stage: string; message?: string };
  createdAt?: string;
  dockerImage?: string;
  command?: string[];
  flavor?: string;
  owner?: { name: string };
  url?: string;
}

function formatJobRow(j: JobInfo): string {
  const status = j.status?.stage ?? "UNKNOWN";
  return `${j.id.slice(0, 12)}  ${status.padEnd(12)}  ${(j.flavor ?? "cpu-basic").padEnd(14)}  ${new Date(j.createdAt ?? "").toISOString().slice(0, 16).replace("T", " ")}`;
}

function formatJobDetails(j: JobInfo): string {
  const lines = [
    `ID:       ${j.id}`,
    `Status:   ${j.status?.stage ?? "UNKNOWN"}${j.status?.message ? " (" + j.status.message + ")" : ""}`,
    `Image:    ${j.dockerImage ?? "N/A"}`,
    `Flavor:   ${j.flavor ?? "N/A"}`,
    `Created:  ${j.createdAt ?? "N/A"}`,
    `URL:      ${j.url ?? formatJobUrl(j)}`,
  ];
  if (j.command) {
    lines.push(`Command:  ${j.command.join(" ")}`);
  }
  return lines.join("\n");
}

// ── Filter UV install output (matches ml-intern) ──
const INSTALL_PATTERN = /^Installed\s+\d+\s+packages?\s+in\s+\d+(?:\.\d+)?\s*(?:ms|s)$/;

function filterUvInstallOutput(logs: string[]): string[] {
  if (!logs.length) return logs;

  for (let i = 1; i < logs.length; i++) {
    if (INSTALL_PATTERN.test(logs[i].trim())) {
      return ["[installs truncated]", ...logs.slice(i)];
    }
  }
  return logs;
}

// ── Tool implementation ──

export function registerHfJobsTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "hf_jobs",
    label: "HF Jobs",
    description:
      "Execute Python scripts or Docker containers on HF cloud infrastructure.\n\n" +
      "Two modes (mutually exclusive): Python mode (script + dependencies) or Docker mode (command + image). " +
      "Provide exactly ONE of 'script' or 'command'.\n\n" +
      "BEFORE submitting training/fine-tuning jobs:\n" +
      "- You MUST have called github_find_examples + github_read_file to find a working reference implementation. " +
      "Scripts based on your internal knowledge WILL use outdated APIs and fail.\n" +
      "- You MUST have validated dataset format via hf_inspect_dataset or hub_repo_details.\n" +
      "- Training config MUST include push_to_hub=True and hub_model_id. " +
      "Job storage is EPHEMERAL — all files are deleted when the job ends. Without push_to_hub, trained models are lost permanently.\n\n" +
      "BATCH/ABLATION JOBS: Submit ONE job first. Check logs to confirm it starts training successfully. " +
      "Only then submit the remaining jobs. Never submit all at once — if there's a bug, all jobs fail.\n\n" +
      "Operations: run, ps, logs, inspect, cancel, scheduled run/ps/inspect/delete/suspend/resume.\n\n" +
      `Hardware: CPU: ${CPU_FLAVORS_DESC}. GPU: ${GPU_FLAVORS_DESC}.\n` +
      "Common picks: t4-small ($0.60/hr, 1-3B), a10g-large ($2/hr, 7-13B), a100-large ($4/hr, 30B+), h100 ($6/hr, 70B+). " +
      "Note: a10g-small and a10g-large have the SAME 24GB GPU — the difference is CPU/RAM only.\n\n" +
      "OOM RECOVERY: When a training job fails with CUDA OOM:\n" +
      "1. Reduce per_device_train_batch_size and increase gradient_accumulation_steps proportionally (keep effective batch size identical)\n" +
      "2. Enable gradient_checkpointing=True\n" +
      "3. Upgrade to larger GPU\n" +
      "Do NOT switch training methods (e.g. full SFT to LoRA) or reduce max_length — those change what the user gets.\n\n" +
      "HF Jobs require an active PRO/Enterprise subscription. HF_TOKEN is used for authentication.",
    promptSnippet: "Submit and manage HF compute jobs (CPU/GPU training, scripts, Docker containers)",
    promptGuidelines: [
      "Use hf_jobs to submit training scripts to HF GPU infrastructure. Always validate datasets and reference implementations BEFORE submission.",
    ],
    parameters: Type.Object({
      operation: StringEnum([
        "run", "ps", "logs", "inspect", "cancel",
        "scheduled run", "scheduled ps", "scheduled inspect",
        "scheduled delete", "scheduled suspend", "scheduled resume",
      ] as const),
      script: Type.Optional(Type.String({
        description: "Python code, file path, or URL. Triggers Python mode (uv run). Mutually exclusive with 'command'.",
      })),
      dependencies: Type.Optional(Type.Array(Type.String(), {
        description: "Pip packages. Include ALL required. Common: ['transformers','trl','torch','datasets','accelerate'].",
      })),
      image: Type.Optional(Type.String({
        description: "Docker image. Auto-selected if not provided. Required with 'command'.",
      })),
      command: Type.Optional(Type.Array(Type.String(), {
        description: "Command as array. Triggers Docker mode. Mutually exclusive with 'script'.",
      })),
      hardware_flavor: Type.Optional(Type.String({
        description: "Hardware. Guide: 1-3B→t4-small, 7-13B→a10g-large, 30B+→a100-large, 70B+→h100/h100x8.",
      })),
      timeout: Type.Optional(Type.String({
        description: "Job timeout (e.g. '4h', '90m'). Default: '30m'. Training needs >2h.",
      })),
      trackio_space_id: Type.Optional(Type.String({
        description: "Deprecated. Ignored.",
      })),
      trackio_project: Type.Optional(Type.String({
        description: "Deprecated. Ignored.",
      })),
      namespace: Type.Optional(Type.String({
        description: "Namespace (your account or org). Credits billed here. Defaults to your account.",
      })),
      job_id: Type.Optional(Type.String({
        description: "Job ID. Required for: logs, inspect, cancel.",
      })),
      scheduled_job_id: Type.Optional(Type.String({
        description: "Scheduled job ID. Required for: scheduled inspect/delete/suspend/resume.",
      })),
      schedule: Type.Optional(Type.String({
        description: "Cron or preset (@hourly, @daily, @weekly, @monthly). Required for: scheduled run.",
      })),
    }),
    async execute(_id, params) {
      try {
        const op = (params.operation as string).toLowerCase();
        const headers = hfHeaders();

        if (!headers["Authorization"]) {
          return err(
            "HF_TOKEN not set. HF Jobs requires authentication. Set HF_TOKEN in your environment.",
          );
        }

        switch (op) {
          // ── run ──
          case "run": {
            const script = (params.script as string) || "";
            const command = params.command as string[] | undefined;
            if (script && command) {
              return err("'script' and 'command' are mutually exclusive. Provide one or the other, not both.");
            }
            if (!script && (!command || command.length === 0)) {
              return err("Either 'script' (Python mode) or 'command' (Docker mode) must be provided.");
            }

            const deps = (params.dependencies as string[]) || [];
            const hw = (params.hardware_flavor as string) || "cpu-basic";
            const timeout = (params.timeout as string) || "30m";
            const ns = (params.namespace as string) || "";
            const env = (params as Record<string, unknown>).env as Record<string, string> | undefined;

            // Trackio: inject as env vars
            const trackioSpace = (params.trackio_space_id as string) || "";
            const trackioProject = (params.trackio_project as string) || "";
            const envFull = addDefaultEnv(env);
            if (trackioSpace) envFull["TRACKIO_SPACE_ID"] = trackioSpace;
            if (trackioProject) envFull["TRACKIO_PROJECT"] = trackioProject;

            const hfToken = process.env.HF_TOKEN;
            const secrets = addSecrets(undefined, hfToken);

            let resolvedCommand: string[];
            let image: string;

            if (script) {
              // Python mode: build uv command
              image = (params.image as string) || UV_DEFAULT_IMAGE;
              const scriptArgs = undefined; // script_args param
              resolvedCommand = buildUvCommand(script, deps, undefined, scriptArgs);
            } else {
              // Docker mode
              image = (params.image as string) || "python:3.12";
              resolvedCommand = command!;
            }

            // Construct job payload
            const body: Record<string, unknown> = {
              image,
              command: resolvedCommand,
              flavor: hw,
              timeout,
              env: envFull,
              secrets,
            };
            if (ns) body["namespace"] = ns;

            const result = await apiPost("/jobs", body, headers) as JobInfo;

            const lines = [
              `✓ Job submitted successfully!`,
              ``,
              `**Job ID:** ${result.id}`,
              `**Image:** ${image}`,
              `**Hardware:** ${hw}`,
              `**Timeout:** ${timeout}`,
              `**View at:** ${formatJobUrl(result)}`,
              ``,
              `Monitor with: hf_jobs({operation: "logs", job_id: "${result.id}"})`,
            ];

            return ok(lines.join("\n"), {
              operation: "run",
              job_id: result.id,
              url: formatJobUrl(result),
            });
          }

          // ── ps (list jobs) ──
          case "ps": {
            const ns = (params.namespace as string) || "";
            const jobs = (await apiGet(
              `/jobs${ns ? `?namespace=${encodeURIComponent(ns)}` : ""}`,
              headers,
            )) as JobInfo[];

            if (!Array.isArray(jobs) || jobs.length === 0) {
              return ok("No jobs found.", { operation: "ps", count: 0 });
            }

            const header = "ID            STATUS        HARDWARE        CREATED";
            const sep =    "──            ──────        ────────        ───────";
            const rows = jobs.map(formatJobRow).join("\n");
            return ok(
              `**Jobs (${jobs.length} total):**\n\n\`\`\`\n${header}\n${sep}\n${rows}\n\`\`\``,
              { operation: "ps", count: jobs.length },
            );
          }

          // ── logs ──
          case "logs": {
            const jobId = (params.job_id as string) || "";
            if (!jobId) return err("job_id is required for 'logs' operation.");

            const ns = (params.namespace as string) || "";
            const path = ns ? `/jobs/${encodeURIComponent(ns)}/${jobId}/logs` : `/jobs/${jobId}/logs`;
            const rawLogs = (await apiGet(path, headers)) as { logs?: string[] } | string[];

            const logsArr = Array.isArray(rawLogs) ? rawLogs : (rawLogs.logs || []);
            if (logsArr.length === 0) {
              return ok(`No logs available yet for job ${jobId}. The job may still be starting.`, { operation: "logs", job_id: jobId });
            }

            const filtered = filterUvInstallOutput(logsArr);
            const logText = stripAnsi(filtered.join("\n"));

            return ok(
              `**Logs for ${jobId}:**\n\n\`\`\`\n${logText.slice(0, 8000)}${logText.length > 8000 ? "\n...(truncated)" : ""}\n\`\`\``,
              { operation: "logs", job_id: jobId },
            );
          }

          // ── inspect ──
          case "inspect": {
            const jobId = (params.job_id as string) || "";
            if (!jobId) return err("job_id is required for 'inspect' operation.");

            const ns = (params.namespace as string) || "";
            const path = ns ? `/jobs/${encodeURIComponent(ns)}/${jobId}` : `/jobs/${jobId}`;
            const job = (await apiGet(path, headers)) as JobInfo;

            return ok(formatJobDetails(job), { operation: "inspect", job_id: jobId });
          }

          // ── cancel ──
          case "cancel": {
            const jobId = (params.job_id as string) || "";
            if (!jobId) return err("job_id is required for 'cancel' operation.");

            const ns = (params.namespace as string) || "";
            const path = ns ? `/jobs/${encodeURIComponent(ns)}/${jobId}/cancel` : `/jobs/${jobId}/cancel`;
            await apiPost(path, {}, headers);

            return ok(
              `✓ Job ${jobId} has been cancelled.\n\nVerify: hf_jobs({operation: "inspect", job_id: "${jobId}"})`,
              { operation: "cancel", job_id: jobId },
            );
          }

          // ── scheduled run ──
          case "scheduled run": {
            const schedule = (params.schedule as string) || "";
            if (!schedule) return err("schedule is required for 'scheduled run'.");

            const script = (params.script as string) || "";
            const command = params.command as string[] | undefined;
            if (script && command) {
              return err("'script' and 'command' are mutually exclusive.");
            }
            if (!script && (!command || command.length === 0)) {
              return err("Either 'script' or 'command' must be provided.");
            }

            const deps = (params.dependencies as string[]) || [];
            const hw = (params.hardware_flavor as string) || "cpu-basic";
            const timeout = (params.timeout as string) || "30m";
            const ns = (params.namespace as string) || "";
            const env = (params as Record<string, unknown>).env as Record<string, string> | undefined;
            const envFull = addDefaultEnv(env);

            const hfToken = process.env.HF_TOKEN;
            const secrets = addSecrets(undefined, hfToken);

            let resolvedCommand: string[];
            let image: string;

            if (script) {
              image = (params.image as string) || UV_DEFAULT_IMAGE;
              resolvedCommand = buildUvCommand(script, deps, undefined, undefined);
            } else {
              image = (params.image as string) || "python:3.12";
              resolvedCommand = command!;
            }

            const body: Record<string, unknown> = {
              image,
              command: resolvedCommand,
              flavor: hw,
              timeout,
              schedule,
              env: envFull,
              secrets,
            };
            if (ns) body["namespace"] = ns;

            const result = (await apiPost("/scheduled-jobs", body, headers)) as { id: string };

            return ok(
              `✓ Scheduled job created!\n\n**Scheduled Job ID:** ${result.id}\n**Schedule:** ${schedule}\n**Hardware:** ${hw}\n\n` +
                `Inspect: hf_jobs({operation: "scheduled inspect", scheduled_job_id: "${result.id}"})`,
              { operation: "scheduled run", scheduled_job_id: result.id },
            );
          }

          // ── scheduled ps ──
          case "scheduled ps": {
            const ns = (params.namespace as string) || "";
            const jobs = (await apiGet(
              `/scheduled-jobs${ns ? `?namespace=${encodeURIComponent(ns)}` : ""}`,
              headers,
            )) as Array<{ id: string; schedule: string; suspend: boolean }>;

            if (!Array.isArray(jobs) || jobs.length === 0) {
              return ok("No scheduled jobs found.", { operation: "scheduled ps", count: 0 });
            }

            const rows = jobs.map(j => `${j.id.slice(0, 12)}  ${j.schedule.padEnd(12)}  ${j.suspend ? "SUSPENDED" : "ACTIVE"}`);
            return ok(
              `**Scheduled Jobs (${jobs.length} total):**\n\n\`\`\`\n${rows.join("\n")}\n\`\`\``,
              { operation: "scheduled ps", count: jobs.length },
            );
          }

          // ── scheduled inspect ──
          case "scheduled inspect": {
            const schedId = (params.scheduled_job_id as string) || "";
            if (!schedId) return err("scheduled_job_id is required for 'scheduled inspect'.");

            const ns = (params.namespace as string) || "";
            const path = ns ? `/scheduled-jobs/${encodeURIComponent(ns)}/${schedId}` : `/scheduled-jobs/${schedId}`;
            const job = (await apiGet(path, headers)) as Record<string, unknown>;

            return ok(JSON.stringify(job, null, 2).slice(0, 2000), { operation: "scheduled inspect", scheduled_job_id: schedId });
          }

          // ── scheduled delete ──
          case "scheduled delete": {
            const schedId = (params.scheduled_job_id as string) || "";
            if (!schedId) return err("scheduled_job_id is required for 'scheduled delete'.");

            const ns = (params.namespace as string) || "";
            const path = ns ? `/scheduled-jobs/${encodeURIComponent(ns)}/${schedId}` : `/scheduled-jobs/${schedId}`;
            await fetchWithRetry(`${HF_API}${path}`, { method: "DELETE", headers, timeoutMs: 15_000 });

            return ok(`✓ Scheduled job ${schedId} deleted.`, { operation: "scheduled delete", scheduled_job_id: schedId });
          }

          // ── scheduled suspend ──
          case "scheduled suspend": {
            const schedId = (params.scheduled_job_id as string) || "";
            if (!schedId) return err("scheduled_job_id is required for 'scheduled suspend'.");

            const ns = (params.namespace as string) || "";
            const path = ns ? `/scheduled-jobs/${encodeURIComponent(ns)}/${schedId}/suspend` : `/scheduled-jobs/${schedId}/suspend`;
            await apiPost(path, {}, headers);

            return ok(`✓ Scheduled job ${schedId} suspended.`, { operation: "scheduled suspend" });
          }

          // ── scheduled resume ──
          case "scheduled resume": {
            const schedId = (params.scheduled_job_id as string) || "";
            if (!schedId) return err("scheduled_job_id is required for 'scheduled resume'.");

            const ns = (params.namespace as string) || "";
            const path = ns ? `/scheduled-jobs/${encodeURIComponent(ns)}/${schedId}/resume` : `/scheduled-jobs/${schedId}/resume`;
            await apiPost(path, {}, headers);

            return ok(`✓ Scheduled job ${schedId} resumed.`, { operation: "scheduled resume" });
          }

          default:
            return err(`Unknown operation: "${op}". Available: run, ps, logs, inspect, cancel, scheduled run/ps/inspect/delete/suspend/resume.`);
        }
      } catch (e) {
        return err(`hf_jobs error: ${e}`);
      }
    },
  });
}