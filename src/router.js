import { createHash } from 'node:crypto';
import { AcpError, AcpProcessExited, AgentRuntime, JsonRpcError } from './acpClient.js';
import { AgentCapabilityError } from './openaiCompat.js';

const RETRYABLE_MARKERS = [
  'rate limit', 'ratelimit', 'too many requests', 'quota', 'exhausted', 'resource exhausted',
  'account blocked', 'account suspended', 'blocked', 'suspended', 'temporarily unavailable',
  'unavailable', 'overloaded', 'timeout', 'timed out', 'connection reset', 'broken pipe',
  'process exited', 'not running'
];

export class AgentPool {
  constructor(model, runtimes, routing = {}) {
    if (!runtimes.length) throw new Error(`model ${model} has no agent runtimes`);
    this.model = model;
    this.runtimes = runtimes;
    this.strategy = routing.strategy || routing.routingStrategy || 'sticky_failover';
    this.maxRetries = Math.max(1, Number(routing.maxRetries ?? routing.max_retries ?? 1));
    const fullPassAttempts = runtimes.length * this.maxRetries;
    this.maxAttemptsPerRequest = Math.max(1, Number(routing.maxAttemptsPerRequest || routing.max_attempts_per_request || fullPassAttempts));
    this.failureCooldownSeconds = Math.max(0, Number(routing.failureCooldownSeconds ?? routing.failure_cooldown_seconds ?? 60));
    this.retryBackoffSeconds = Math.max(0, Number(routing.retryBackoffSeconds ?? routing.retry_backoff_seconds ?? 0));
    this.retryOnAnyAcpError = Boolean(routing.retryOnAnyAcpError ?? routing.retry_on_any_acp_error ?? false);
    this.affinityPrefixChars = Math.max(128, Number(routing.affinityPrefixChars ?? routing.affinity_prefix_chars ?? 4096));
    this.next = 0;
  }

  get runtimeIds() { return this.runtimes.map((runtime) => runtime.runtimeId); }
  get routingStrategy() { return this.strategy; }
  get size() { return this.runtimes.length; }

  attemptOrder(routingKey) {
    let base = this.baseOrder(routingKey);
    base = this.healthyFirst(base);
    const attempts = [];
    while (attempts.length < this.maxAttemptsPerRequest) attempts.push(base[attempts.length % base.length]);
    return attempts;
  }

  baseOrder(routingKey) {
    if (this.runtimes.length === 1) return [...this.runtimes];
    if (this.strategy === 'round_robin') {
      const start = this.next;
      this.next = (this.next + 1) % this.runtimes.length;
      const ordered = rotate(this.runtimes, start);
      return ordered.filter((runtime) => !runtime.busy).concat(ordered.filter((runtime) => runtime.busy));
    }
    if (this.strategy === 'least_busy') {
      return [...this.runtimes].sort((a, b) => Number(a.busy) - Number(b.busy) || a.consecutiveFailures - b.consecutiveFailures);
    }
    if (this.strategy === 'sticky_failover' && routingKey) {
      return rotate(this.runtimes, stableIndex(`${this.model}\0${routingKey}`, this.runtimes.length));
    }
    return [...this.runtimes];
  }

  healthyFirst(ordered) {
    const healthy = ordered.filter((runtime) => !runtime.inCooldown);
    const cooling = ordered.filter((runtime) => runtime.inCooldown);
    return healthy.length ? healthy.concat(cooling) : ordered;
  }
}

export function createRuntimesAndPools(config, RuntimeClass = AgentRuntime, logger = console) {
  const runtimes = config.agents.map((agent) => new RuntimeClass(agent, logger));
  const byModel = new Map();
  for (const runtime of runtimes) {
    for (const model of runtime.config.models) {
      if (!byModel.has(model)) byModel.set(model, []);
      byModel.get(model).push(runtime);
    }
  }
  const pools = new Map();
  for (const [model, modelRuntimes] of byModel.entries()) {
    pools.set(model, new AgentPool(model, modelRuntimes, config.routing));
  }
  return { runtimes, pools };
}

function isRetryableAcpFailure(error, serverConfig = {}) {
  if (serverConfig.retryOnAnyAcpError || serverConfig.retry_on_any_acp_error) return true;
  if (error instanceof AgentCapabilityError) return false;
  if (error instanceof AcpProcessExited) return true;
  if (error instanceof JsonRpcError) {
    const code = Number(error.error?.code);
    const text = shortError(error).toLowerCase();
    if ([408, 409, 423, 425, 429, 500, 502, 503, 504].includes(code)) return true;
    if ([401, 403, -32000].includes(code)) return RETRYABLE_MARKERS.some((marker) => text.includes(marker));
  }
  if (error instanceof AcpError) return RETRYABLE_MARKERS.some((marker) => shortError(error).toLowerCase().includes(marker));
  return RETRYABLE_MARKERS.some((marker) => shortError(error).toLowerCase().includes(marker));
}

export function isRetryableError(error, pool = {}) {
  return isRetryableAcpFailure(error, { retryOnAnyAcpError: Boolean(pool.retryOnAnyAcpError) });
}

export async function maybeRetryBackoff(pool) {
  const seconds = Math.max(0, Number(pool?.retryBackoffSeconds ?? pool?.retry_backoff_seconds ?? 0));
  if (seconds > 0) await sleepSeconds(seconds);
}

export function allCandidateSpecificFailures(failures) {
  return failures.length > 0 && failures.every((f) => /capability|does not advertise|did not advertise|unsupported/i.test(f.message));
}

export function formatCapabilityFailures(model, failures) {
  return `no ACP runtime for model ${JSON.stringify(model)} supports the requested prompt capabilities: ${failures.map((f) => `${f.runtimeId}: ${f.message}`).join('; ')}`;
}

export function formatRouteFailures(model, failures) {
  const detail = failures.map((f) => `${f.runtimeId}: ${f.message}`).join('; ');
  return `all ACP runtimes failed for model ${JSON.stringify(model)} after ${failures.length} attempt(s): ${detail}`;
}

function sleepSeconds(seconds) {
  const ms = Math.max(0, Number(seconds || 0) * 1000);
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function routingKeyFromRequest(request, body, maxChars = 4096) {
  const headers = request.headers ?? {};
  const getHeader = (name) => typeof headers.get === 'function' ? headers.get(name) : (headers[name.toLowerCase()] ?? headers[name]);
  for (const name of ['x-acp-routing-key', 'x-routing-key', 'x-prompt-cache-key', 'openai-conversation-id']) {
    const value = getHeader(name);
    if (value) return String(Array.isArray(value) ? value[0] : value);
  }
  for (const key of ['x_acp_routing_key', 'routing_key', 'prompt_cache_key', 'cache_key', 'user', 'session_id', 'conversation_id', 'thread_id']) {
    const value = body?.[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  const metadata = body?.metadata;
  if (metadata && typeof metadata === 'object') {
    for (const key of ['x_acp_routing_key', 'routing_key', 'prompt_cache_key', 'cache_key', 'session_id', 'conversation_id', 'thread_id', 'user']) {
      const value = metadata[key];
      if (typeof value === 'string' || typeof value === 'number') return String(value);
    }
  }
  const prefix = promptPrefixForAffinity(body, maxChars);
  if (prefix) return `prompt-prefix:${createHash('blake2b512').update(prefix).digest('hex').slice(0, 32)}`;
  return undefined;
}

function promptPrefixForAffinity(body, maxChars) {
  const parts = [];
  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      if (!message || typeof message !== 'object') continue;
      const role = String(message.role ?? '');
      const content = contentForAffinity(message.content);
      if (['system', 'developer', 'user'].includes(role) && content) parts.push(`${role}:${content}`);
      if (parts.reduce((sum, item) => sum + item.length, 0) >= maxChars) break;
    }
  } else {
    for (const key of ['instructions', 'input', 'prompt']) {
      const content = contentForAffinity(body?.[key]);
      if (content) parts.push(`${key}:${content}`);
    }
  }
  return parts.join('\n').slice(0, maxChars);
}

function contentForAffinity(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === 'string' ? item : (item?.text || item?.input_text || item?.url || item?.file_url || '')).filter(Boolean).join('\n');
  }
  if (value && typeof value === 'object') return typeof value.text === 'string' ? value.text : contentForAffinity(value.content);
  return '';
}

function rotate(values, start) {
  return values.slice(start).concat(values.slice(0, start));
}

function stableIndex(value, modulo) {
  const digest = createHash('blake2b512').update(value).digest();
  return Number(digest.readBigUInt64BE(0) % BigInt(modulo));
}

export function shortError(error) {
  return String(error?.message ?? error?.stack ?? error?.name ?? error ?? 'Error').replace(/\s+/g, ' ').trim().slice(0, 500);
}
