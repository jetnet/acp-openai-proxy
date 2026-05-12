import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AcpOpenAiServer } from '../src/server.js';
import { normalizeConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { permissionLooksReadOnly } from '../src/acpClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');
const FAKE = path.join(__dirname, 'fake-acp-agent.js');

function config(raw) {
  return normalizeConfig(raw, PROJECT);
}

async function withApp(raw, fn) {
  const app = new AcpOpenAiServer(config(raw), { logger: createLogger({ level: 'silent' }) });
  await app.startAtBoot();
  const address = await app.listen();
  const baseUrl = `http://${address.address}:${address.port}`;
  try {
    await fn({ app, baseUrl });
  } finally {
    await app.close();
  }
}

function agent(name, label, extraEnv = {}) {
  return {
    name,
    instanceId: `${name}-${label}`,
    command: process.execPath,
    args: [FAKE],
    cwd: '.',
    models: ['gemini'],
    env: { ACP_FAKE_LABEL: label, ...extraEnv },
    permission: 'deny'
  };
}

async function post(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret', ...headers },
    body: JSON.stringify(body)
  });
}

const baseServer = {
  host: '127.0.0.1',
  port: 0,
  apiKey: 'secret',
  requestTimeoutSeconds: 5,
  failureCooldownSeconds: 30,
  retryBackoffSeconds: 0
};

test('logger writes info to stdout and warnings/errors to stderr', () => {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const stdout = [];
  const stderr = [];
  process.stdout.write = (chunk, ...args) => { stdout.push(String(chunk)); if (typeof args.at(-1) === 'function') args.at(-1)(); return true; };
  process.stderr.write = (chunk, ...args) => { stderr.push(String(chunk)); if (typeof args.at(-1) === 'function') args.at(-1)(); return true; };
  try {
    const logger = createLogger({ level: 'debug', service: 'test-service' });
    logger.info('hello', { route: '/health' });
    logger.warn('careful', { status: 429 });
    logger.error('failed', new Error('boom'));
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }

  assert.equal(stdout.length, 1);
  assert.equal(stderr.length, 2);
  assert.equal(JSON.parse(stdout[0]).level, 'info');
  assert.equal(JSON.parse(stderr[0]).level, 'warn');
  const errorLog = JSON.parse(stderr[1]);
  assert.equal(errorLog.level, 'error');
  assert.equal(errorLog.error.message, 'boom');
});

test('logger supports text output format', () => {
  const stdoutWrite = process.stdout.write;
  const stdout = [];
  process.stdout.write = (chunk, ...args) => { stdout.push(String(chunk)); if (typeof args.at(-1) === 'function') args.at(-1)(); return true; };
  try {
    const logger = createLogger({ level: 'info', format: 'text', service: 'test-service' });
    logger.info('hello', { route: '/health' });
  } finally {
    process.stdout.write = stdoutWrite;
  }

  assert.equal(stdout.length, 1);
  assert.match(stdout[0], / INFO test-service: hello /);
  assert.match(stdout[0], /"route":"\/health"/);
});

test('config normalizes logging options', () => {
  const cfg = config({
    server: { ...baseServer, logging: { level: 'warn', format: 'text' } },
    agents: [agent('gemini', 'a')]
  });
  assert.deepEqual(cfg.logging, { level: 'warn', format: 'text' });
  assert.throws(() => config({ server: { ...baseServer, logging: { format: 'xml' } }, agents: [agent('gemini', 'a')] }), /logging\.format/);
  assert.throws(() => config({ server: { ...baseServer, logging: { level: 'trace' } }, agents: [agent('gemini', 'a')] }), /logging\.level/);
});


test('agent env supports {var:NAME} expansion and rejects removed env_sections', () => {
  const old = process.env.ACP_PROXY_TEST_SECRET;
  process.env.ACP_PROXY_TEST_SECRET = 'expanded-secret';
  try {
    const cfg = config({
      server: baseServer,
      agents: [{
        name: 'gemini',
        command: process.execPath,
        args: [FAKE],
        models: ['gemini'],
        env: { GEMINI_API_KEY: '{var:ACP_PROXY_TEST_SECRET}' }
      }]
    });
    assert.equal(cfg.agents[0].env.GEMINI_API_KEY, 'expanded-secret');
    assert.throws(() => config({ env_sections: { old: {} }, agents: [agent('gemini', 'a')] }), /env_sections/);
    assert.throws(() => config({ agents: [{ ...agent('gemini', 'a'), env_section: 'old' }] }), /env_section/);
  } finally {
    if (old === undefined) delete process.env.ACP_PROXY_TEST_SECRET;
    else process.env.ACP_PROXY_TEST_SECRET = old;
  }
});

test('model_selection maps OpenAI model ids to ACP session config values', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'primary_failover', maxRetries: 1 },
    agents: [{
      ...agent('gemini', 'a', { ACP_FAKE_MODEL_OPTIONS: 'flash,pro' }),
      models: ['gemini-flash', 'gemini-pro'],
      model_selection: {
        config_id: 'model',
        values: {
          'gemini-flash': 'flash',
          'gemini-pro': 'pro'
        }
      }
    }]
  }, async ({ baseUrl }) => {
    const pro = await post(baseUrl, { model: 'gemini-pro', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(pro.status, 200);
    const proBody = await pro.json();
    assert.match(proBody.choices[0].message.content, /Echo\[a\/pro\]/);

    const flash = await post(baseUrl, { model: 'gemini-flash', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(flash.status, 200);
    const flashBody = await flash.json();
    assert.match(flashBody.choices[0].message.content, /Echo\[a\/flash\]/);
  });
});

test('duplicate model ids create a pool and round_robin rotates requests', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'round_robin', maxRetries: 1 },
    agents: [agent('gemini', 'a'), agent('gemini', 'b')]
  }, async ({ baseUrl }) => {
    const models = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: 'Bearer secret' } }).then((r) => r.json());
    assert.deepEqual(models.data[0].acp_agents, ['gemini-a', 'gemini-b']);
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await post(baseUrl, { model: 'gemini', messages: [{ role: 'user', content: `hello ${i}` }] });
      assert.equal(r.status, 200);
      seen.push(r.headers.get('x-acp-agent'));
      const body = await r.json();
      assert.match(body.choices[0].message.content, /Echo\[[ab]\]/);
    }
    assert.deepEqual(seen, ['gemini-a', 'gemini-b', 'gemini-a']);
  });
});

test('primary_failover retries next runtime for quota-like failures', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'primary_failover', maxRetries: 1 },
    agents: [agent('gemini', 'bad', { ACP_FAKE_FAIL_PROMPT: 'rate_limit' }), agent('gemini', 'good')]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, { model: 'gemini', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-acp-agent'), 'gemini-good');
    const health = await fetch(`${baseUrl}/health`).then((x) => x.json());
    const bad = health.models[0].agents.find((a) => a.id === 'gemini-bad');
    assert.equal(bad.failure_count, 1);
    assert.ok(bad.cooldown_remaining_seconds > 0);
  });
});

test('all runtimes failing returns 502 after maxRetries full-pool attempts', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'round_robin', maxRetries: 2, failureCooldownSeconds: 0 },
    agents: [agent('gemini', 'a', { ACP_FAKE_FAIL_PROMPT: 'rate_limit' }), agent('gemini', 'b', { ACP_FAKE_FAIL_PROMPT: 'rate_limit' })]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, { model: 'gemini', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.match(body.error.message, /after 4 attempt/);
  });
});

test('sticky_failover keeps the same routing key on the same runtime', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'sticky_failover', maxRetries: 1 },
    agents: [agent('gemini', 'a'), agent('gemini', 'b')]
  }, async ({ baseUrl }) => {
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await post(baseUrl, { model: 'gemini', user: 'same-user', messages: [{ role: 'user', content: `turn ${i}` }] });
      assert.equal(r.status, 200);
      seen.push(r.headers.get('x-acp-agent'));
    }
    assert.equal(new Set(seen).size, 1);
  });
});

test('multimodal data URI image is forwarded to ACP image block', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'primary_failover', maxRetries: 1 },
    agents: [agent('gemini', 'a')]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, {
      model: 'gemini',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }
      ] }]
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.match(body.choices[0].message.content, /\[image:image\/png\]/);
  });
});

test('OpenAI client-side tools return chat tool_calls for the client to execute', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'primary_failover' },
    agents: [agent('gemini', 'a', { ACP_FAKE_TOOL_CALL: 'get_weather:{"location":"New York, USA"}' })]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, {
      model: 'gemini',
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get current weather', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } } }],
      tool_choice: 'auto',
      messages: [{ role: 'user', content: 'weather in New York' }]
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.content, null);
    assert.equal(body.choices[0].message.tool_calls[0].type, 'function');
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), { location: 'New York, USA' });
  });
});

test('chat streaming buffers client tool calls and emits tool_call deltas', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'primary_failover' },
    agents: [agent('gemini', 'a', { ACP_FAKE_TOOL_CALL: 'get_weather:{"location":"New York, USA"}' })]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, {
      model: 'gemini',
      stream: true,
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } } }],
      messages: [{ role: 'user', content: 'weather in New York' }]
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /"tool_calls"/);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.match(text, /data: \[DONE\]/);
  });
});


test('chat streaming emits SSE chunks and DONE', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'round_robin', maxRetries: 1 },
    agents: [agent('gemini', 'a')]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, { model: 'gemini', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'stream me' }] });
    if (r.status !== 200) assert.fail(await r.text());
    assert.equal(r.headers.get('content-type').startsWith('text/event-stream'), true);
    assert.equal(r.headers.get('x-acp-agent'), 'gemini-a');
    const text = await r.text();
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /"usage"/);
    assert.match(text, /data: \[DONE\]/);
  });
});

test('streaming usage emits finish chunk without usage then a separate choices:[] usage chunk', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'round_robin' },
    agents: [agent('gemini', 'a')]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, { model: 'gemini', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    const lines = (await r.text()).split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)));
    const finishChunk = lines.find((c) => c.choices?.[0]?.finish_reason === 'stop');
    assert.ok(finishChunk, 'should have a finish_reason:stop chunk');
    assert.equal(finishChunk.usage, undefined, 'finish chunk must not carry usage');
    const usageChunk = lines.find((c) => Array.isArray(c.choices) && c.choices.length === 0 && c.usage);
    assert.ok(usageChunk, 'should have a separate usage-only chunk');
    assert.ok(usageChunk.usage.total_tokens > 0);
  });
});

test('image capability gating returns 400 when agent does not advertise image support', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'primary_failover', maxRetries: 1 },
    agents: [agent('gemini', 'a', { ACP_FAKE_NO_IMAGE: '1' })]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, {
      model: 'gemini',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }]
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error.message, /image/i);
  });
});

test('model_selection with required:false succeeds when requested model id has no mapped value', async () => {
  await withApp({
    server: { ...baseServer },
    agents: [{
      ...agent('gemini', 'a', { ACP_FAKE_MODEL_OPTIONS: 'flash,pro' }),
      models: ['gemini'],
      model_selection: { config_id: 'model', required: false, values: { 'gemini-flash': 'flash' } }
    }]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, { model: 'gemini', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(r.status, 200);
  });
});

test('max_request_bytes config enforces 413 for oversized bodies', async () => {
  await withApp({
    server: { ...baseServer, maxRequestBytes: 1024 },
    agents: [agent('gemini', 'a')]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, { model: 'gemini', messages: [{ role: 'user', content: 'x'.repeat(1100) }] });
    assert.equal(r.status, 413);
  });
});

test('conversation_id body field provides sticky routing affinity', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'sticky_failover', maxRetries: 1 },
    agents: [agent('gemini', 'a'), agent('gemini', 'b')]
  }, async ({ baseUrl }) => {
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await post(baseUrl, { model: 'gemini', conversation_id: 'convo-xyz', messages: [{ role: 'user', content: `turn ${i}` }] });
      assert.equal(r.status, 200);
      seen.push(r.headers.get('x-acp-agent'));
    }
    assert.equal(new Set(seen).size, 1, 'all requests with same conversation_id should route to the same agent');
  });
});

test('config rejects non-numeric max_request_bytes (closes NaN bypass)', () => {
  assert.throws(
    () => config({ server: { ...baseServer, max_request_bytes: 'oops' }, agents: [agent('gemini', 'a')] }),
    /max_request_bytes/
  );
  assert.throws(
    () => config({ server: { ...baseServer, port: 'not-a-number' }, agents: [agent('gemini', 'a')] }),
    /server\.port/
  );
  assert.throws(
    () => config({ server: { ...baseServer, requestTimeoutSeconds: 'soon' }, agents: [agent('gemini', 'a')] }),
    /request_timeout_seconds/
  );
});

test('config rejects empty api_key explicitly', () => {
  assert.throws(
    () => config({ server: { ...baseServer, apiKey: '' }, agents: [agent('gemini', 'a')] }),
    /api_key is set but empty/
  );
});

test('config rejects non-loopback host without api_key unless allow_unauthenticated', () => {
  assert.throws(
    () => config({ server: { host: '0.0.0.0', port: 0 }, agents: [agent('gemini', 'a')] }),
    /api_key is required when server\.host/
  );
  // Explicit opt-in succeeds
  const cfg = config({
    server: { host: '0.0.0.0', port: 0, allow_unauthenticated: true },
    agents: [agent('gemini', 'a')]
  });
  assert.equal(cfg.server.host, '0.0.0.0');
});

test('bearer auth accepts lowercase scheme and rejects mismatched length', async () => {
  await withApp({
    server: { ...baseServer },
    agents: [agent('gemini', 'a')]
  }, async ({ baseUrl }) => {
    const ok = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: 'bearer secret' } });
    assert.equal(ok.status, 200);
    const wrong = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: 'Bearer secre' } });
    assert.equal(wrong.status, 401);
    const wrong2 = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: 'Bearer wrongkey' } });
    assert.equal(wrong2.status, 401);
  });
});

test('expandEnv {var:NAME:?msg} throws on missing required env', async () => {
  const { expandEnv } = await import('../src/config.js');
  const previous = process.env.ACP_TEST_REQUIRED_VAR;
  try {
    delete process.env.ACP_TEST_REQUIRED_VAR;
    assert.throws(() => expandEnv('{var:ACP_TEST_REQUIRED_VAR:?must be set}'),
      /required environment variable ACP_TEST_REQUIRED_VAR is not set: must be set/);
    process.env.ACP_TEST_REQUIRED_VAR = 'present';
    assert.equal(expandEnv('{var:ACP_TEST_REQUIRED_VAR:?must be set}'), 'present');
    assert.equal(expandEnv('${ACP_TEST_REQUIRED_VAR:?must be set}'), 'present');
    // :- fallback still works
    delete process.env.ACP_TEST_REQUIRED_VAR;
    assert.equal(expandEnv('{var:ACP_TEST_REQUIRED_VAR:-default}'), 'default');
  } finally {
    if (previous === undefined) delete process.env.ACP_TEST_REQUIRED_VAR;
    else process.env.ACP_TEST_REQUIRED_VAR = previous;
  }
});

test('permissionLooksReadOnly uses ACP kind directly and tightens fallback regex', () => {
  // ACP-spec kinds win regardless of title content.
  assert.equal(permissionLooksReadOnly({ toolCall: { kind: 'read', title: 'read_file' } }), true);
  assert.equal(permissionLooksReadOnly({ toolCall: { kind: 'fetch', title: 'http_get' } }), true);
  assert.equal(permissionLooksReadOnly({ toolCall: { kind: 'execute', title: 'echo hi' } }), false);
  assert.equal(permissionLooksReadOnly({ toolCall: { kind: 'delete', title: 'rm note' } }), false);
  // No kind: fall back to word-boundary regex. Tighter than the previous substring match.
  assert.equal(permissionLooksReadOnly({ toolCall: { title: 'search_excerpt' } }), true, 'search_excerpt no longer false-blocks on exec substring');
  assert.equal(permissionLooksReadOnly({ toolCall: { title: 'git push origin main' } }), false);
  assert.equal(permissionLooksReadOnly({ toolCall: { title: 'cat foo > bar.txt' } }), false);
  assert.equal(permissionLooksReadOnly({ toolCall: { title: 'npm install something' } }), false);
  // Empty / unstructured params: deny by default.
  assert.equal(permissionLooksReadOnly({}), false);
});

test('env_passthrough default does not leak unrelated parent env to agent', async () => {
  const original = process.env.ACP_FAKE_LEAK_TEST;
  process.env.ACP_FAKE_LEAK_TEST = 'leaky-secret-abc';
  try {
    await withApp({
      server: { ...baseServer },
      agents: [agent('gemini', 'a')]
    }, async ({ baseUrl }) => {
      const r = await post(baseUrl, { model: 'gemini', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.doesNotMatch(body.choices[0].message.content, /leaky-secret-abc/, 'agent should not see ACP_FAKE_LEAK_TEST');
    });
  } finally {
    if (original === undefined) delete process.env.ACP_FAKE_LEAK_TEST;
    else process.env.ACP_FAKE_LEAK_TEST = original;
  }
});

test('env_passthrough wildcard inherits all parent env to agent', async () => {
  const original = process.env.ACP_FAKE_LEAK_TEST;
  process.env.ACP_FAKE_LEAK_TEST = 'inherited-xyz';
  try {
    await withApp({
      server: { ...baseServer, env_passthrough: ['*'] },
      agents: [agent('gemini', 'a')]
    }, async ({ baseUrl }) => {
      const r = await post(baseUrl, { model: 'gemini', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.match(body.choices[0].message.content, /inherited-xyz/, 'agent should see the parent env when wildcard is set');
    });
  } finally {
    if (original === undefined) delete process.env.ACP_FAKE_LEAK_TEST;
    else process.env.ACP_FAKE_LEAK_TEST = original;
  }
});

test('X-ACP-Routing-Key header keeps requests on the same runtime under sticky_failover', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'sticky_failover', maxRetries: 1 },
    agents: [agent('gemini', 'a'), agent('gemini', 'b')]
  }, async ({ baseUrl }) => {
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret', 'x-acp-routing-key': 'header-keyed' },
        body: JSON.stringify({ model: 'gemini', messages: [{ role: 'user', content: `turn ${i}` }] })
      });
      assert.equal(r.status, 200);
      seen.push(r.headers.get('x-acp-agent'));
    }
    assert.equal(new Set(seen).size, 1, 'X-ACP-Routing-Key should pin sticky_failover to one agent');
  });
});

test('least_busy strategy picks the idle runtime', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'least_busy', maxRetries: 1 },
    agents: [agent('gemini', 'a'), agent('gemini', 'b')]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, { model: 'gemini', messages: [{ role: 'user', content: 'pick one' }] });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('x-acp-agent') ?? '', /gemini-[ab]/);
  });
});

test('agent exit mid-stream surfaces a clean error to the client', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'primary_failover', maxRetries: 1, failureCooldownSeconds: 0 },
    agents: [agent('gemini', 'a', { ACP_FAKE_FAIL_PROMPT: 'exit' })]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, { model: 'gemini', messages: [{ role: 'user', content: 'crash please' }] });
    assert.ok(r.status === 502 || r.status === 503, `expected 502/503 for agent exit; got ${r.status}`);
    const body = await r.json();
    assert.ok(body.error, 'response should be an OpenAI-shaped error');
  });
});

test('extractClientToolCalls is strict by default and loose under compat flag', async () => {
  const { extractClientToolCalls } = await import('../src/openaiCompat.js');
  const body = {
    tools: [{ type: 'function', function: { name: 'foo', parameters: { type: 'object', properties: {} } } }],
    tool_choice: 'auto'
  };
  const envelope = '{"tool_calls":[{"name":"foo","arguments":{}}]}';
  assert.equal(extractClientToolCalls(envelope, body).length, 1, 'pure JSON envelope still extracts');
  const prose = `Sure thing, let me call this for you: ${envelope}`;
  assert.equal(extractClientToolCalls(prose, body).length, 0, 'prose with embedded JSON must NOT extract by default');
  assert.equal(extractClientToolCalls(prose, { ...body, compat: { loose_tool_json: true } }).length, 1, 'loose mode restores embedded extraction');
});

test('responses carry an x-request-id header', async () => {
  await withApp({
    server: { ...baseServer },
    agents: [agent('gemini', 'a')]
  }, async ({ baseUrl }) => {
    const r = await fetch(`${baseUrl}/health`);
    assert.match(r.headers.get('x-request-id') ?? '', /^req_[0-9a-f]+$/);
  });
});

test('/readyz returns 200 when no startAtBoot agents are configured', async () => {
  await withApp({
    server: { ...baseServer },
    agents: [agent('gemini', 'a')]
  }, async ({ baseUrl }) => {
    const r = await fetch(`${baseUrl}/readyz`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
  });
});

test('logger redacts bearer/sk-/github tokens and truncates long stacks', async () => {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const out = [];
  process.stdout.write = (c, ...a) => { out.push(String(c)); if (typeof a.at(-1) === 'function') a.at(-1)(); return true; };
  process.stderr.write = (c, ...a) => { out.push(String(c)); if (typeof a.at(-1) === 'function') a.at(-1)(); return true; };
  try {
    const logger = createLogger({ level: 'debug', service: 'test' });
    logger.info('reveal Bearer sk-1234567890ABCDEFG and ghp_abcdefghij0123456789', {});
    const err = new Error('failed with token ghp_xxxxxxxxxxxxxxxxxxxx');
    err.stack = err.stack + '\n' + 'a'.repeat(10000);
    logger.error('boom', err);
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  const all = out.join('');
  assert.doesNotMatch(all, /Bearer sk-1234567890/);
  assert.doesNotMatch(all, /ghp_abcdefghij0123456789/);
  assert.match(all, /<redacted>/);
  assert.match(all, /truncated/);
});

test('max_queue_depth rejects excess concurrent requests with 503 + Retry-After', async () => {
  await withApp({
    server: { ...baseServer },
    agents: [{ ...agent('gemini', 'a', { ACP_FAKE_PROMPT_DELAY_MS: '300' }), max_queue_depth: 2 }]
  }, async ({ baseUrl }) => {
    const responses = await Promise.all([1, 2, 3, 4].map(() =>
      post(baseUrl, { model: 'gemini', messages: [{ role: 'user', content: 'queue test' }] })
    ));
    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 503], `expected three 200s and one 503; got ${statuses}`);
    const rejected = responses.find((r) => r.status === 503);
    assert.equal(rejected.headers.get('retry-after'), '1', 'queue-full response should include retry-after');
  });
});

test('resource_links policy can deny file:// URIs and private networks', async () => {
  await withApp({
    server: {
      ...baseServer,
      resource_links: { allowed_schemes: ['https'], allow_file_uri: false, deny_private_networks: true }
    },
    agents: [agent('gemini', 'a')]
  }, async ({ baseUrl }) => {
    const fileUri = await post(baseUrl, {
      model: 'gemini',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }] }]
    });
    assert.equal(fileUri.status, 400);
    assert.match((await fileUri.json()).error.message, /file:\/\/ URIs are not allowed/);

    const linkLocal = await post(baseUrl, {
      model: 'gemini',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://169.254.169.254/latest/meta-data/' } }] }]
    });
    assert.equal(linkLocal.status, 400);
    assert.match((await linkLocal.json()).error.message, /allowed_schemes|private/);

    const allowed = await post(baseUrl, {
      model: 'gemini',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }]
    });
    assert.equal(allowed.status, 200);
  });
});

test('resource_links default policy is permissive (no behaviour change for existing configs)', async () => {
  await withApp({
    server: { ...baseServer },
    agents: [agent('gemini', 'a')]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, {
      model: 'gemini',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///workspace/file.txt' } }] }]
    });
    assert.equal(r.status, 200);
  });
});

test('chat streaming first chunk delta carries role assistant', async () => {
  await withApp({
    server: { ...baseServer },
    agents: [agent('gemini', 'a')]
  }, async ({ baseUrl }) => {
    const r = await post(baseUrl, { model: 'gemini', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    const text = await r.text();
    const lines = text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)));
    assert.ok(lines.length > 0);
    assert.equal(lines[0].choices?.[0]?.delta?.role, 'assistant', 'first chunk must emit assistant role');
  });
});

test('/v1/responses streaming emits response.output_text.done before completed', async () => {
  await withApp({
    server: { ...baseServer },
    agents: [agent('gemini', 'a')]
  }, async ({ baseUrl }) => {
    const r = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ model: 'gemini', stream: true, input: 'hi' })
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    const events = text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)));
    const types = events.map((e) => e.type);
    const doneIdx = types.indexOf('response.output_text.done');
    const completedIdx = types.indexOf('response.completed');
    assert.ok(doneIdx >= 0, 'expected response.output_text.done event');
    assert.ok(completedIdx > doneIdx, 'response.completed must follow response.output_text.done');
  });
});

test('responses status maps incomplete stopReason to status:incomplete', async () => {
  await withApp({
    server: { ...baseServer },
    agents: [agent('gemini', 'a', { ACP_FAKE_STOP_REASON: 'max_tokens' })]
  }, async ({ baseUrl }) => {
    const r = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ model: 'gemini', input: 'hi' })
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, 'incomplete');
    assert.deepEqual(body.incomplete_details, { reason: 'max_output_tokens' });
    assert.equal(body.output[0].status, 'incomplete');
  });
});

test('client abort during streaming propagates session/cancel to the agent', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-cancel-'));
  const cancelLog = path.join(dir, 'cancels.log');
  writeFileSync(cancelLog, '');
  const app = new AcpOpenAiServer(config({
    server: { ...baseServer },
    agents: [agent('gemini', 'a', { ACP_FAKE_SLOW_STREAM_MS: '60', ACP_FAKE_CANCEL_LOG: cancelLog })]
  }), { logger: createLogger({ level: 'silent' }) });
  await app.startAtBoot();
  const address = await app.listen();
  const baseUrl = `http://${address.address}:${address.port}`;
  try {
    const ctrl = new AbortController();
    const r = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ model: 'gemini', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ctrl.signal
    });
    const reader = r.body.getReader();
    const { value } = await reader.read();
    assert.ok(value && value.length > 0, 'expected at least one SSE chunk before abort');
    ctrl.abort();
    try { await reader.cancel(); } catch {}
    // Allow cancel notification to propagate through ACP.
    await new Promise((r) => setTimeout(r, 500));
    const observed = readFileSync(cancelLog, 'utf8').trim();
    assert.ok(observed.length > 0, `fake agent should have observed session/cancel; log was empty`);
  } finally {
    await app.close();
  }
});

test('/v1/responses non-streaming with multimodal data URI image', async () => {
  await withApp({
    server: { ...baseServer, routingStrategy: 'primary_failover' },
    agents: [agent('gemini', 'a')]
  }, async ({ baseUrl }) => {
    const r = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({
        model: 'gemini',
        input: [{ role: 'user', content: [
          { type: 'input_text', text: 'describe' },
          { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }
        ] }]
      })
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.object, 'response');
    assert.match(body.output_text, /\[image:image\/png\]/);
  });
});
