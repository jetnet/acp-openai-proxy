#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { loadConfig, defaultConfigText } from "./config.js";
import { createLogger } from "./logger.js";
import { createProxyServer } from "./server.js";

function usage(code = 0) {
    const text = `Usage:\n  acp-openai-proxy --config <path> [--host <host>] [--port <port>]\n  acp-openai-proxy --write-default-config <path>\n`;
    (code === 0 ? console.log : console.error)(text);
    process.exit(code);
}
function value(args, name) {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (index + 1 >= args.length) usage(2);
    return args[index + 1];
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) usage(0);
const writePath = value(args, "--write-default-config");
if (writePath) {
    writeFileSync(writePath, defaultConfigText(), "utf8");
    process.exit(0);
}
const configPath =
    value(args, "--config") || process.env.ACP_OPENAI_PROXY_CONFIG;
if (!configPath) usage(2);
const config = loadConfig(configPath);
const logger = createLogger({
    ...config.logging,
    level: process.env.ACP_OPENAI_PROXY_LOG_LEVEL || config.logging.level,
    format: process.env.ACP_OPENAI_PROXY_LOG_FORMAT || config.logging.format,
});
process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", { error });
    process.exit(1);
});
process.on("unhandledRejection", (error) => {
    logger.error("unhandled rejection", {
        error: error instanceof Error ? error : new Error(String(error)),
    });
    process.exit(1);
});
const host = value(args, "--host");
const port = value(args, "--port");
if (host) config.server.host = host;
if (port) config.server.port = Number(port);
const server = createProxyServer(config, { logger });
await server.startBootAgents();
await new Promise((resolve) =>
    server.listen(config.server.port, config.server.host, resolve),
);
logger.info("server listening", {
    host: config.server.host,
    port: server.address().port,
});
const shutdown = async (signal) => {
    logger.info("shutdown requested", { signal });
    await server.closeProxy();
    logger.info("shutdown complete");
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
