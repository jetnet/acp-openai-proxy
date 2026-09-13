#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';

const LABEL = process.env.ACP_FAKE_LABEL || process.env.FAKE_AGENT_LABEL || '';
const FAIL_INITIALIZE = ['1', 'true', 'yes'].includes(String(process.env.ACP_FAKE_FAIL_INITIALIZE || '').toLowerCase());
const FAIL_PROMPT = String(process.env.ACP_FAKE_FAIL_PROMPT || '').toLowerCase();
const NO_IMAGE = ['1', 'true', 'yes'].includes(String(process.env.ACP_FAKE_NO_IMAGE || '').toLowerCase());
const MODEL_OPTIONS = String(process.env.ACP_FAKE_MODEL_OPTIONS || '').split(',').map((x) => x.trim()).filter(Boolean);
const TOOL_CALL = String(process.env.ACP_FAKE_TOOL_CALL || '');
const SLOW_STREAM_MS = Number(process.env.ACP_FAKE_SLOW_STREAM_MS || 0);
const PROMPT_DELAY_MS = Number(process.env.ACP_FAKE_PROMPT_DELAY_MS || 0);
const CANCEL_LOG = process.env.ACP_FAKE_CANCEL_LOG || '';
const STOP_REASON = String(process.env.ACP_FAKE_STOP_REASON || 'end_turn');
let sessionCounter = 0;
const sessions = new Map();
const cancellers = new Map();

function send(obj) { process.stdout.write(`${JSON.stringify(obj)}\n`); }
function result(req, value) { send({ jsonrpc: '2.0', id: req.id, result: value }); }
function error(req, message, code = -32000) { send({ jsonrpc: '2.0', id: req.id, error: { code, message } }); }

function configOptions(currentValue = MODEL_OPTIONS[0]) {
  if (!MODEL_OPTIONS.length) return undefined;
  return [{
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options: MODEL_OPTIONS.map((value) => ({ value, name: value }))
  }];
}

function textFromBlocks(blocks) {
  const out = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') out.push(String(block.text || ''));
    else if (block.type === 'resource_link') out.push(String(block.uri || ''));
    else if (block.type === 'image') out.push(`[image:${block.mimeType || 'unknown'}]`);
    else if (block.type === 'audio') out.push(`[audio:${block.mimeType || 'unknown'}]`);
    else if (block.type === 'resource') out.push(`[resource:${block.resource?.uri || block.resource?.mimeType || 'inline'}]`);
  }
  return out.join('\n');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    if (FAIL_INITIALIZE) { error(msg, 'fake initialize failure'); process.exit(2); }
    result(msg, {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: !NO_IMAGE, audio: true, embeddedContext: true },
        sessionCapabilities: { close: {} }
      },
      agentInfo: { name: 'fake-acp-agent', version: '0.0.0' },
      authMethods: []
    });
  } else if (msg.method === 'session/new') {
    sessionCounter += 1;
    const sessionId = `session-${sessionCounter}`;
    sessions.set(sessionId, { model: MODEL_OPTIONS[0] || '' });
    const response = { sessionId };
    const options = configOptions();
    if (options) response.configOptions = options;
    result(msg, response);
  } else if (msg.method === 'session/set_config_option') {
    const sessionId = msg.params?.sessionId;
    const value = String(msg.params?.value ?? '');
    if (!sessions.has(sessionId)) return error(msg, 'unknown session', -32001);
    if (msg.params?.configId !== 'model') return error(msg, 'unknown config option', -32602);
    if (MODEL_OPTIONS.length && !MODEL_OPTIONS.includes(value)) return error(msg, `unsupported model ${value}`, -32602);
    sessions.get(sessionId).model = value;
    result(msg, { configOptions: configOptions(value) ?? [] });
  } else if (msg.method === 'session/prompt') {
    if (FAIL_PROMPT === 'rate_limit' || FAIL_PROMPT === 'always' || FAIL_PROMPT === 'before_chunk') {
      error(msg, `fake ACP failure from ${LABEL || 'agent'}: rate limit exhausted`, 429);
      return;
    }
    if (FAIL_PROMPT === 'blocked') {
      error(msg, `fake ACP failure from ${LABEL || 'agent'}: account blocked`, 403);
      return;
    }
    if (FAIL_PROMPT === 'exit') process.exit(23);
    const sessionId = msg.params?.sessionId;
    const prompt = textFromBlocks(msg.params?.prompt);
    if (PROMPT_DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, PROMPT_DELAY_MS));
    if (SLOW_STREAM_MS > 0) {
      let cancelled = false;
      cancellers.set(sessionId, () => { cancelled = true; });
      let i = 0;
      while (!cancelled && i < 60) {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `slow-chunk-${i} ` } } } });
        await new Promise((resolve) => setTimeout(resolve, SLOW_STREAM_MS));
        i += 1;
      }
      cancellers.delete(sessionId);
      result(msg, { stopReason: cancelled ? 'cancelled' : 'end_turn', usage: { input_tokens: 1, output_tokens: i, total_tokens: 1 + i } });
      return;
    }
    if (TOOL_CALL) {
      const splitAt = TOOL_CALL.indexOf(':');
      const name = splitAt < 0 ? TOOL_CALL : TOOL_CALL.slice(0, splitAt);
      const rawArgs = splitAt < 0 ? '{}' : TOOL_CALL.slice(splitAt + 1);
      let args;
      try { args = JSON.parse(rawArgs); } catch { args = { value: rawArgs }; }
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ tool_calls: [{ name, arguments: args }] }) } } } });
      result(msg, { stopReason: 'end_turn', usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } });
      return;
    }
    const selectedModel = sessions.get(sessionId)?.model;
    const bits = [LABEL, selectedModel].filter(Boolean).join('/');
    const leak = process.env.ACP_FAKE_LEAK_TEST;
    const leakTag = leak ? `(LEAK:${leak})` : '';
    const prefix = bits ? `Echo[${bits}]${leakTag}: ` : `Echo${leakTag}: `;
    for (const [index, chunk] of [prefix, prompt].entries()) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } } });
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (FAIL_PROMPT === 'after_chunk' && index === 0) {
        error(msg, `fake ACP failure after chunk from ${LABEL || 'agent'}`);
        return;
      }
    }
    result(msg, { stopReason: STOP_REASON, usage: { input_tokens: 40, output_tokens: 7, total_tokens: 47, cached_read_tokens: 3 } });
  } else if (msg.method === 'session/close') {
    sessions.delete(msg.params?.sessionId);
    result(msg, {});
  } else if (msg.method === 'session/cancel') {
    const sid = msg.params?.sessionId;
    if (CANCEL_LOG) { try { appendFileSync(CANCEL_LOG, `${sid ?? '?'}\n`); } catch {} }
    const cb = cancellers.get(sid);
    if (cb) cb();
  } else {
    error(msg, `no such method: ${msg.method}`, -32601);
  }
});
