import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpOpenAiServer } from '../src/server.js';
import { normalizeConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

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
