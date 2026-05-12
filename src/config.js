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
  const raw = resolved.endsWith('.json') || text.trimStart().startsWith('{') ? JSON.parse(text) : parseSimpleToml(text);
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
    host: String(s.host ?? raw.host ?? '127.0.0.1'),
    port: Number(s.port ?? raw.port ?? 11435),
    apiKey: (s.api_key ?? s.apiKey ?? raw.api_key ?? raw.apiKey) ? String(s.api_key ?? s.apiKey ?? raw.api_key ?? raw.apiKey) : undefined,
    requestTimeoutSeconds: Number(s.request_timeout_seconds ?? s.requestTimeoutSeconds ?? raw.request_timeout_seconds ?? raw.requestTimeoutSeconds ?? 3600),
    routingStrategy: normalizeRoutingStrategy(pick('strategy', ['routing_strategy', 'routingStrategy', 'routing_policy', 'routingPolicy'], 'sticky_failover')),
    maxRetries: Math.max(1, Number(pick('max_retries', ['maxRetries', 'retries'], 1))),
    maxAttemptsPerRequest: Math.max(0, Number(pick('max_attempts_per_request', ['maxAttemptsPerRequest', 'max_attempts', 'maxAttempts'], 0))),
    failureCooldownSeconds: Math.max(0, Number(pick('unhealthy_cooldown_seconds', ['unhealthyCooldownSeconds', 'failure_cooldown_seconds', 'failureCooldownSeconds', 'cooldown_seconds', 'cooldownSeconds', 'cooldown'], 60))),
    retryBackoffSeconds: Math.max(0, Number(pick('retry_backoff_seconds', ['retryBackoffSeconds', 'backoff_seconds', 'backoffSeconds'], 0))),
    retryOnAnyAcpError: asBool(pick('retry_on_any_acp_error', ['retryOnAnyAcpError', 'retry_all_acp_errors', 'retryAllAcpErrors'], false)),
    affinityPrefixChars: Math.max(128, Number(pick('affinity_prefix_chars', ['affinityPrefixChars', 'routing_key_prefix_chars', 'routingKeyPrefixChars', 'prompt_affinity_prefix_chars', 'promptAffinityPrefixChars'], 4096))),
    maxRequestBytes: Math.max(1024, Number(s.max_request_bytes ?? s.maxRequestBytes ?? raw.max_request_bytes ?? 64 * 1024 * 1024))
  };
  if (!['sticky_failover', 'primary_failover', 'round_robin', 'least_busy'].includes(server.routingStrategy)) {
    throw new Error('routing_strategy must be sticky_failover, primary_failover, round_robin, or least_busy');
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
      startupTimeoutSeconds: Number(item.startup_timeout_seconds ?? item.startupTimeoutSeconds ?? item.startup_timeout ?? item.startupTimeout ?? 30),
      requestTimeoutSeconds: Number(item.request_timeout_seconds ?? item.requestTimeoutSeconds ?? server.requestTimeoutSeconds)
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

export function parseSimpleToml(text) {
  const root = {};
  let cur = root;
  let currentAgent = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const array = /^\[\[\s*([^\]]+)\s*\]\]$/.exec(line);
    if (array) {
      if (array[1].trim() !== 'agents') throw new Error(`unsupported TOML array ${array[1]}`);
      root.agents ||= [];
      currentAgent = {};
      root.agents.push(currentAgent);
      cur = currentAgent;
      continue;
    }
    const table = /^\[\s*([^\]]+)\s*\]$/.exec(line);
    if (table) {
      const name = table[1].trim();
      if (name.startsWith('agents.')) {
        if (!currentAgent) throw new Error(`[${name}] must follow [[agents]]`);
        cur = currentAgent;
        for (const part of name.slice('agents.'.length).split('.')) cur = cur[part] ||= {};
      } else {
        currentAgent = null;
        cur = root;
        for (const part of name.split('.')) cur = cur[part] ||= {};
      }
      continue;
    }
    const eq = topEq(line);
    if (eq < 0) throw new Error(`invalid TOML line: ${raw}`);
    cur[line.slice(0, eq).trim()] = parseValue(line.slice(eq + 1).trim());
  }
  return root;
}
function stripComment(line) {
  let quote = null, esc = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (esc) { esc = false; continue; }
    if (quote === '"' && ch === '\\') { esc = true; continue; }
    if (!quote && (ch === '"' || ch === "'")) quote = ch;
    else if (quote === ch) quote = null;
    else if (!quote && ch === '#') return line.slice(0, i);
  }
  return line;
}
function topEq(s) { let q = null, d = 0; for (let i = 0; i < s.length; i++) { const ch = s[i]; if ((ch === '"' || ch === "'") && s[i - 1] !== '\\') q = q === ch ? null : (q || ch); else if (!q && (ch === '[' || ch === '{')) d++; else if (!q && (ch === ']' || ch === '}')) d--; else if (!q && d === 0 && ch === '=') return i; } return -1; }
function parseValue(s) {
  if (s.startsWith('"') && s.endsWith('"')) return JSON.parse(s);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) return splitTop(s.slice(1, -1)).map(parseValue);
  if (s.startsWith('{') && s.endsWith('}')) { const o = {}; for (const p of splitTop(s.slice(1, -1))) { const eq = topEq(p); o[p.slice(0, eq).trim()] = parseValue(p.slice(eq + 1).trim()); } return o; }
  return s;
}
function splitTop(s) { const parts = []; let q = null, d = 0, start = 0, esc = false; for (let i = 0; i < s.length; i++) { const ch = s[i]; if (esc) { esc = false; continue; } if (q === '"' && ch === '\\') { esc = true; continue; } if (!q && (ch === '"' || ch === "'")) q = ch; else if (q === ch) q = null; else if (!q && (ch === '[' || ch === '{')) d++; else if (!q && (ch === ']' || ch === '}')) d--; else if (!q && d === 0 && ch === ',') { parts.push(s.slice(start, i).trim()); start = i + 1; } } const tail = s.slice(start).trim(); if (tail) parts.push(tail); return parts; }

