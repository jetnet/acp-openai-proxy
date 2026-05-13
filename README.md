# acp-openai-proxy

Dependency-light Node.js OpenAI-compatible HTTP proxy for Agent Client Protocol (ACP) agents.

The service launches configured ACP-compatible CLIs as stdio subprocesses, speaks newline-delimited JSON-RPC to them, and exposes OpenAI-compatible endpoints:

- `GET /health` and `GET /healthz`
- `GET /v1/models`
- `GET /v1/models/{model}`
- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`

All generation is produced by configured ACP agents. The proxy does not call model providers directly.

## Why Node.js

ACP agents and tooling are commonly shipped as Node/TypeScript CLIs. This implementation keeps the proxy in the same operational ecosystem while avoiding unnecessary framework dependencies. It uses Node's built-in HTTP server and `child_process.spawn`.

## Install and test

```bash
npm test
```

No runtime npm dependencies are required. Node.js 20+ is expected.

## Write default config

```bash
node src/index.js --write-default-config config.json
```

## Run

```bash
node src/index.js --config config.json
```

The app writes logs to stdout/stderr. `debug` and `info` events go to stdout; `warn` and `error` events go to stderr. Set `ACP_OPENAI_PROXY_LOG_LEVEL=debug`, `info`, `warn`, `error`, or `silent` to adjust verbosity. Logs are newline-delimited JSON by default; set `ACP_OPENAI_PROXY_LOG_FORMAT=text` for plain text logs.

You can also configure logging in `config.json`:

```json
{
  "server": {
    "logging": {
      "level": "info",
      "format": "json"
    }
  }
}
```

Environment variables override the config values when set.

Configuration is JSON only. See `examples/config.json` for a complete example.

Example request:

```bash
curl http://127.0.0.1:11435/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local-proxy-token' \
  -d '{
    "model": "gemini",
    "stream": true,
    "messages": [{"role": "user", "content": "Say hello."}]
  }'
```

## Agent environment variables

Environment variables live directly inside each agent block. There is no `env_sections` indirection.

```json
{
  "agents": [
    {
      "name": "gemini",
      "instance_id": "gemini-a",
      "command": "npx",
      "args": ["-y", "@google/gemini-cli@latest", "--model", "auto", "--experimental-acp"],
      "models": ["gemini"],
      "env": {"GEMINI_API_KEY": "{var:GEMINI_API_KEY_A}"},
      "permission": "deny"
    }
  ]
}
```

Supported expansion forms in `agents[].env` and `server.api_key`:

- `{var:NAME}` and `{env:NAME}`
- `{var:NAME:-fallback}` and `{env:NAME:-fallback}`
- `${NAME}`, `${NAME:-fallback}`, and `$NAME`
- `{file:/absolute/path/to/secret}`

`{file:...}` reads a UTF-8 file during config loading and strips one trailing `\n` or `\r\n`. The file path is trimmed, may start with `~/`, and may contain Windows-style `%VAR%` environment references. The resolved path must be absolute; relative `{file:secret}` tokens are left unchanged. Missing or unreadable files fail startup with a contextual `Cannot read secret file ...` error.

`{file:...}` expansion runs before environment expansion. This means env references cannot dynamically construct file paths in the same value. File contents are inserted literally and are not expanded again. Keep secret files outside the repo and permission them for the proxy user only, for example `0600`.

The old `env_sections`, `env_section`, and `envSections` fields are intentionally rejected so stale configs fail loudly.

## Multiple ACP agents behind one model id

Configure multiple agents with the same `models` entry. This starts multiple ACP subprocesses and exposes one OpenAI-compatible model id.

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 11435,
    "api_key": "local-proxy-token",
    "routing_strategy": "sticky_failover",
    "max_retries": 1,
    "failure_cooldown_seconds": 60
  },
  "agents": [
    {
      "name": "gemini",
      "instance_id": "gemini-a",
      "command": "npx",
      "args": ["-y", "@google/gemini-cli@latest", "--model", "auto", "--experimental-acp"],
      "models": ["gemini"],
      "env": {"GEMINI_API_KEY": "{var:GEMINI_API_KEY_A}"},
      "permission": "deny"
    },
    {
      "name": "gemini",
      "instance_id": "gemini-b",
      "command": "npx",
      "args": ["-y", "@google/gemini-cli@latest", "--model", "auto", "--experimental-acp"],
      "models": ["gemini"],
      "env": {"GEMINI_API_KEY": "{var:GEMINI_API_KEY_B}"},
      "permission": "deny"
    }
  ]
}
```

`GET /v1/models` returns one model id with backing runtime metadata:

```json
{
  "id": "gemini",
  "owned_by": "acp-agent-pool",
  "acp_agents": ["gemini-a", "gemini-b"],
  "x_acp_pool_size": 2,
  "x_acp_routing_strategy": "sticky_failover"
}
```

Generation responses include:

```text
X-ACP-Agent: gemini-a
X-ACP-Model: gemini
X-ACP-Upstream-Model: gemini-2.5-flash-lite     # only when model_selection fired
X-Request-ID: req_a1b2c3d4e5f6
```

## What `models` means

`agents[].models` means “OpenAI-compatible model ids exposed by this proxy and routed to this ACP runtime.” It does **not** automatically change the provider model inside the ACP agent.

So this config:

```json
{
  "args": ["-y", "@google/gemini-cli@latest", "--model", "auto", "--experimental-acp"],
  "models": ["gemini-flash", "gemini-pro"]
}
```

exposes two OpenAI model ids, but both ids still talk to the same started Gemini CLI process configured with `--model auto`, unless the agent also supports ACP session model configuration and `model_selection` is configured.

For simple, reliable Gemini CLI usage, define one agent block per actual Gemini model:

```json
{
  "agents": [
    {
      "name": "gemini-flash",
      "instance_id": "gemini-flash-a",
      "command": "npx",
      "args": ["-y", "@google/gemini-cli@latest", "--model", "flash", "--experimental-acp"],
      "models": ["gemini-flash"],
      "env": {"GEMINI_API_KEY": "{var:GEMINI_API_KEY_A}"},
      "permission": "deny"
    },
    {
      "name": "gemini-pro",
      "instance_id": "gemini-pro-a",
      "command": "npx",
      "args": ["-y", "@google/gemini-cli@latest", "--model", "pro", "--experimental-acp"],
      "models": ["gemini-pro"],
      "env": {"GEMINI_API_KEY": "{var:GEMINI_API_KEY_A}"},
      "permission": "deny"
    }
  ]
}
```

To pool multiple accounts for the same exact model, duplicate that model-specific block with different `instance_id` and `env`.

## Optional ACP session model selection

Some ACP agents expose session configuration options, including a model selector. For those agents, the proxy can dynamically set the ACP model config option per request, before `session/prompt`.

### How it works

1. When the proxy creates a new ACP session (`session/new`), the agent may return one of two shapes:
   - **Standard ACP** — a `configOptions` array of configuration knobs.
   - **Gemini CLI extension** — a `models` object with `availableModels: [{ modelId, name }]` and `currentModelId`.
2. If `model_selection` is configured on the agent, the proxy looks for a config option matching `config_id` (or falls back to one with `category: "model"` or `id: "model"`). When the agent only exposes the Gemini extension, the proxy uses that automatically.
3. The proxy maps the OpenAI model string from the request (e.g. `"gemini-pro"`) to either an ACP config value (standard) or a Gemini `modelId` (extension) using the `values` map.
4. The proxy calls `session/set_config_option` (standard) or `session/set_model` (Gemini extension) with the resolved value before sending the prompt.

### Example

```json
{
  "agents": [
    {
      "name": "agent-with-model-selector",
      "instance_id": "agent-a",
      "command": "some-acp-agent",
      "args": ["acp"],
      "models": ["gemini-flash", "gemini-pro"],
      "model_selection": {
        "type": "session_config",
        "config_id": "model",
        "values": {
          "gemini-flash": "flash",
          "gemini-pro": "pro"
        }
      },
      "env": {"API_KEY": "{var:API_KEY_A}"},
      "permission": "deny"
    }
  ]
}
```

### `model_selection` fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | string | `"session_config"` | Must be `"session_config"`. Only supported type. |
| `config_id` | string | auto-detect | ACP config option id to set. When omitted, the proxy auto-detects by looking for a config option with `category: "model"` or `id: "model"` in the agent's `session/new` response. |
| `values` | object | `{}` | Maps OpenAI model ids to upstream values. Keys are the strings clients send as `model`; values are what gets passed to `session/set_config_option` (standard ACP) or `session/set_model` as `modelId` (Gemini extension). When a model id is not in this map, the proxy tries to match it against the agent's own option/availableModels list by value, name, or `modelId`. |
| `required` | boolean | `true` | Controls error behaviour when model selection fails. See ["What `required` does"](#what-required-does) below. |

You can also set `model_selection: true` as shorthand for `{ "type": "auto", "required": true }` with auto-detection and no explicit value mappings.

### How to know if an ACP agent supports model selection

There is no way to know in advance from configuration alone. The proxy discovers support **at runtime** when the agent responds to `session/new`. The agent supports model selection if its response contains either a `configOptions` entry with a model category (standard ACP) or a `models.availableModels` array (Gemini CLI extension). If it returns neither, it does not.

To check: start the proxy with `ACP_OPENAI_PROXY_LOG_LEVEL=debug` and inspect the `session/new` response logged for each agent.

### Gemini CLI example

The Google Gemini CLI uses the `models` extension shape rather than `configOptions`. Configure it like:

```json
{
  "name": "gemini",
  "command": "npx",
  "args": ["-y", "@google/gemini-cli@latest", "--acp"],
  "models": ["flash-lite", "flash", "pro"],
  "model_selection": {
    "required": true,
    "values": {
      "flash-lite": "gemini-2.5-flash-lite",
      "flash":      "gemini-2.5-flash",
      "pro":        "gemini-2.5-pro"
    }
  }
}
```

The proxy will issue `session/set_model` with the mapped `modelId` before each prompt. Run the [model probe](scripts/) trick (`session/new` with no follow-up) to discover the actual `modelId` strings the CLI advertises.

### What `required` does

`required` decides what happens when the proxy cannot complete model selection for a request — either silently fall back to whatever model the CLI was launched with, or fail the request loudly.

There are four points where selection can fail:

| Failure | `required: true` | `required: false` |
| --- | --- | --- |
| Agent exposes neither `configOptions` nor `models.availableModels` | 502 `acp_error` to client | skip; send prompt as-is |
| Your `values` map has no entry for the requested model id (and no automatic match from the agent's own option list) | 502 | skip |
| The mapped value is not in the agent's allowed value list | 502 | skip |
| Standard path: no `configId` resolvable | 502 | skip |

In every "skip" case the proxy does **not** call `session/set_config_option` / `session/set_model`. The agent receives the prompt and answers using its CLI-launch default model (e.g. `--model auto` for the Gemini CLI).

Practical recommendation:

- **`required: true`** — when a model id maps to a *specific* upstream model and a broken mapping should fail loudly. Good for cost-control or compliance pinning.
- **`required: false`** — when the `values` map is best-effort and an unmapped id should silently use the agent's default rather than 502. The trade-off is that `x-acp-model` in the response reflects only the OpenAI-style id the client sent, not the upstream model that actually answered.

Concrete example with the Gemini agent and `required: false`:

| Client requests `model: …` | What happens |
| --- | --- |
| `"gemini-flash-lite"` *(mapped)* | `session/set_model { modelId: "gemini-3.1-flash-lite-preview" }` → flash-lite answers |
| `"some-unknown-model"` | no `set_model` call → agent answers using its launch default (`--model auto`) |

With `required: true`, the second row would fail with `502 acp_error: agent ... cannot map requested model "some-unknown-model" to a Gemini availableModels entry`.

### When to use `model_selection` vs. separate agent blocks

| Approach | When to use |
| --- | --- |
| One agent block per model | Simple, reliable. Each subprocess runs a fixed model. No dependency on ACP config option support. Recommended for most setups. |
| `model_selection` | Single subprocess serves multiple models. Fewer processes, but requires the ACP agent to support `session/set_config_option`. Use when you have confirmed the agent supports it and want to reduce resource usage. |

## Routing choices

`sticky_failover` is the recommended default for repeated long-prefix/cache-sensitive traffic. It routes the same explicit key or prompt prefix to the same runtime, then tries another runtime only when the selected one fails before producing output.

`primary_failover` always tries configured agents in order. Use it when one account/process should stay hot and backups should only handle failures.

`round_robin` spreads first attempts across runtimes. Use it when quota/load spreading matters more than cache locality.

`least_busy` is a small local-pool helper that prefers idle runtimes; it is not a queue broker.

Retry budget:

```json
{
  "routing_strategy": "sticky_failover",
  "max_retries": 2,
  "max_attempts_per_request": 0,
  "failure_cooldown_seconds": 60,
  "retry_backoff_seconds": 0,
  "retry_on_any_acp_error": false,
  "affinity_prefix_chars": 4096
}
```

With two runtimes and `max_retries = 2`, retryable failures can attempt `a, b, a, b`. If all attempts fail, the proxy returns an OpenAI-style `acp_error` with per-runtime summaries.

**Health tracking and cooldown:** when a runtime fails (rate limit, quota exhausted, etc.) it is marked in cooldown for `failure_cooldown_seconds`. On every subsequent request the proxy reorders the pool so healthy runtimes are tried first — the failing agent is skipped until its cooldown expires, without any change needed in client code. A successful response immediately clears the cooldown. The state is in-memory and resets on proxy restart.

## Multimodal input and attachments

Forwarded input mappings:

| Input | ACP block |
| --- | --- |
| Text | `text` |
| `data:image/...;base64,...` | `image` if the agent advertises image prompt support |
| Image URL / file URI | `resource_link` |
| Base64 audio / `data:audio/...;base64,...` | `audio` if the agent advertises audio prompt support |
| Audio URL / file URI | `resource_link` |
| File URL / URI | `resource_link` |
| Inline file text/base64/data URI | `resource` if the agent advertises embedded-context support |

`file_id` is rejected because a local ACP agent cannot dereference OpenAI-hosted files. Remote URLs are forwarded, not downloaded.

## Tools and permissions

Chat Completions accepts OpenAI client-owned function tools through `tools`/`tool_choice` and deprecated `functions`/`function_call`. The proxy adds the tool contract to the ACP prompt and, when the ACP agent responds with a tool-call JSON envelope, returns OpenAI-compatible `message.tool_calls` with `finish_reason: "tool_calls"`.

The proxy does not execute those tools. Your OpenAI-compatible client must execute the returned function call and send the result back as a `role: "tool"` message. ACP/MCP tools remain agent-owned and separate from this client-side mechanism.

Streaming Chat Completions with client tools are buffered until the ACP turn completes, so the proxy can decide whether to emit text or a `tool_calls` delta.

Permission modes:

```json
{"permission": "deny"}
{"permission": "read_only"}
{"permission": "allow"}
```

`deny` is the default. `allow` should only be used in trusted disposable sandboxes.

The `read_only` mode uses keyword-substring heuristics on permission-request params to decide what to approve. It is best-effort, not a guarantee — use `deny` for hostile or untrusted CLIs.

## Docker

Build:

```bash
docker build -t acp-openai-proxy .
```

Run with Compose:

```bash
docker compose up --build
```

The image installs the ACP CLIs it needs at build time, so the container does not fetch `npx` packages on startup. The compose file mounts a persistent `auth` volume at `/auth`. Each agent uses a subdirectory under that volume for `HOME`, and Gemini also uses `GEMINI_CLI_HOME`, so CLI state survives container restarts.

The compose service runs as a non-root user with a read-only root filesystem, no added Linux capabilities, `no-new-privileges`, and a private `/tmp` scratch mount. It also binds the published port to `127.0.0.1` only.

`config.docker.json` binds the proxy to `0.0.0.0` inside the container. It is copied into the image as `/app/config.json`.

`AUTH_ROOT` is the only directory root the docker config needs. Agent-specific home values are derived from it so they stay persistent without hardcoding a host path.

### Agent startup commands

The proxy only launches the commands listed in `agents[].command` and `agents[].args`. In the docker image, those commands are the installed binaries.

Current config:

| Agent | Command | Persistent home |
| --- | --- | --- |
| Gemini CLI | `gemini --model auto --experimental-acp` | `GEMINI_CLI_HOME=${AUTH_ROOT}/gemini-a` |
| Gemini CLI | `gemini --model auto --experimental-acp` | `GEMINI_CLI_HOME=${AUTH_ROOT}/gemini-b` |
| Claude ACP | `claude-agent-acp` | `HOME=${AUTH_ROOT}/claude-ka` |
| GitHub Copilot | `copilot --acp --stdio --model gpt-5-mini --effort high` | `HOME=${AUTH_ROOT}/github-gpt-5-mini-ka` |

The image build installs these packages by default:

- `@google/gemini-cli@latest`
- `@agentclientprotocol/claude-agent-acp@latest`
- `@github/copilot@latest`

### Reference startup shapes (not installed by default Docker image)

| Agent | Command | Persistent home |
| --- | --- | --- |
| Qwen Code | `npx @qwen-code/qwen-code@latest --model qwen3.6-plus --acp` | `HOME=${AUTH_ROOT}/qwen-code` |
| Auggie CLI | `npx @augmentcode/auggie@latest --model <model-id> --acp` | `HOME=${AUTH_ROOT}/auggie` |
| Qoder CLI | `npx @qoder-ai/qodercli@latest --model auto --acp` | `HOME=${AUTH_ROOT}/qoder` |
| Kilo Code | `npx --yes --package @kilocode/cli@latest kilo --model kilo/minimax/minimax-m2.7 acp` | `HOME=${AUTH_ROOT}/kilo-code` |
| Codex CLI | `npx @zed-industries/codex-acp@latest -c model="o3"` | `HOME=${AUTH_ROOT}/codex` |
| OpenCode | `npx -y opencode-ai@latest acp` | `XDG_DATA_HOME=${AUTH_ROOT}/opencode/.local/share` |
| OpenClaw | `openclaw acp` | `HOME=${AUTH_ROOT}/openclaw` |
| Kiro CLI | `kiro-cli settings chat.defaultModel claude-opus-4.7 && kiro-cli acp` | `HOME=${AUTH_ROOT}/kiro` |
| Hermes Agent | `hermes model && hermes acp` | `HOME=${AUTH_ROOT}/hermes` |

These are reference startup shapes for extending the config. The default Docker image does not install them unless you add the matching packages or binaries to the build.

If a CLI needs a provider key or first-run login, add that secret to the container environment as well. The auth volume only persists the state that the CLI writes to disk.

## Detailed spec

See `docs/ARCHITECTURE.md`.

## Verification

```bash
npm run check
npm test
```

Current expected test result: 44 passing tests.
