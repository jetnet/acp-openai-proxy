#!/usr/bin/env node
// Cheap live smoke test against a real config (default: config.local.json).
//
// What it does:
//   1. spawns `node src/index.js --config <cfg>` in the background
//   2. polls /health until ready (or times out)
//   3. checks /v1/models shape + pool membership
//   4. fires 3 sequential chat completions against the cheapest pool with a
//      minimal prompt that asks for a single short word ("pong") — the goal
//      is to confirm wiring, NOT exercise the model. With round_robin and
//      a pool of 2, we expect alternation across two distinct agent ids.
//   5. shuts the proxy down with SIGTERM and asserts a clean exit.
//
// Why it stays cheap:
//   - Targets `flash-lite` (Gemini's cheapest model by far).
//   - Prompt is ~8 input tokens; reply is constrained to a few output tokens.
//   - Only 3 generations total per run; no streaming, no responses-api.
//   - Skips entirely if the configured "smoke model" is missing from the
//     /v1/models list (so this script is safe to wire into a dev loop even
//     when the user is iterating with a different config shape).
//
// Usage:
//   node scripts/live-smoke.mjs [config-path]
//   npm run test:live
//
// Env knobs:
//   ACP_SMOKE_MODEL     model id to hit (default: flash-lite)
//   ACP_SMOKE_BASE_URL  if set, skip spawn and hit an already-running proxy
//   ACP_SMOKE_BOOT_TIMEOUT_S  seconds to wait for /health (default: 120)

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const configPath = path.resolve(REPO, process.argv[2] || "config.local.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const apiKey = config.server?.api_key || config.server?.apiKey;
const host = config.server?.host || "127.0.0.1";
const port = config.server?.port || 11435;
const bootTimeoutSec = Number(process.env.ACP_SMOKE_BOOT_TIMEOUT_S || 120);
const smokeModel = process.env.ACP_SMOKE_MODEL || "flash-lite";

const baseUrl = process.env.ACP_SMOKE_BASE_URL || `http://${host}:${port}`;
const auth = apiKey ? { authorization: `Bearer ${apiKey}` } : {};

let pass = 0, fail = 0, skip = 0;
const results = [];
function check(label, ok, info = "") {
  const tag = ok ? "PASS" : "FAIL";
  results.push({ tag, label, info });
  process.stdout.write(`  ${tag}  ${label}${info ? "  " + info : ""}\n`);
  if (ok) pass += 1; else fail += 1;
}
function skipCheck(label, info = "") {
  results.push({ tag: "SKIP", label, info });
  process.stdout.write(`  SKIP  ${label}${info ? "  " + info : ""}\n`);
  skip += 1;
}
const QUOTA_MARKERS = /quota|exhausted|rate.?limit|too many requests|account (?:suspended|blocked)|temporarily unavailable|overloaded|capacity/i;
function looksLikeQuota(body) {
  return body?.error?.message && QUOTA_MARKERS.test(body.error.message);
}

let proxy = null;
let proxyExitCode = null;
let proxyExitSignal = null;

async function spawnProxy() {
  if (process.env.ACP_SMOKE_BASE_URL) return null;
  const child = spawn(process.execPath, ["src/index.js", "--config", configPath], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ACP_OPENAI_PROXY_LOG_LEVEL: "warn" }
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => process.stdout.write(`[proxy stdout] ${c}`));
  child.stderr.on("data", (c) => process.stderr.write(`[proxy stderr] ${c}`));
  child.on("exit", (code, signal) => { proxyExitCode = code; proxyExitSignal = signal; });
  return child;
}

async function waitForHealth() {
  const deadline = Date.now() + bootTimeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.status === 200) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function shutdownProxy() {
  if (!proxy) return;
  proxy.kill("SIGTERM");
  const deadline = Date.now() + 10_000;
  while (proxy.exitCode === null && Date.now() < deadline) await sleep(50);
  if (proxy.exitCode === null) proxy.kill("SIGKILL");
}

async function main() {
  console.log(`live-smoke: config=${configPath} base=${baseUrl} model=${smokeModel}`);
  proxy = await spawnProxy();

  console.log("=== boot ===");
  const ready = await waitForHealth();
  check(`GET /health within ${bootTimeoutSec}s → 200`, ready);
  if (!ready) return;

  console.log("=== auth + models ===");
  const unauth = await fetch(`${baseUrl}/v1/models`);
  check("GET /v1/models without auth → 401", unauth.status === 401, `got ${unauth.status}`);

  const models = await fetch(`${baseUrl}/v1/models`, { headers: { ...auth } }).then((r) => r.json());
  check("GET /v1/models returns a list", Array.isArray(models?.data) && models.data.length > 0,
    `${models?.data?.length ?? 0} models`);

  const smoke = models.data.find((m) => m.id === smokeModel);
  if (!smoke) {
    check(`smoke model '${smokeModel}' present`, false, "skipping generation checks");
    return;
  }
  check(`smoke model '${smokeModel}' present`, true,
    `pool=${smoke.x_acp_pool_size}, strategy=${smoke.x_acp_routing_strategy}`);

  console.log(`=== ${smokeModel} round-robin (3 generations, ~8 tokens in / few out each) ===`);
  const agentIds = [];
  let allQuotaExhausted = true;
  for (let i = 1; i <= 3; i += 1) {
    const r = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({
        model: smokeModel,
        max_tokens: 8,
        messages: [
          { role: "system", content: "Reply with the single word 'pong'. Do not say anything else." },
          { role: "user", content: "ping" }
        ]
      })
    });
    const body = await r.json();
    const agentId = r.headers.get("x-acp-agent");
    const reqId = r.headers.get("x-request-id");
    if (r.status === 200) {
      allQuotaExhausted = false;
      const text = body?.choices?.[0]?.message?.content ?? "";
      check(`chat #${i} → 200`, true, `agent=${agentId} req=${reqId} text=${JSON.stringify(text.slice(0, 60))}`);
    } else if (looksLikeQuota(body)) {
      skipCheck(`chat #${i}`, `upstream quota exhausted (${r.status}); proxy returned a clean error shape`);
    } else {
      allQuotaExhausted = false;
      check(`chat #${i} → 200`, false, `agent=${agentId} req=${reqId} status=${r.status}`);
      console.log("  body:", JSON.stringify(body));
    }
    if (agentId) agentIds.push(agentId);
  }

  if (allQuotaExhausted) {
    skipCheck(`round_robin spread check`, `cannot verify — all attempts hit upstream quota`);
  } else if (smoke.x_acp_pool_size > 1 && smoke.x_acp_routing_strategy === "round_robin") {
    const distinct = new Set(agentIds);
    if (distinct.size > 1) check(`round_robin spreads across ${smoke.x_acp_pool_size} agents`, true,
      `agents seen: ${[...distinct].join(", ")}`);
    else if (agentIds.length < 2) skipCheck(`round_robin spread check`, "not enough successful generations to evaluate");
    else check(`round_robin spreads across ${smoke.x_acp_pool_size} agents`, false,
      `agents seen: ${[...distinct].join(", ")}`);
  }

  console.log("=== /readyz ===");
  const ready1 = await fetch(`${baseUrl}/readyz`, { headers: { ...auth } });
  check("GET /readyz → 200 or 503 (configurable)", ready1.status === 200 || ready1.status === 503,
    `got ${ready1.status}`);
}

(async () => {
  try {
    await main();
  } catch (error) {
    fail += 1;
    console.error("live-smoke threw:", error);
  } finally {
    await shutdownProxy();
    if (proxy) check("proxy exited cleanly", proxyExitCode === 0,
      `exitCode=${proxyExitCode} signal=${proxyExitSignal}`);
    console.log(`\nlive-smoke result: ${pass} passing / ${fail} failing / ${skip} skipped`);
    if (skip > 0 && fail === 0) console.log("note: skipped checks were environmental (upstream quota), not proxy bugs");
    process.exit(fail > 0 ? 1 : 0);
  }
})();
