FROM node:22-slim
WORKDIR /app

# Override either ACP_GLOBAL_PACKAGES (to pin agent CLI versions) or
# ACP_PROXY_VERSION (to stamp the version reported in ACP initialize) at
# build time with --build-arg.
ARG ACP_GLOBAL_PACKAGES="@google/gemini-cli@latest @agentclientprotocol/claude-agent-acp@latest @github/copilot@latest"
ARG ACP_PROXY_VERSION=unknown
ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    ACP_PROXY_VERSION=${ACP_PROXY_VERSION}

RUN set -eux; \
    npm install -g --no-fund --no-update-notifier ${ACP_GLOBAL_PACKAGES}; \
    npm cache clean --force; \
    mkdir -p /auth/gemini-a /auth/gemini-b /auth/claude-ka /auth/github-gpt-5-mini-ka; \
    chown -R node:node /auth

COPY --chown=node:node src ./src
COPY --chown=node:node config.docker.json /app/config.json

EXPOSE 11435
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('node:http').get('http://127.0.0.1:11435/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["node", "src/index.js"]
CMD ["--config", "/app/config.json"]
USER node
