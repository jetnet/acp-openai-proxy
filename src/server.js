import http from 'node:http';
import { AcpError } from './acpClient.js';
import { createLogger } from './logger.js';
import {
  BadRequest,
  AgentCapabilityError,
  buildChatPrompt,
  buildCompletionPrompt,
  buildResponsesPrompt,
  chatCompletionResponse,
  completionResponse,
  responsesApiResponse,
  modelOrDefault,
  sseData,
  sseEvent,
  doneSse,
  finishReason,
  responseUsage,
  makeId,
  now,
  clientToolContext,
  extractClientToolCalls
} from './openaiCompat.js';
import {
  createRuntimesAndPools,
  isRetryableError,
  maybeRetryBackoff,
  formatRouteFailures,
  allCandidateSpecificFailures,
  formatCapabilityFailures,
  routingKeyFromRequest
} from './router.js';
import { compactError, jsonResponse, openAiError, readJsonBody } from './util.js';

const PERMISSIVE_CAPS = { promptCapabilities: { image: true, audio: true, embeddedContext: true } };

export function createProxyServer(config, { logger = createLogger() } = {}) {
  const manager = new ProxyManager(config, logger);
  const server = http.createServer((req, res) => {
    logRequest(manager.logger, req, res);
    handleRequest(manager, req, res).catch((error) => sendCaughtError(manager, res, error));
  });
  server.manager = manager;
  server.startBootAgents = () => manager.startBootAgents();
  server.closeProxy = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await manager.close();
  };
  return server;
}

export class AcpOpenAiServer {
  constructor(config, options = {}) {
    this.config = config;
    this.server = createProxyServer(config, options);
  }
  async startAtBoot() { return this.server.startBootAgents(); }
  listen(port = this.config.server.port, host = this.config.server.host) {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => resolve(this.server.address()));
    });
  }
  async close() { return this.server.closeProxy(); }
  address() { return this.server.address(); }
}


class ProxyManager {
  constructor(config, logger = createLogger()) {
    this.config = config;
    this.logger = logger;
    const built = createRuntimesAndPools(config, undefined, logger);
    this.runtimes = built.runtimes;
    this.pools = built.pools;
    this.defaultModel = config.defaultModel || [...this.pools.keys()][0];
  }
  async startBootAgents() {
    const bootAgents = this.runtimes.filter((r) => r.config.startAtBoot);
    if (bootAgents.length) this.logger.info('starting boot agents', { agents: bootAgents.map((r) => r.runtimeId) });
    const results = await Promise.allSettled(bootAgents.map((r) => r.ensureStarted()));
    results.forEach((result, index) => {
      if (result.status === 'rejected') this.logger.error('boot agent failed', { agent: bootAgents[index].runtimeId, error: result.reason });
    });
  }
  async close() {
    this.logger.info('closing agent runtimes', { agents: this.runtimes.map((r) => r.runtimeId) });
    await Promise.allSettled(this.runtimes.map((r) => r.close()));
  }
  pool(model) {
    const pool = this.pools.get(model);
    if (!pool) {
      const err = new Error(`model not found: ${model}`);
      err.status = 404;
      err.type = 'not_found_error';
      throw err;
    }
    return pool;
  }
}

async function handleRequest(manager, req, res) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) return handleHealth(manager, res);
    if (!authorized(manager.config, req)) return sendOpenAiError(manager, res, openAiError('invalid or missing bearer token', 'authentication_error', 401));
    if (req.method === 'GET' && url.pathname === '/v1/models') return handleModels(manager, res);
    if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) return handleModel(manager, res, decodeURIComponent(url.pathname.slice('/v1/models/'.length)));
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return await handleChat(manager, req, res);
    if (req.method === 'POST' && url.pathname === '/v1/completions') return await handleCompletion(manager, req, res);
    if (req.method === 'POST' && url.pathname === '/v1/responses') return await handleResponses(manager, req, res);
    return sendOpenAiError(manager, res, openAiError(`not found: ${req.method} ${url.pathname}`, 'not_found_error', 404));
  } catch (error) {
    return sendCaughtError(manager, res, error);
  }
}

function authorized(config, req) {
  const key = config.server.apiKey;
  if (!key) return true;
  return req.headers.authorization === `Bearer ${key}`;
}

function handleHealth(manager, res) {
  jsonResponse(res, 200, {
    ok: true,
    models: [...manager.pools.values()].map((pool) => ({
      model: pool.model,
      routing_strategy: pool.strategy,
      max_attempts_per_request: pool.maxAttemptsPerRequest,
      agents: pool.runtimes.map((runtime) => runtimeHealth(runtime))
    }))
  });
}

function handleModels(manager, res) {
  const created = now();
  const data = [...manager.pools.values()].map((pool) => ({
    id: pool.model,
    object: 'model',
    created,
    owned_by: pool.runtimes.length > 1 ? 'acp-agent-pool' : 'acp-agent',
    acp_agents: pool.runtimeIds,
    x_acp_pool_size: pool.runtimes.length,
    x_acp_routing_strategy: pool.strategy,
    x_acp_max_attempts: pool.maxAttemptsPerRequest
  }));
  jsonResponse(res, 200, { object: 'list', data });
}

function handleModel(manager, res, model) {
  const pool = manager.pool(model);
  jsonResponse(res, 200, {
    id: model,
    object: 'model',
    created: now(),
    owned_by: pool.runtimes.length > 1 ? 'acp-agent-pool' : 'acp-agent',
    acp_agents: pool.runtimeIds,
    x_acp_pool_size: pool.runtimes.length,
    x_acp_routing_strategy: pool.strategy,
    x_acp_max_attempts: pool.maxAttemptsPerRequest
  });
}

function runtimeHealth(runtime) {
  return {
    id: runtime.runtimeId,
    name: runtime.config.name,
    running: runtime.running,
    busy: runtime.busy,
    success_count: runtime.successCount,
    failure_count: runtime.failureCount,
    consecutive_failures: runtime.consecutiveFailures,
    last_error: runtime.lastError,
    last_failure_at: runtime.lastFailureAt,
    last_success_at: runtime.lastSuccessAt,
    cooldown_remaining_seconds: runtime.cooldownRemainingSeconds
  };
}

function validateRequest(body, kind) {
  if (kind === 'chat') buildChatPrompt(body, PERMISSIVE_CAPS);
  else if (kind === 'completion') buildCompletionPrompt(body);
  else buildResponsesPrompt(body, PERMISSIVE_CAPS);
}

async function handleChat(manager, req, res) {
  const body = await readJsonBody(req, manager.config.server.maxRequestBytes);
  const model = modelOrDefault(body, manager.defaultModel);
  const pool = manager.pool(model);
  if (body.stream) return streamEndpoint(manager, pool, req, res, body, model, 'chat');
  validateRequest(body, 'chat');
  const result = await runWithFailover(manager, pool, req, body, async (runtime) => {
    await runtime.ensureStarted();
    const promptBlocks = buildChatPrompt(body, runtime.connection.capabilities);
    const collected = await collectRuntime(runtime, promptBlocks, model);
    return { runtime, promptBlocks, ...collected };
  });
  const toolCalls = extractClientToolCalls(result.text, body);
  jsonResponse(res, 200, chatCompletionResponse(model, result.promptBlocks, result.text, result.stopReason, result.usage, toolCalls), {
    'x-acp-agent': result.runtime.runtimeId,
    'x-acp-model': model
  });
}

async function handleCompletion(manager, req, res) {
  const body = await readJsonBody(req, manager.config.server.maxRequestBytes);
  const model = modelOrDefault(body, manager.defaultModel);
  const pool = manager.pool(model);
  if (body.stream) return streamEndpoint(manager, pool, req, res, body, model, 'completion');
  validateRequest(body, 'completion');
  const result = await runWithFailover(manager, pool, req, body, async (runtime) => {
    await runtime.ensureStarted();
    const promptBlocks = buildCompletionPrompt(body);
    const collected = await collectRuntime(runtime, promptBlocks, model);
    return { runtime, promptBlocks, ...collected };
  });
  jsonResponse(res, 200, completionResponse(model, result.promptBlocks, result.text, result.stopReason, result.usage), {
    'x-acp-agent': result.runtime.runtimeId,
    'x-acp-model': model
  });
}

async function handleResponses(manager, req, res) {
  const body = await readJsonBody(req, manager.config.server.maxRequestBytes);
  const model = modelOrDefault(body, manager.defaultModel);
  const pool = manager.pool(model);
  if (body.stream) return streamEndpoint(manager, pool, req, res, body, model, 'responses');
  validateRequest(body, 'responses');
  const result = await runWithFailover(manager, pool, req, body, async (runtime) => {
    await runtime.ensureStarted();
    const promptBlocks = buildResponsesPrompt(body, runtime.connection.capabilities);
    const collected = await collectRuntime(runtime, promptBlocks, model);
    return { runtime, promptBlocks, ...collected };
  });
  jsonResponse(res, 200, responsesApiResponse(model, result.promptBlocks, result.text, result.stopReason, result.usage), {
    'x-acp-agent': result.runtime.runtimeId,
    'x-acp-model': model
  });
}

async function runWithFailover(manager, pool, req, body, operation) {
  const attempts = pool.attemptOrder(routingKeyFromRequest(req, body, pool.affinityPrefixChars));
  const failures = [];
  for (const runtime of attempts) {
    try {
      return await operation(runtime);
    } catch (error) {
      runtime.markFailure(error, manager.config.server.failureCooldownSeconds);
      manager.logger.warn('runtime attempt failed', { agent: runtime.runtimeId, model: pool.model, error });
      failures.push({ runtimeId: runtime.runtimeId, message: compactError(error), error });
      if (error instanceof AgentCapabilityError) continue;
      if (!isRetryableError(error, pool)) throw error;
      await maybeRetryBackoff(pool);
    }
  }
  if (allCandidateSpecificFailures(failures)) throw badRequest(formatCapabilityFailures(pool.model, failures));
  throw new AcpError(formatRouteFailures(pool.model, failures));
}

async function streamEndpoint(manager, pool, req, res, body, model, kind) {
  validateRequest(body, kind);
  const attempts = pool.attemptOrder(routingKeyFromRequest(req, body, pool.affinityPrefixChars));
  const failures = [];
  const includeUsage = Boolean(body.stream_options?.include_usage || body.streamOptions?.includeUsage);
  const bufferChatToolCalls = kind === 'chat' && clientToolContext(body).enabled;
  const responseId = kind === 'chat' ? makeId('chatcmpl') : kind === 'completion' ? makeId('cmpl') : makeId('resp');
  const created = now();
  const abort = new AbortController();
  req.on('aborted', () => abort.abort());
  let headersSent = false;
  let emitted = false;
  for (const runtime of attempts) {
    try {
      await runtime.ensureStarted();
      const promptBlocks = kind === 'chat' ? buildChatPrompt(body, runtime.connection.capabilities) : kind === 'completion' ? buildCompletionPrompt(body) : buildResponsesPrompt(body, runtime.connection.capabilities);
      if (!headersSent) {
        startSse(res, { 'x-acp-agent': runtime.runtimeId, 'x-acp-model': model });
        headersSent = true;
        if (kind === 'responses') res.write(sseData({ type: 'response.created', response: { id: responseId, object: 'response', created_at: created, status: 'in_progress', model } }));
      }
      let text = '';
      let usage = null;
      for await (const event of runtime.streamPrompt(promptBlocks, abort.signal, { model })) {
        if (event.kind === 'chunk' || event.kind === 'tool') {
          emitted = true;
          text += event.text || '';
          if (!bufferChatToolCalls) writeStreamDelta(res, kind, responseId, model, created, event.text || '');
        } else if (event.kind === 'usage') {
          usage = event.usage;
        } else if (event.kind === 'done') {
          writeBufferedChatToolResult(res, kind, bufferChatToolCalls, responseId, model, created, body, promptBlocks, text, event.stopReason, includeUsage ? usage : null);
          res.write(doneSse());
          res.end();
          return;
        }
      }
      writeBufferedChatToolResult(res, kind, bufferChatToolCalls, responseId, model, created, body, promptBlocks, text, 'end_turn', includeUsage ? usage : null);
      res.write(doneSse());
      res.end();
      return;
    } catch (error) {
      runtime.markFailure(error, manager.config.server.failureCooldownSeconds);
      manager.logger.warn('stream runtime attempt failed', { agent: runtime.runtimeId, model, error });
      failures.push({ runtimeId: runtime.runtimeId, message: compactError(error), error });
      if (emitted || error instanceof AgentCapabilityError || !isRetryableError(error, pool)) {
        if (!headersSent) return sendCaughtError(manager, res, error);
        res.write(sseEvent('error', { error: { message: compactError(error), type: 'acp_error', code: null } }));
        res.write(doneSse());
        res.end();
        return;
      }
      await maybeRetryBackoff(pool);
    }
  }
  const error = allCandidateSpecificFailures(failures) ? badRequest(formatCapabilityFailures(pool.model, failures)) : new AcpError(formatRouteFailures(pool.model, failures));
  if (!headersSent) return sendCaughtError(manager, res, error);
  res.write(sseEvent('error', { error: { message: compactError(error), type: 'acp_error', code: null } }));
  res.write(doneSse());
  res.end();
}

async function collectRuntime(runtime, promptBlocks, model) {
  let text = '';
  let stopReason = 'end_turn';
  let usage = null;
  for await (const event of runtime.streamPrompt(promptBlocks, undefined, { model })) {
    if (event.kind === 'chunk' || event.kind === 'tool') text += event.text || '';
    else if (event.kind === 'usage') usage = event.usage;
    else if (event.kind === 'done') stopReason = event.stopReason || 'end_turn';
  }
  return { text, stopReason, usage };
}

function writeStreamDelta(res, kind, id, model, created, deltaText) {
  if (kind === 'completion') {
    res.write(sseData({ id, object: 'text_completion', created, model, choices: [{ index: 0, text: deltaText, logprobs: null, finish_reason: null }] }));
  } else if (kind === 'responses') {
    res.write(sseData({ type: 'response.output_text.delta', response_id: id, output_index: 0, content_index: 0, delta: deltaText }));
  } else {
    res.write(sseData({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }] }));
  }
}

function writeBufferedChatToolResult(res, kind, buffered, id, model, created, body, promptBlocks, text, stopReason, usageOverride) {
  if (!buffered) return writeStreamFinal(res, kind, id, model, created, promptBlocks, text, stopReason, usageOverride);
  const toolCalls = extractClientToolCalls(text, body);
  if (toolCalls.length) {
    writeStreamToolCalls(res, id, model, created, toolCalls);
    return writeStreamFinal(res, 'chat', id, model, created, promptBlocks, text, 'tool_calls', usageOverride);
  }
  if (text) writeStreamDelta(res, 'chat', id, model, created, text);
  return writeStreamFinal(res, 'chat', id, model, created, promptBlocks, text, stopReason, usageOverride);
}

function writeStreamToolCalls(res, id, model, created, toolCalls) {
  res.write(sseData({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: { tool_calls: toolCalls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } })) },
      finish_reason: null
    }]
  }));
}

function writeStreamFinal(res, kind, id, model, created, promptBlocks, text, stopReason, usageOverride) {
  if (kind === 'completion') {
    res.write(sseData({ id, object: 'text_completion', created, model, choices: [{ index: 0, text: '', logprobs: null, finish_reason: finishReason(stopReason) }] }));
    if (usageOverride) res.write(sseData({ id, object: 'text_completion', created, model, choices: [], usage: responseUsage(promptBlocks, text, usageOverride) }));
  } else if (kind === 'responses') {
    const response = responsesApiResponse(model, promptBlocks, text, stopReason, usageOverride);
    response.id = id;
    response.created_at = created;
    res.write(sseData({ type: 'response.completed', response }));
  } else {
    res.write(sseData({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason(stopReason) }] }));
    if (usageOverride) res.write(sseData({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: responseUsage(promptBlocks, text, usageOverride) }));
  }
}

function startSse(res, headers = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    ...headers
  });
}

function sendCaughtError(manager, res, error) {
  const status = error.status || (error instanceof BadRequest ? 400 : 502);
  const type = error.type || (status === 400 ? 'invalid_request_error' : 'acp_error');
  manager.logger[status >= 500 ? 'error' : 'warn']('request failed', { status, type, error });
  return sendOpenAiError(manager, res, openAiError(compactError(error), type, status));
}

function sendOpenAiError(manager, res, errorObj) {
  if (res.headersSent) {
    res.end();
    return;
  }
  manager.logger.warn('sending error response', { status: errorObj.status, type: errorObj.body?.error?.type });
  jsonResponse(res, errorObj.status, errorObj.body);
}

function badRequest(message) {
  const err = new BadRequest(message);
  err.status = 400;
  err.type = 'invalid_request_error';
  return err;
}

function logRequest(logger, req, res) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const url = new URL(req.url || '/', 'http://localhost');
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http request', {
      method: req.method,
      path: url.pathname,
      status: res.statusCode,
      duration_ms: Number(durationMs.toFixed(1)),
      content_length: res.getHeader('content-length') ?? undefined,
      user_agent: req.headers['user-agent']
    });
  });
}
