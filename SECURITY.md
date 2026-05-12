# Security policy

## Reporting a vulnerability

If you believe you've found a security issue in `acp-openai-proxy`, please open
a private security advisory on the GitHub repository's "Security" tab rather
than a public issue. If that channel isn't available, email the maintainer
listed in `package.json` / the repo README.

Please include:

- a clear description of the issue and how to reproduce it;
- affected versions (tag or commit);
- the impact you observed (e.g., what data or capability becomes accessible);
- any proposed mitigation or patch, if you have one.

We aim to acknowledge reports within 7 calendar days and to ship a fix or a
documented workaround in the next release after triage.

## Scope

In scope:

- The HTTP proxy in `src/` and its configuration surface.
- The Docker image and `docker-compose.yml`.
- Documentation that materially overstates security guarantees.

Out of scope:

- Vulnerabilities in third-party ACP agent CLIs (Gemini, Claude, Copilot,
  Codex, Kilo, Qwen, OpenCode, etc.). Report those to their upstream projects.
- Vulnerabilities in Node.js, npm, or the base Docker image.
- Misuse of `permission: allow` or `env_passthrough: ["*"]`, which are
  explicit opt-ins to looser behaviour.

## Threat model

The proxy is designed for the following deployment shapes:

| Shape | Trust assumptions |
| --- | --- |
| Local-only (default, `127.0.0.1`) | Trusted developer machine. ACP agents may or may not be trusted; the proxy enforces `permission: deny` by default. |
| Container behind a reverse proxy | TLS terminates upstream; auth handled by upstream and/or this proxy's bearer token. ACP agents are still treated as untrusted: `env_passthrough` is restricted by default. |
| Non-loopback bind without API key | Rejected at boot (see `server.allow_unauthenticated`). |

What this proxy does **not** defend against:

- Compromised ACP agent CLIs. The `permission: read_only` heuristic is
  best-effort; treat untrusted agents with `permission: deny` and run them in
  a container with a read-only root filesystem.
- SSRF inside an ACP agent. The proxy can optionally constrain
  `resource_link` URLs (see `server.resource_links`), but if the agent fetches
  resources itself, the agent's network egress matters more than this policy.
- Provider-side abuse (e.g., a prompt that exhausts your Gemini/Anthropic
  quota). Rate limiting outside the proxy (nginx, Cloudflare) is recommended
  for non-loopback deployments.

## Hardening checklist for non-loopback deployments

- [ ] `server.api_key` is set to a strong random value (e.g., 32+ chars).
- [ ] `server.host` is bound only to interfaces you trust, or fronted by a
      reverse proxy that handles TLS.
- [ ] `server.env_passthrough` is left at the default minimal allowlist (do
      not use `["*"]`).
- [ ] `server.resource_links.allowed_schemes` is restricted to `["https"]`
      and `deny_private_networks: true`, `allow_file_uri: false`.
- [ ] `agents[].permission` is `deny` for every untrusted agent.
- [ ] Container has read-only root filesystem, `cap_drop: ALL`, and
      `no-new-privileges` set (the bundled `docker-compose.yml` does this).
- [ ] Auth provider keys are injected via `{var:NAME:?required}` so missing
      values fail at boot rather than silently producing broken agents.
