FROM node:22-slim
WORKDIR /app

ARG ACP_GLOBAL_PACKAGES="@google/gemini-cli@latest @agentclientprotocol/claude-agent-acp@latest @github/copilot@latest"
ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN set -eux; \
    npm install -g --no-fund --no-update-notifier ${ACP_GLOBAL_PACKAGES}; \
    npm cache clean --force; \
    mkdir -p /auth/gemini-a /auth/gemini-b /auth/claude-ka /auth/github-gpt-5-mini-ka; \
    chown -R node:node /auth

COPY --chown=node:node src ./src
COPY --chown=node:node config.docker.json /app/config.json

EXPOSE 11435
ENTRYPOINT ["node", "src/index.js"]
CMD ["--config", "/app/config.json"]
USER node
