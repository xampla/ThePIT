/**
 * Merge The PIT hooks and telemetry env into Claude Code settings.
 *   node scripts/install-hooks.ts             -> .claude/settings.json in this project
 *   node scripts/install-hooks.ts --global    -> ~/.claude/settings.json
 *   node scripts/install-hooks.ts --remove    -> take them out again
 * Idempotent; a .bak copy of the previous file is written next to it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const args = new Set(process.argv.slice(2));
const target = args.has("--global") ? resolve(homedir(), ".claude/settings.json") : resolve(".claude/settings.json");
const collector = process.env.PIT_COLLECTOR ?? "http://127.0.0.1:4318";
const hookCmd = `node ${resolve("scripts/claude-code-hook.ts")}`;
const MINE = (h: Hook) => h.command.includes("claude-code-hook");

type Hook = { type: string; command: string; timeout?: number };
type Matcher = { matcher?: string; hooks: Hook[] };
type Settings = { hooks?: Record<string, Matcher[]>; env?: Record<string, string>; [k: string]: unknown };

const TELEMETRY_ENV: Record<string, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  OTEL_EXPORTER_OTLP_ENDPOINT: collector,
  OTEL_LOG_USER_PROMPTS: "1",
  OTEL_LOGS_EXPORT_INTERVAL: "2000",
  OTEL_METRIC_EXPORT_INTERVAL: "10000",
};

let settings: Settings = {};
if (existsSync(target)) {
  settings = JSON.parse(readFileSync(target, "utf8"));
  copyFileSync(target, target + ".bak");
}

const events = ["SessionStart", "SessionEnd", "SubagentStart", "SubagentStop", "UserPromptSubmit", "PreToolUse", "PostToolUse"];
settings.hooks ??= {};
for (const ev of events) {
  const list = (settings.hooks[ev] ?? []).map((m) => ({ ...m, hooks: m.hooks.filter((h) => !MINE(h)) })).filter((m) => m.hooks.length);
  if (!args.has("--remove")) list.push({ matcher: "", hooks: [{ type: "command", command: hookCmd, timeout: 5 }] });
  if (list.length) settings.hooks[ev] = list; else delete settings.hooks[ev];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

settings.env ??= {};
for (const [k, v] of Object.entries(TELEMETRY_ENV)) {
  if (args.has("--remove")) { if (settings.env[k] === v || k.startsWith("OTEL_") || k === "CLAUDE_CODE_ENABLE_TELEMETRY") delete settings.env[k]; }
  else settings.env[k] = v;
}
if (!Object.keys(settings.env).length) delete settings.env;

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(settings, null, 2) + "\n");
console.log(`${args.has("--remove") ? "removed from" : "installed into"} ${target}`);
console.log(args.has("--remove") ? "" : `hooks: ${events.join(", ")} → ${hookCmd}\ntelemetry → ${collector}`);
