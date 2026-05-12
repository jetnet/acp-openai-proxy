#!/usr/bin/env node
import { writeFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { loadConfig, defaultConfigText } from "./config.js";
import { createLogger } from "./logger.js";
import { createProxyServer } from "./server.js";

function usage(code = 0) {
    const text = `Usage:\n  acp-openai-proxy --config <path> [--host <host>] [--port <port>]\n  acp-openai-proxy --config <path> --check-config\n  acp-openai-proxy --config <path> --preflight\n  acp-openai-proxy --write-default-config <path>\n`;
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
if (args.includes("--check-config")) {
    const redacted = redactedConfig(config);
    console.log(JSON.stringify(redacted, null, 2));
    process.exit(0);
}
if (args.includes("--preflight")) {
    const issues = preflightConfig(config);
    if (issues.length) {
        console.error("preflight failed:");
        for (const i of issues) console.error("  - " + i);
        process.exit(2);
    }
    console.log("preflight OK (" + config.agents.length + " agents, " + [...new Set(config.agents.flatMap(a => a.models))].length + " models)");
    process.exit(0);
}
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
let shuttingDown = false;
const shutdown = async (signal) => {
    if (shuttingDown) {
        logger.warn("shutdown already in progress; forcing exit", { signal });
        process.exit(1);
    }
    shuttingDown = true;
    logger.info("shutdown requested", { signal });
    const deadlineMs = config.server.shutdownTimeoutSeconds * 1000;
    const timer = setTimeout(() => {
        logger.error("shutdown timed out; forcing exit", { deadlineMs });
        process.exit(1);
    }, deadlineMs);
    timer.unref();
    try {
        await server.closeProxy();
    } finally {
        clearTimeout(timer);
    }
    logger.info("shutdown complete");
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function redactedConfig(cfg) {
    const copy = JSON.parse(JSON.stringify(cfg));
    if (copy.server?.apiKey) copy.server.apiKey = "<redacted>";
    for (const agent of copy.agents ?? []) {
        for (const key of Object.keys(agent.env ?? {})) {
            if (/key|token|secret|password|api/i.test(key)) agent.env[key] = "<redacted>";
        }
    }
    return copy;
}

function preflightConfig(cfg) {
    const issues = [];
    for (const agent of cfg.agents) {
        try {
            const pathOk = agent.command.includes("/")
                ? statSync(agent.command).isFile()
                : Boolean(execSync(`command -v ${JSON.stringify(agent.command)}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim());
            if (!pathOk) issues.push(`agent ${agent.instanceId}: command ${agent.command} not found on PATH`);
        } catch {
            issues.push(`agent ${agent.instanceId}: command ${agent.command} not found on PATH`);
        }
        try {
            if (!statSync(agent.cwd).isDirectory()) issues.push(`agent ${agent.instanceId}: cwd ${agent.cwd} is not a directory`);
        } catch {
            issues.push(`agent ${agent.instanceId}: cwd ${agent.cwd} does not exist`);
        }
        for (const [k, v] of Object.entries(agent.env ?? {})) {
            if (v === "" && /key|token|secret|password/i.test(k)) issues.push(`agent ${agent.instanceId}: env ${k} expanded to empty string`);
        }
    }
    return issues;
}
