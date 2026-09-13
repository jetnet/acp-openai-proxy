# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-09-13

Gemini CLI is retired. This release removes it from the code, the shipped
configs, the Docker image and the docs, and makes OpenCode the reference
agent.

### Removed

- **BREAKING** `agents[].model_selection.type` no longer accepts `"gemini"`.
  Allowed values are `session_config` and `auto`; anything else is rejected
  when the config is loaded.
- **BREAKING** The Gemini model-selection path is gone: no more
  `session/set_model` request, no more `models.availableModels` /
  `currentModelId` handling from `session/new`. Model selection goes through
  `configOptions` + `session/set_config_option` only.
- **BREAKING** The built-in default config and `config.docker.json` no longer
  define `gemini-a` / `gemini-b`, and `GEMINI_API_KEY_A` / `GEMINI_API_KEY_B`
  are no longer read. `docker-compose.yml` no longer requires them.
- `@google/gemini-cli` is no longer installed in the Docker image.

### Added

- `CHANGELOG.md`.
- OpenCode agents in the default config, `config.docker.json` and all three
  example configs, using `model_selection.type: session_config`.
- `opencode-ai@latest` in the Docker image's default `ACP_GLOBAL_PACKAGES`,
  plus `/auth/opencode-a` and `/auth/opencode-b` auth directories.

### Changed

- `X-ACP-Upstream-Model` falls back to the `currentValue` of the agent's model
  config option instead of the removed `models.currentModelId`.
- `scripts/live-smoke.mjs` prefers the OpenCode model ids when picking a smoke
  model.
- README and `docs/ARCHITECTURE.md` describe only the `configOptions` model
  selection path, with OpenCode as the worked example.

### Migration

1. Replace `"type": "gemini"` with `"type": "session_config"` in every
   `model_selection` block, and make sure `values` maps your OpenAI-facing
   model ids to values the agent actually lists in its `model` config option.
2. Replace Gemini agent blocks with agents you still run. For OpenCode, run
   `opencode auth login` once per instance state directory and point
   `XDG_DATA_HOME` / `XDG_CONFIG_HOME` at it.
3. Drop `GEMINI_API_KEY_A` / `GEMINI_API_KEY_B` from your environment and
   compose files.

## [0.6.2] - 2026-05-12

- Access logs carry `request_model` and `response_model`.

## [0.6.1] - 2026-05-12

- Support for the Gemini CLI `model_selection` extension (removed again in
  0.7.0).

## [0.6.0] - 2026-05-12

- Polish pass: `authMethods` handling, Docker hardening, stricter tool-call
  handling, operational fixes.

## [0.5.0] - 2026-05-11

- Spec compliance, operations, capacity and observability work.

## [0.4.0] - 2026-05-11

- Hardening pass: process lifecycle, environment isolation, SSE handling,
  permissions.

## [0.3.0] - 2026-05-10

- Hardening pass: Docker, config validation, authentication, TOML support
  removed in favour of JSON-only configuration.
