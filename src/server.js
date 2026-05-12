import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AcpError, QueueFullError } from './acpClient.js';
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
  extractClientToolCalls,
  validateResourceLinks,
  noteIgnoredOpenAiFields
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
    req.requestId = makeId('req');
    res.setHeader('x-request-id', req.requestId);
    logRequest(manager.logger, req, res);
    handleRequest(manager, req, res).catch((error) => sendCaughtError(manager, res, error));
  });
  server.headersTimeout = config.server.requestHeaderTimeoutSeconds * 1000;
  server.keepAliveTimeout = config.server.keepAliveTimeoutSeconds * 1000;
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
    if (req.method === 'GET' && url.pathname === '/readyz') return handleReady(manager, res);
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
  if (key === undefined) return true;
  const header = String(req.headers.authorization ?? '');
  const match = /^bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(key);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function handleReady(manager, res) {
  const boot = manager.runtimes.filter((r) => r.config.startAtBoot);
  const notReady = boot.filter((r) => !r.running);
  if (notReady.length) {
    jsonResponse(res, 503, { ok: false, not_ready: notReady.map((r) => r.runtimeId) }, { 'retry-after': '1' });
    return;
  }
  jsonResponse(res, 200, { ok: true, ready: boot.map((r) => r.runtimeId), models: [...manager.pools.keys()] });
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
  const authMethods = runtime.connection?.authMethods ?? [];
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
    cooldown_remaining_seconds: runtime.cooldownRemainingSeconds,
    auth_required: authMethods.length > 0 && !runtime.config.assumeAuthed,
    auth_methods: authMethods.length ? authMethods.map((m) => m?.id ?? m?.name ?? m) : undefined
  };
}

function validateRequest(body, kind) {
  if (kind === 'chat') buildChatPrompt(body, PERMISSIVE_CAPS);
  else if (kind === 'completion') buildCompletionPrompt(body);
  else buildResponsesPrompt(body, PERMISSIVE_CAPS);
}

function responseHeadersFor(result, model) {
  const headers = { 'x-acp-agent': result.runtime.runtimeId, 'x-acp-model': model };
  if (result.upstreamModelId) headers['x-acp-upstream-model'] = result.upstreamModelId;
  return headers;
}

async function handleChat(manager, req, res) {
  const body = await readJsonBody(req, manager.config.server.maxRequestBytes);
  noteIgnoredOpenAiFields(body, manager.logger);
  const model = modelOrDefault(body, manager.defaultModel);
  req.requestModel = model;
  const pool = manager.pool(model);
  if (body.stream) return streamEndpoint(manager, pool, req, res, body, model, 'chat');
  validateRequest(body, 'chat');
  const result = await runWithFailover(manager, pool, req, res, body, async (runtime, signal) => {
    await runtime.ensureStarted();
    const promptBlocks = buildChatPrompt(body, runtime.connection.capabilities);
    validateResourceLinks(promptBlocks, manager.config.server.resourceLinks);
    const collected = await collectRuntime(runtime, promptBlocks, model, signal, req);
    return { runtime, promptBlocks, ...collected };
  });
  req.responseModel = result.upstreamModelId ?? null;
  const toolCalls = extractClientToolCalls(result.text, body);
  jsonResponse(res, 200, chatCompletionResponse(model, result.promptBlocks, result.text, result.stopReason, result.usage, toolCalls), responseHeadersFor(result, model));
}

async function handleCompletion(manager, req, res) {
  const body = await readJsonBody(req, manager.config.server.maxRequestBytes);
  noteIgnoredOpenAiFields(body, manager.logger);
  const model = modelOrDefault(body, manager.defaultModel);
  req.requestModel = model;
  const pool = manager.pool(model);
  if (body.stream) return streamEndpoint(manager, pool, req, res, body, model, 'completion');
  validateRequest(body, 'completion');
  const result = await runWithFailover(manager, pool, req, res, body, async (runtime, signal) => {
    await runtime.ensureStarted();
    const promptBlocks = buildCompletionPrompt(body);
    validateResourceLinks(promptBlocks, manager.config.server.resourceLinks);
    const collected = await collectRuntime(runtime, promptBlocks, model, signal, req);
    return { runtime, promptBlocks, ...collected };
  });
  req.responseModel = result.upstreamModelId ?? null;
  jsonResponse(res, 200, completionResponse(model, result.promptBlocks, result.text, result.stopReason, result.usage), responseHeadersFor(result, model));
}

async function handleResponses(manager, req, res) {
  const body = await readJsonBody(req, manager.config.server.maxRequestBytes);
  noteIgnoredOpenAiFields(body, manager.logger);
  const model = modelOrDefault(body, manager.defaultModel);
  req.requestModel = model;
  const pool = manager.pool(model);
  if (body.stream) return streamEndpoint(manager, pool, req, res, body, model, 'responses');
  validateRequest(body, 'responses');
  const result = await runWithFailover(manager, pool, req, res, body, async (runtime, signal) => {
    await runtime.ensureStarted();
    const promptBlocks = buildResponsesPrompt(body, runtime.connection.capabilities);
    validateResourceLinks(promptBlocks, manager.config.server.resourceLinks);
    const collected = await collectRuntime(runtime, promptBlocks, model, signal, req);
    return { runtime, promptBlocks, ...collected };
  });
  req.responseModel = result.upstreamModelId ?? null;
  jsonResponse(res, 200, responsesApiResponse(model, result.promptBlocks, result.text, result.stopReason, result.usage), responseHeadersFor(result, model));
}

async function runWithFailover(manager, pool, req, res, body, operation) {
  const attempts = pool.attemptOrder(routingKeyFromRequest(req, body, pool.affinityPrefixChars));
  const abort = clientAbortController(req, res);
  const failures = [];
  for (const runtime of attempts) {
    if (abort.signal.aborted) throw new ClientAbortError('client closed the connection');
    try {
      return await operation(runtime, abort.signal);
    } catch (error) {
      if (abort.signal.aborted) throw new ClientAbortError('client closed the connection');
      if (!(error instanceof QueueFullError)) {
        runtime.markFailure(error, manager.config.server.failureCooldownSeconds);
      }
      manager.logger.warn('runtime attempt failed', { agent: runtime.runtimeId, model: pool.model, error });
      failures.push({ runtimeId: runtime.runtimeId, message: compactError(error), error });
      if (error instanceof AgentCapabilityError) continue;
      if (!isRetryableError(error, pool)) throw error;
      await maybeRetryBackoff(pool);
    }
  }
  if (allCandidateSpecificFailures(failures)) throw badRequest(formatCapabilityFailures(pool.model, failures));
  if (failures.length > 0 && failures.every((f) => f.error instanceof QueueFullError)) {
    const err = new AcpError(`all agents for model ${JSON.stringify(pool.model)} are at queue capacity; try again shortly`);
    err.status = 503; err.type = 'service_unavailable';
    throw err;
  }
  throw new AcpError(formatRouteFailures(pool.model, failures));
}

class ClientAbortError extends Error { constructor(message) { super(message); this.name = 'ClientAbortError'; this.status = 499; this.type = 'client_closed_request'; } }

async function streamEndpoint(manager, pool, req, res, body, model, kind) {
  validateRequest(body, kind);
  req.requestModel = model;
  const attempts = pool.attemptOrder(routingKeyFromRequest(req, body, pool.affinityPrefixChars));
  const failures = [];
  const includeUsage = Boolean(body.stream_options?.include_usage || body.streamOptions?.includeUsage);
  const bufferChatToolCalls = kind === 'chat' && clientToolContext(body).enabled;
  const responseId = kind === 'chat' ? makeId('chatcmpl') : kind === 'completion' ? makeId('cmpl') : makeId('resp');
  const created = now();
  const abort = clientAbortController(req, res);
  let headersSent = false;
  let emitted = false;
  for (const runtime of attempts) {
    if (abort.signal.aborted) return;
    try {
      await runtime.ensureStarted();
      const promptBlocks = kind === 'chat' ? buildChatPrompt(body, runtime.connection.capabilities) : kind === 'completion' ? buildCompletionPrompt(body) : buildResponsesPrompt(body, runtime.connection.capabilities);
      validateResourceLinks(promptBlocks, manager.config.server.resourceLinks);
      let text = '';
      let usage = null;
      for await (const event of runtime.streamPrompt(promptBlocks, abort.signal, { model })) {
        if (abort.signal.aborted || !sseWritable(res)) break;
        if (event.kind === 'session_ready') {
          req.responseModel = event.upstreamModelId ?? null;
          if (!headersSent) {
            const headers = { 'x-acp-agent': runtime.runtimeId, 'x-acp-model': model };
            if (event.upstreamModelId) headers['x-acp-upstream-model'] = event.upstreamModelId;
            startSse(res, headers);
            headersSent = true;
            if (kind === 'chat' && !bufferChatToolCalls) {
              await writeSse(res, sseData({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }));
            }
            if (kind === 'responses') await writeSse(res, sseData({ type: 'response.created', response: { id: responseId, object: 'response', created_at: created, status: 'in_progress', model } }));
          }
          continue;
        }
        if (event.kind === 'chunk' || event.kind === 'tool') {
          emitted = true;
          text += event.text || '';
          if (!bufferChatToolCalls) await writeStreamDelta(res, kind, responseId, model, created, event.text || '');
        } else if (event.kind === 'usage') {
          usage = event.usage;
        } else if (event.kind === 'done') {
          await writeBufferedChatToolResult(res, kind, bufferChatToolCalls, responseId, model, created, body, promptBlocks, text, event.stopReason, includeUsage ? usage : null);
          if (sseWritable(res)) { await writeSse(res, doneSse()); res.end(); }
          return;
        }
      }
      if (abort.signal.aborted) return;
      await writeBufferedChatToolResult(res, kind, bufferChatToolCalls, responseId, model, created, body, promptBlocks, text, 'end_turn', includeUsage ? usage : null);
      if (sseWritable(res)) { await writeSse(res, doneSse()); res.end(); }
      return;
    } catch (error) {
      if (abort.signal.aborted) return;
      runtime.markFailure(error, manager.config.server.failureCooldownSeconds);
      manager.logger.warn('stream runtime attempt failed', { agent: runtime.runtimeId, model, error });
      failures.push({ runtimeId: runtime.runtimeId, message: compactError(error), error });
      if (emitted || error instanceof AgentCapabilityError || !isRetryableError(error, pool)) {
        if (!headersSent) return sendCaughtError(manager, res, error);
        if (sseWritable(res)) {
          await writeSse(res, sseEvent('error', { error: { message: compactError(error), type: 'acp_error', code: null } }));
          await writeSse(res, doneSse());
          res.end();
        }
        return;
      }
      await maybeRetryBackoff(pool);
    }
  }
  const error = allCandidateSpecificFailures(failures) ? badRequest(formatCapabilityFailures(pool.model, failures)) : new AcpError(formatRouteFailures(pool.model, failures));
  if (!headersSent) return sendCaughtError(manager, res, error);
  if (sseWritable(res)) {
    await writeSse(res, sseEvent('error', { error: { message: compactError(error), type: 'acp_error', code: null } }));
    await writeSse(res, doneSse());
    res.end();
  }
}

async function collectRuntime(runtime, promptBlocks, model, signal = undefined, req = null) {
  let text = '';
  let stopReason = 'end_turn';
  let usage = null;
  let upstreamModelId = null;
  for await (const event of runtime.streamPrompt(promptBlocks, signal, { model })) {
    if (signal?.aborted) break;
    if (event.kind === 'session_ready') {
      upstreamModelId = event.upstreamModelId;
      if (req && event.upstreamModelId) req.responseModel = event.upstreamModelId;
    } else if (event.kind === 'chunk' || event.kind === 'tool') text += event.text || '';
    else if (event.kind === 'usage') usage = event.usage;
    else if (event.kind === 'done') stopReason = event.stopReason || 'end_turn';
  }
  return { text, stopReason, usage, upstreamModelId };
}

async function writeStreamDelta(res, kind, id, model, created, deltaText) {
  if (kind === 'completion') {
    await writeSse(res, sseData({ id, object: 'text_completion', created, model, choices: [{ index: 0, text: deltaText, logprobs: null, finish_reason: null }] }));
  } else if (kind === 'responses') {
    await writeSse(res, sseData({ type: 'response.output_text.delta', response_id: id, output_index: 0, content_index: 0, delta: deltaText }));
  } else {
    await writeSse(res, sseData({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }] }));
  }
}

async function writeBufferedChatToolResult(res, kind, buffered, id, model, created, body, promptBlocks, text, stopReason, usageOverride) {
  if (!buffered) return writeStreamFinal(res, kind, id, model, created, promptBlocks, text, stopReason, usageOverride);
  const toolCalls = extractClientToolCalls(text, body);
  if (toolCalls.length) {
    await writeStreamToolCalls(res, id, model, created, toolCalls);
    return writeStreamFinal(res, 'chat', id, model, created, promptBlocks, text, 'tool_calls', usageOverride);
  }
  if (text) await writeStreamDelta(res, 'chat', id, model, created, text);
  return writeStreamFinal(res, 'chat', id, model, created, promptBlocks, text, stopReason, usageOverride);
}

async function writeStreamToolCalls(res, id, model, created, toolCalls) {
  await writeSse(res, sseData({
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

async function writeStreamFinal(res, kind, id, model, created, promptBlocks, text, stopReason, usageOverride) {
  if (kind === 'completion') {
    await writeSse(res, sseData({ id, object: 'text_completion', created, model, choices: [{ index: 0, text: '', logprobs: null, finish_reason: finishReason(stopReason) }] }));
    if (usageOverride) await writeSse(res, sseData({ id, object: 'text_completion', created, model, choices: [], usage: responseUsage(promptBlocks, text, usageOverride) }));
  } else if (kind === 'responses') {
    await writeSse(res, sseData({ type: 'response.output_text.done', response_id: id, output_index: 0, content_index: 0, text }));
    const response = responsesApiResponse(model, promptBlocks, text, stopReason, usageOverride);
    response.id = id;
    response.created_at = created;
    await writeSse(res, sseData({ type: 'response.completed', response }));
  } else {
    await writeSse(res, sseData({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason(stopReason) }] }));
    if (usageOverride) await writeSse(res, sseData({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: responseUsage(promptBlocks, text, usageOverride) }));
  }
}

function startSse(res, headers = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    ...headers
  });
  res.flushHeaders();
}

function clientAbortController(req, res) {
  const abort = new AbortController();
  const onAbort = () => { if (!res.writableEnded) abort.abort(); };
  res.on('close', onAbort);
  req.on('close', onAbort);
  return abort;
}

function sseWritable(res) {
  return !res.writableEnded && !res.destroyed;
}

async function writeSse(res, chunk) {
  if (!sseWritable(res)) return false;
  if (res.write(chunk)) return true;
  await new Promise((resolve) => res.once('drain', resolve));
  return sseWritable(res);
}

function sendCaughtError(manager, res, error) {
  if (error instanceof ClientAbortError) {
    if (!res.writableEnded) res.end();
    return;
  }
  const status = error.status || (error instanceof BadRequest ? 400 : 502);
  const type = error.type || (status === 400 ? 'invalid_request_error' : 'acp_error');
  const headers = status === 503 ? { 'retry-after': '1' } : {};
  manager.logger[status >= 500 ? 'error' : 'warn']('request failed', { status, type, error });
  return sendOpenAiError(manager, res, openAiError(compactError(error), type, status, null), headers);
}

function sendOpenAiError(manager, res, errorObj, extraHeaders = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  manager.logger.warn('sending error response', { status: errorObj.status, type: errorObj.body?.error?.type });
  jsonResponse(res, errorObj.status, errorObj.body, extraHeaders);
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
      request_id: req.requestId,
      method: req.method,
      path: url.pathname,
      status: res.statusCode,
      duration_ms: Number(durationMs.toFixed(1)),
      request_model: req.requestModel ?? undefined,
      response_model: req.responseModel ?? undefined,
      content_length: res.getHeader('content-length') ?? undefined,
      user_agent: req.headers['user-agent']
    });
  });
}
