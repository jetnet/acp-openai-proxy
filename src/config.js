import fs from 'node:fs';
import path from 'node:path';

export function defaultConfigText() {
  return JSON.stringify({
    server: {
      host: '127.0.0.1',
      port: 11435,
      logging: {
        level: 'info',
        format: 'json'
      },
      request_timeout_seconds: 3600,
      routing_strategy: 'sticky_failover',
      max_retries: 1,
      max_attempts_per_request: 0,
      failure_cooldown_seconds: 60,
      retry_backoff_seconds: 0,
      retry_on_any_acp_error: false,
      affinity_prefix_chars: 4096,
      max_request_bytes: 67108864
    },
    agents: [
      {
        name: 'gemini',
        instance_id: 'gemini-a',
        command: 'npx',
        args: ['-y', '@google/gemini-cli@latest', '--model', 'auto', '--experimental-acp'],
        cwd: '.',
        models: ['gemini'],
        env: { GEMINI_API_KEY: '{var:GEMINI_API_KEY_A}' },
        permission: 'deny',
        expose_tool_updates: false,
        start_at_boot: false
      },
      {
        name: 'gemini',
        instance_id: 'gemini-b',
        command: 'npx',
        args: ['-y', '@google/gemini-cli@latest', '--model', 'auto', '--experimental-acp'],
        cwd: '.',
        models: ['gemini'],
        env: { GEMINI_API_KEY: '{var:GEMINI_API_KEY_B}' },
        permission: 'deny',
        expose_tool_updates: false,
        start_at_boot: false
      }
    ]
  }, null, 2) + '\n';
}

export function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  const text = fs.readFileSync(resolved, 'utf8');
  let raw;
  try { raw = JSON.parse(text); }
  catch (cause) { throw new Error(`failed to parse config ${resolved} as JSON: ${cause.message}`); }
  return normalizeConfig(raw, path.dirname(resolved));
}

export function normalizeConfig(raw, configDir = process.cwd()) {
  if (!isObj(raw)) throw new Error('config root must be an object');
  if (raw.env_sections !== undefined || raw.envSections !== undefined) {
    throw new Error('env_sections/envSections is no longer supported; move environment values into each agents[].env block');
  }
  const s = isObj(raw.server) ? raw.server : {};
  const r = isObj(raw.routing) ? raw.routing : {};
  const l = isObj(raw.logging) ? raw.logging : isObj(s.logging) ? s.logging : {};
  const pick = (key, aliases = [], fallback = undefined) => {
    for (const src of [r, s, raw]) for (const k of [key, ...aliases]) if (src[k] !== undefined && src[k] !== null) return src[k];
    return fallback;
  };
  const logging = normalizeLogging(l);
  const server = {
    host: nonEmptyString(s.host ?? raw.host ?? '127.0.0.1', 'server.host'),
    port: intRange(s.port ?? raw.port ?? 11435, 'server.port', { min: 0, max: 65535 }),
    apiKey: normalizeApiKey(s.api_key ?? s.apiKey ?? raw.api_key ?? raw.apiKey),
    requestTimeoutSeconds: numRange(s.request_timeout_seconds ?? s.requestTimeoutSeconds ?? raw.request_timeout_seconds ?? raw.requestTimeoutSeconds ?? 3600, 'server.request_timeout_seconds', { min: 1, max: 86400 }),
    routingStrategy: normalizeRoutingStrategy(pick('strategy', ['routing_strategy', 'routingStrategy', 'routing_policy', 'routingPolicy'], 'sticky_failover')),
    maxRetries: intRange(pick('max_retries', ['maxRetries', 'retries'], 1), 'server.max_retries', { min: 1, max: 100 }),
    maxAttemptsPerRequest: intRange(pick('max_attempts_per_request', ['maxAttemptsPerRequest', 'max_attempts', 'maxAttempts'], 0), 'server.max_attempts_per_request', { min: 0, max: 1000 }),
    failureCooldownSeconds: numRange(pick('unhealthy_cooldown_seconds', ['unhealthyCooldownSeconds', 'failure_cooldown_seconds', 'failureCooldownSeconds', 'cooldown_seconds', 'cooldownSeconds', 'cooldown'], 60), 'server.failure_cooldown_seconds', { min: 0, max: 86400 }),
    retryBackoffSeconds: numRange(pick('retry_backoff_seconds', ['retryBackoffSeconds', 'backoff_seconds', 'backoffSeconds'], 0), 'server.retry_backoff_seconds', { min: 0, max: 3600 }),
    retryOnAnyAcpError: asBool(pick('retry_on_any_acp_error', ['retryOnAnyAcpError', 'retry_all_acp_errors', 'retryAllAcpErrors'], false)),
    affinityPrefixChars: intRange(pick('affinity_prefix_chars', ['affinityPrefixChars', 'routing_key_prefix_chars', 'routingKeyPrefixChars', 'prompt_affinity_prefix_chars', 'promptAffinityPrefixChars'], 4096), 'server.affinity_prefix_chars', { min: 128, max: 1048576 }),
    maxRequestBytes: intRange(s.max_request_bytes ?? s.maxRequestBytes ?? raw.max_request_bytes ?? 64 * 1024 * 1024, 'server.max_request_bytes', { min: 1024, max: 1024 * 1024 * 1024 })
  };
  if (!['sticky_failover', 'primary_failover', 'round_robin', 'least_busy'].includes(server.routingStrategy)) {
    throw new Error('routing_strategy must be sticky_failover, primary_failover, round_robin, or least_busy');
  }
  server.allowUnauthenticated = asBool(s.allow_unauthenticated ?? s.allowUnauthenticated ?? raw.allow_unauthenticated, false);
  if (!server.apiKey && !isLoopbackHost(server.host) && !server.allowUnauthenticated) {
    throw new Error(`server.api_key is required when server.host is ${JSON.stringify(server.host)}; set server.allow_unauthenticated: true to bind a non-loopback host without auth`);
  }
  const items = agentItems(raw);
  const names = items.map((item, index) => agentName(item, index));
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  const ids = new Set();
  const agents = items.map((item, index) => {
    const name = names[index];
    if (item.env_section !== undefined || item.envSection !== undefined || item.env_sections !== undefined || item.envSections !== undefined) {
      throw new Error(`agent ${name} uses env_section/env_sections, which was removed; put values directly in agent.env`);
    }
    const instanceId = (item.instance_id ?? item.instanceId ?? item.id) ? String(item.instance_id ?? item.instanceId ?? item.id) : (counts.get(name) === 1 ? name : `${name}-${index + 1}`);
    if (ids.has(instanceId)) throw new Error(`duplicate agent instance_id ${instanceId}`);
    ids.add(instanceId);
    const cwd = String(item.cwd ?? '.');
    const agent = {
      name,
      instanceId,
      command: String(item.command ?? item.cmd ?? ''),
      args: strList(item.args ?? [], `agent ${name}.args`),
      cwd: path.resolve(configDir, cwd),
      env: strDict(item.env || {}, `agent ${name}.env`, { expand: true }),
      models: agentModels(item, name),
      modelSelection: normalizeModelSelection(item, name),
      mcpServers: item.mcp_servers ?? item.mcpServers ?? [],
      permission: normalizePermission(item.permission ?? item.auto_permission ?? 'deny'),
      exposeToolUpdates: asBool(item.expose_tool_updates ?? item.exposeToolUpdates ?? item.show_tool_updates ?? item.showToolUpdates, false),
      startAtBoot: asBool(item.start_at_boot ?? item.startAtBoot ?? item.start_on_boot ?? item.startOnBoot, false),
      startupTimeoutSeconds: numRange(item.startup_timeout_seconds ?? item.startupTimeoutSeconds ?? item.startup_timeout ?? item.startupTimeout ?? 30, `agent ${name}.startup_timeout_seconds`, { min: 1, max: 3600 }),
      requestTimeoutSeconds: numRange(item.request_timeout_seconds ?? item.requestTimeoutSeconds ?? server.requestTimeoutSeconds, `agent ${name}.request_timeout_seconds`, { min: 1, max: 86400 })
    };
    if (!agent.command) throw new Error(`agent ${name} command must not be empty`);
    return agent;
  });
  if (!agents.length) throw new Error('config must define at least one agent');
  const routing = {
    strategy: server.routingStrategy,
    maxRetries: server.maxRetries,
    maxAttemptsPerRequest: server.maxAttemptsPerRequest,
    failureCooldownSeconds: server.failureCooldownSeconds,
    retryBackoffSeconds: server.retryBackoffSeconds,
    retryOnAnyAcpError: server.retryOnAnyAcpError,
    affinityPrefixChars: server.affinityPrefixChars
  };
  return { server, logging, routing, agents, defaultModel: agents[0].models[0] };
}

function normalizeLogging(raw) {
  const level = String(raw.level ?? raw.log_level ?? raw.logLevel ?? 'info').toLowerCase().trim();
  const format = String(raw.format ?? raw.log_format ?? raw.logFormat ?? 'json').toLowerCase().trim();
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(level)) throw new Error('logging.level must be debug, info, warn, error, or silent');
  if (!['json', 'text'].includes(format)) throw new Error('logging.format must be json or text');
  return { level, format };
}

function agentItems(raw) {
  if (Array.isArray(raw.agents)) return raw.agents;
  if (isObj(raw.agent)) return [raw.agent];
  if (isObj(raw.providers)) return Object.entries(raw.providers).map(([name, item]) => ({ name, ...item }));
  throw new Error('config must define at least one agents array');
}
function agentName(item, index) {
  const fallback = item.model_identifier ?? item.model_id ?? item.openai_model ?? (Array.isArray(item.model_identifiers) ? item.model_identifiers[0] : undefined);
  return String(item.name ?? fallback ?? `agent-${index + 1}`);
}
function agentModels(item, name) {
  for (const k of ['models', 'model_identifiers', 'model_identifier', 'model_id', 'openai_model']) if (item[k] !== undefined) return strList(item[k], `agent ${name}.${k}`);
  if (item.model !== undefined) throw new Error(`agent ${name}.model is ambiguous; use models for OpenAI-exposed ids and put provider model selection in args or model_selection`);
  return [name];
}
function normalizeModelSelection(item, name) {
  const raw = item.model_selection ?? item.modelSelection;
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return { type: 'session_config', configId: null, values: {}, required: true };
  if (!isObj(raw)) throw new Error(`agent ${name}.model_selection must be an object or boolean`);
  const type = String(raw.type ?? raw.mode ?? 'session_config').toLowerCase().trim().replace(/-/g, '_');
  if (type !== 'session_config') throw new Error(`agent ${name}.model_selection.type must be session_config`);
  const hasConfigId = raw.config_id !== undefined || raw.configId !== undefined || raw.id !== undefined || raw.option_id !== undefined || raw.optionId !== undefined;
  const configIdRaw = raw.config_id ?? raw.configId ?? raw.id ?? raw.option_id ?? raw.optionId;
  const configId = !hasConfigId || configIdRaw === null ? null : String(configIdRaw);
  const values = strDict(raw.values ?? raw.map ?? raw.models ?? {}, `agent ${name}.model_selection.values`, { expand: false });
  return {
    type,
    configId,
    values,
    required: asBool(raw.required ?? raw.strict, true)
  };
}
function normalizeRoutingStrategy(v) {
  const x = String(v || 'sticky_failover').toLowerCase().trim().replace(/-/g, '_');
  return ({ sticky: 'sticky_failover', cache: 'sticky_failover', cache_aware: 'sticky_failover', affinity: 'sticky_failover', primary: 'primary_failover', primary_first: 'primary_failover', failover: 'primary_failover', rr: 'round_robin', roundrobin: 'round_robin', load_balance: 'round_robin', leastbusy: 'least_busy', least_outstanding: 'least_busy' })[x] || x;
}
function normalizePermission(v) {
  const x = String(v || 'deny').toLowerCase().trim().replace(/-/g, '_');
  const y = ({ reject: 'deny', no: 'deny', never: 'deny', readonly: 'read_only', read: 'read_only', approve: 'allow', yes: 'allow', always: 'allow' })[x] || x;
  if (!['deny', 'read_only', 'allow'].includes(y)) throw new Error('permission must be deny, read_only, or allow');
  return y;
}
function strList(v, field) {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${field} must be a string or string array`);
  return [...v];
}
function strDict(v, field, { expand = true } = {}) {
  if (!isObj(v)) throw new Error(`${field} must be an object/table`);
  const out = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== null) out[k] = expand ? expandEnv(String(x)) : String(x);
  return out;
}
export function expandEnv(s) {
  return s
    .replace(/\{var:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback = '') => process.env[name] ?? fallback)
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback = '') => process.env[name] ?? fallback)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, fallback = '', b) => process.env[a || b] ?? fallback);
}
function asBool(v, fallback = false) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  return Boolean(v);
}
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function intRange(value, field, { min, max, fallback } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${field} must be an integer in [${min}, ${max}]; got ${JSON.stringify(value)}`);
  }
  return n;
}

function numRange(value, field, { min, max, fallback } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${field} must be a finite number in [${min}, ${max}]; got ${JSON.stringify(value)}`);
  }
  return n;
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string; got ${JSON.stringify(value)}`);
  }
  return value;
}

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]' || h.startsWith('127.');
}

function normalizeApiKey(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('server.api_key must be a string');
  if (value === '') throw new Error('server.api_key is set but empty; remove the field to disable auth or set a real value');
  return value;
}


