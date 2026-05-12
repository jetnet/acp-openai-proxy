import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let PKG_VERSION = process.env.ACP_PROXY_VERSION || "";
if (!PKG_VERSION) {
    try {
        PKG_VERSION = JSON.parse(
            readFileSync(
                join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
                "utf8",
            ),
        ).version;
    } catch {
        PKG_VERSION = "0.0.0";
    }
}

export class AcpError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "AcpError";
    }
}
export class JsonRpcError extends AcpError {
    constructor(error) {
        super(
            `ACP JSON-RPC error ${error?.code ?? "?"}: ${error?.message ?? "JSON-RPC error"}`,
        );
        this.name = "JsonRpcError";
        this.error = error ?? {};
    }
}
export class AcpProcessExited extends AcpError {
    constructor(message) {
        super(message);
        this.name = "AcpProcessExited";
    }
}

export class AsyncMutex {
    constructor() {
        this.locked = false;
        this.waiters = [];
    }
    get isLocked() {
        return this.locked;
    }
    acquire() {
        if (!this.locked) {
            this.locked = true;
            return Promise.resolve(() => this.release());
        }
        return new Promise((resolve) => this.waiters.push(resolve)).then(
            () => () => this.release(),
        );
    }
    release() {
        const next = this.waiters.shift();
        if (next) next();
        else this.locked = false;
    }
    async runExclusive(fn) {
        const release = await this.acquire();
        try {
            return await fn();
        } finally {
            release();
        }
    }
}

class AsyncQueue {
    constructor() {
        this.items = [];
        this.waiters = [];
        this.closed = false;
        this.closeReason = null;
    }
    get empty() {
        return this.items.length === 0;
    }
    push(item) {
        if (this.closed) return;
        const waiter = this.waiters.shift();
        if (waiter) {
            if (waiter.timer) clearTimeout(waiter.timer);
            waiter.resolve(item);
        } else this.items.push(item);
    }
    close(reason) {
        if (this.closed) return;
        this.closed = true;
        this.closeReason = reason;
        for (const waiter of this.waiters.splice(0)) {
            if (waiter.timer) clearTimeout(waiter.timer);
            waiter.resolve({ __closed: true, reason });
        }
    }
    next(timeoutMs = 0) {
        if (this.items.length) return Promise.resolve(this.items.shift());
        if (this.closed)
            return Promise.resolve({
                __closed: true,
                reason: this.closeReason,
            });
        return new Promise((resolve) => {
            const waiter = { resolve, timer: null };
            if (timeoutMs > 0)
                waiter.timer = setTimeout(() => {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) this.waiters.splice(index, 1);
                    resolve({ __timeout: true });
                }, timeoutMs);
            this.waiters.push(waiter);
        });
    }
}

export class AcpConnection {
    constructor(config, logger = console) {
        this.config = config;
        this.logger = logger;
        this.child = null;
        this.nextId = 1;
        this.pending = new Map();
        this.sessionQueues = new Map();
        this.writeMutex = new AsyncMutex();
        this.stdoutBuffer = "";
        this.stderrBuffer = "";
        this.capabilities = {};
        this.info = {};
    }
    get running() {
        return Boolean(
            this.child && this.child.exitCode === null && !this.child.killed,
        );
    }
    async start() {
        if (this.running) return;
        const env = buildAgentEnv(this.config);
        this.logger.info?.("starting ACP agent", {
            agent: this.config.instanceId,
            command: this.config.command,
            cwd: this.config.cwd,
        });
        this.child = spawn(this.config.command, this.config.args ?? [], {
            cwd: this.config.cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child.stdout.setEncoding("utf8");
        this.child.stderr.setEncoding("utf8");
        this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
        this.child.stderr.on("data", (chunk) => this.onStderr(chunk));
        this.child.on("error", (error) => {
            this.logger.error?.("ACP agent process error", {
                agent: this.config.instanceId,
                error,
            });
            this.failAll(
                new AcpProcessExited(
                    `ACP agent ${this.config.instanceId} process error: ${error.message}`,
                ),
            );
        });
        this.child.on("exit", (code, signal) => {
            const level = code === 0 ? "info" : "warn";
            this.logger[level]?.("ACP agent exited", {
                agent: this.config.instanceId,
                code,
                signal,
            });
            this.failAll(
                new AcpProcessExited(
                    `ACP agent ${this.config.instanceId} exited with code=${code ?? "null"} signal=${signal ?? "null"}`,
                ),
            );
        });
        try {
            await this.initialize();
        } catch (error) {
            this.failAll(error);
            const child = this.child;
            this.child = null;
            if (child && child.exitCode === null) {
                try { child.stdin.end(); } catch {}
                try { child.kill("SIGTERM"); } catch {}
                setTimeout(() => { try { if (child.exitCode === null) child.kill("SIGKILL"); } catch {} }, 200).unref();
            }
            throw error;
        }
    }
    async initialize() {
        const result = await this.request(
            "initialize",
            {
                protocolVersion: 1,
                clientCapabilities: {},
                clientInfo: { name: "acp-openai-proxy", version: PKG_VERSION },
            },
            this.config.startupTimeoutSeconds,
        );
        this.info = result?.agentInfo ?? {};
        this.capabilities = result?.agentCapabilities ?? {};
        this.logger.info?.("ACP agent initialized", {
            agent: this.config.instanceId,
            name: this.info?.name,
            version: this.info?.version,
        });
        return result;
    }
    async request(
        method,
        params = undefined,
        timeoutSeconds = this.config.requestTimeoutSeconds ?? 3600,
    ) {
        if (!this.running)
            throw new AcpProcessExited(
                `ACP agent ${this.config.instanceId} is not running`,
            );
        const id = this.nextId++;
        const payload = { jsonrpc: "2.0", id, method };
        if (params !== undefined) payload.params = params;
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => {
                    this.pending.delete(id);
                    reject(
                        new AcpError(
                            `ACP request timed out after ${timeoutSeconds}s: ${method}`,
                        ),
                    );
                },
                Math.max(1, timeoutSeconds * 1000),
            );
            this.pending.set(id, { resolve, reject, timer });
        });
        try {
            await this.write(payload);
        } catch (writeError) {
            const entry = this.pending.get(id);
            if (entry) {
                clearTimeout(entry.timer);
                this.pending.delete(id);
            }
            throw writeError;
        }
        return await promise;
    }
    async notify(method, params = undefined) {
        const payload = { jsonrpc: "2.0", method };
        if (params !== undefined) payload.params = params;
        await this.write(payload);
    }
    async write(payload) {
        if (!this.running || !this.child.stdin.writable)
            throw new AcpProcessExited(
                `ACP agent ${this.config.instanceId} is not running`,
            );
        await this.writeMutex.runExclusive(
            () =>
                new Promise((resolve, reject) =>
                    this.child.stdin.write(
                        `${JSON.stringify(payload)}\n`,
                        "utf8",
                        (error) => (error ? reject(error) : resolve()),
                    ),
                ),
        );
    }
    async newSessionInfo() {
        const result = await this.request(
            "session/new",
            { cwd: this.config.cwd, mcpServers: this.config.mcpServers ?? [] },
            this.config.requestTimeoutSeconds,
        );
        const sessionId = result?.sessionId ?? result?.session_id;
        if (!sessionId || typeof sessionId !== "string")
            throw new AcpError(
                "ACP session/new response did not include sessionId",
            );
        return {
            sessionId,
            configOptions:
                result?.configOptions ?? result?.config_options ?? [],
            modes: result?.modes ?? null,
        };
    }
    async newSession() {
        return (await this.newSessionInfo()).sessionId;
    }
    async setSessionConfigOption(sessionId, configId, value) {
        return await this.request(
            "session/set_config_option",
            { sessionId, configId, value },
            this.config.requestTimeoutSeconds,
        );
    }
    registerSession(sessionId) {
        const queue = new AsyncQueue();
        this.sessionQueues.set(sessionId, queue);
        return queue;
    }
    unregisterSession(sessionId) {
        this.sessionQueues.delete(sessionId);
    }
    async cancelSession(sessionId) {
        try {
            await this.notify("session/cancel", { sessionId });
        } catch {}
    }
    async closeSession(sessionId) {
        const sessionCapabilities =
            this.capabilities?.sessionCapabilities ??
            this.capabilities?.session_capabilities ??
            {};
        if (
            sessionCapabilities &&
            Object.prototype.hasOwnProperty.call(sessionCapabilities, "close")
        ) {
            try {
                await this.request("session/close", { sessionId }, 10);
            } catch {}
        }
    }
    async close() {
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new AcpProcessExited("ACP connection closed"));
            this.pending.delete(id);
        }
        for (const queue of this.sessionQueues.values())
            queue.close("ACP connection closed");
        this.sessionQueues.clear();
        const child = this.child;
        this.child = null;
        if (child && child.exitCode === null) {
            try {
                child.stdin.end();
            } catch {}
            await sleep(50);
            if (child.exitCode === null) {
                try {
                    child.kill("SIGTERM");
                } catch {}
                await sleep(150);
            }
            if (child.exitCode === null) {
                try {
                    child.kill("SIGKILL");
                } catch {}
            }
        }
    }
    onStdout(chunk) {
        this.stdoutBuffer += chunk;
        const MAX_STDOUT_LINE = 16 * 1024 * 1024;
        if (this.stdoutBuffer.length > MAX_STDOUT_LINE && this.stdoutBuffer.indexOf('\n') < 0) {
            this.logger.error?.('ACP agent stdout line too large', { agent: this.config.instanceId, size: this.stdoutBuffer.length });
            this.failAll(new AcpProcessExited(`ACP agent ${this.config.instanceId} stdout exceeded ${MAX_STDOUT_LINE}b without newline`));
            this.stdoutBuffer = '';
            return;
        }
        while (true) {
            const index = this.stdoutBuffer.indexOf("\n");
            if (index < 0) break;
            const line = this.stdoutBuffer.slice(0, index).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
            if (!line) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                this.logger.warn?.(
                    `ignoring non-JSON stdout from ACP agent ${this.config.instanceId}: ${line.slice(0, 200)}`,
                );
                continue;
            }
            this.dispatchMessage(message).catch((error) =>
                this.logger.error?.("ACP dispatch error", error),
            );
        }
    }
    onStderr(chunk) {
        this.stderrBuffer += chunk;
        const MAX_STDERR_BUF = 1024 * 1024;
        if (this.stderrBuffer.length > MAX_STDERR_BUF && this.stderrBuffer.indexOf('\n') < 0)
            this.stderrBuffer = this.stderrBuffer.slice(-MAX_STDERR_BUF);
        while (true) {
            const index = this.stderrBuffer.indexOf("\n");
            if (index < 0) break;
            const line = this.stderrBuffer.slice(0, index).trimEnd();
            this.stderrBuffer = this.stderrBuffer.slice(index + 1);
            if (line)
                this.logger.warn?.("ACP agent stderr", {
                    agent: this.config.instanceId,
                    line,
                });
        }
    }
    async dispatchMessage(message) {
        if (
            Object.prototype.hasOwnProperty.call(message, "id") &&
            (Object.prototype.hasOwnProperty.call(message, "result") ||
                Object.prototype.hasOwnProperty.call(message, "error"))
        )
            this.handleResponse(message);
        else if (
            Object.prototype.hasOwnProperty.call(message, "id") &&
            message.method
        )
            await this.handleRequest(message);
        else if (message.method) await this.handleNotification(message);
    }
    handleResponse(message) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new JsonRpcError(message.error));
        else pending.resolve(message.result ?? {});
    }
    async handleRequest(message) {
        const method = String(message.method ?? "");
        if (
            method === "session/request_permission" ||
            method === "session/requestPermission" ||
            method.endsWith("/request_permission")
        ) {
            await this.write({
                jsonrpc: "2.0",
                id: message.id,
                result: this.permissionResult(message.params ?? {}),
            });
            return;
        }
        await this.write({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `method not found: ${method}` },
        });
    }
    permissionResult(params) {
        const options = Array.isArray(params?.options) ? params.options : [];
        const prefixes =
            this.config.permission === "allow" ||
            (this.config.permission === "read_only" &&
                permissionLooksReadOnly(params))
                ? ["allow", "reject"]
                : ["reject"];
        for (const prefix of prefixes)
            for (const option of options) {
                if (!option || typeof option !== "object") continue;
                const kind = String(option.kind ?? option.optionKind ?? "");
                const optionId = option.optionId ?? option.id;
                if (kind.startsWith(prefix) && optionId != null)
                    return { outcome: { outcome: "selected", optionId } };
            }
        return { outcome: { outcome: "cancelled" } };
    }
    async handleNotification(message) {
        if (message.method !== "session/update") return;
        const params = message.params ?? {};
        const sessionId = params.sessionId ?? params.session_id;
        if (!sessionId) return;
        const update = params.update ?? params.sessionUpdate ?? params;
        const queue = this.sessionQueues.get(sessionId);
        if (queue) queue.push(update);
    }
    failAll(error) {
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(id);
        }
        for (const queue of this.sessionQueues.values())
            queue.close(error.message);
    }
}

export class AgentRuntime {
    constructor(config, logger = console) {
        this.config = config;
        this.runtimeId = config.instanceId ?? config.name;
        this.logger = logger;
        this.connection = new AcpConnection(config, logger);
        this.startMutex = new AsyncMutex();
        this.promptMutex = new AsyncMutex();
        this.failureCount = 0;
        this.successCount = 0;
        this.consecutiveFailures = 0;
        this.lastError = null;
        this.lastFailureAt = null;
        this.lastSuccessAt = null;
        this.cooldownUntil = 0;
    }
    get running() {
        return this.connection.running;
    }
    get busy() {
        return this.promptMutex.isLocked;
    }
    get inCooldown() {
        return Date.now() < this.cooldownUntil;
    }
    get cooldownRemainingSeconds() {
        return Math.max(0, (this.cooldownUntil - Date.now()) / 1000);
    }
    markSuccess() {
        this.successCount += 1;
        this.consecutiveFailures = 0;
        this.lastSuccessAt = Date.now();
        this.lastError = null;
        this.cooldownUntil = 0;
    }
    markFailure(error, cooldownSeconds) {
        this.failureCount += 1;
        this.consecutiveFailures += 1;
        this.lastFailureAt = Date.now();
        this.lastError = error?.message ?? String(error);
        if (cooldownSeconds > 0)
            this.cooldownUntil = Date.now() + cooldownSeconds * 1000;
    }
    async ensureStarted() {
        return await this.startMutex.runExclusive(async () => {
            if (!this.connection.running) {
                await this.connection.close().catch(() => {});
                this.connection = new AcpConnection(this.config, this.logger);
                await this.connection.start();
            }
            return this.connection;
        });
    }
    async close() {
        await this.connection.close();
    }
    async *streamPrompt(promptBlocks, signal = undefined, options = {}) {
        const release = await this.promptMutex.acquire();
        let conn;
        let sessionId;
        let queue;
        let promptDone = false;
        let promptResult;
        let promptError;
        try {
            conn = await this.ensureStarted();
            const session = await conn.newSessionInfo();
            sessionId = session.sessionId;
            queue = conn.registerSession(sessionId);
            await applyRequestedModel(
                conn,
                this.config,
                session,
                options.model,
            );
            const promptPromise = conn
                .request(
                    "session/prompt",
                    { sessionId, prompt: promptBlocks },
                    this.config.requestTimeoutSeconds,
                )
                .then((result) => {
                    promptDone = true;
                    promptResult = result;
                })
                .catch((error) => {
                    promptDone = true;
                    promptError = error;
                });
            const abortListener = () => {
                if (sessionId) conn.cancelSession(sessionId).catch(() => {});
            };
            if (signal)
                signal.addEventListener("abort", abortListener, { once: true });
            try {
                while (true) {
                    if (promptDone && queue.empty) break;
                    const item = await queue.next(100);
                    if (item?.__timeout) continue;
                    if (item?.__closed)
                        throw new AcpProcessExited(
                            item.reason ?? "ACP connection closed",
                        );
                    for (const event of eventsFromUpdate(
                        item,
                        this.config.exposeToolUpdates,
                    ))
                        yield event;
                }
                await promptPromise;
                if (promptError) throw promptError;
                this.markSuccess();
                const mappedUsage = openaiUsageFromAcpUsage(
                    promptResult?.usage,
                );
                if (mappedUsage) yield { kind: "usage", usage: mappedUsage };
                yield {
                    kind: "done",
                    stopReason: String(
                        promptResult?.stopReason ??
                            promptResult?.stop_reason ??
                            "end_turn",
                    ),
                };
            } finally {
                if (signal) signal.removeEventListener("abort", abortListener);
            }
        } catch (error) {
            if (conn && sessionId)
                await conn.cancelSession(sessionId).catch(() => {});
            throw error;
        } finally {
            if (conn && sessionId) {
                conn.unregisterSession(sessionId);
                await conn.closeSession(sessionId).catch(() => {});
            }
            release();
        }
    }
}

function applyRequestedModel(conn, config, session, requestedModel) {
    const selection = config.modelSelection;
    if (!selection || !requestedModel) return Promise.resolve();
    const configOptions = Array.isArray(session?.configOptions)
        ? session.configOptions
        : [];
    const option = findConfigOption(configOptions, selection.configId);
    const configId = selection.configId || option?.id;
    let value = selection.values?.[requestedModel];
    if (value === undefined && option)
        value = optionValueForModel(option, requestedModel);
    if (value === undefined || value === null || value === "") {
        if (selection.required)
            throw new AcpError(
                `agent ${config.instanceId ?? config.name} cannot map requested model ${JSON.stringify(requestedModel)} to an ACP model config option`,
            );
        return Promise.resolve();
    }
    if (!configId) {
        if (selection.required)
            throw new AcpError(
                `agent ${config.instanceId ?? config.name} did not expose an ACP model config option`,
            );
        return Promise.resolve();
    }
    if (option && !optionAllowsValue(option, value)) {
        if (selection.required)
            throw new AcpError(
                `agent ${config.instanceId ?? config.name} ACP model config ${JSON.stringify(configId)} does not list value ${JSON.stringify(value)} for requested model ${JSON.stringify(requestedModel)}`,
            );
        return Promise.resolve();
    }
    return conn.setSessionConfigOption(session.sessionId, configId, value);
}
function findConfigOption(options, preferredId) {
    if (!Array.isArray(options)) return null;
    if (preferredId) {
        const exact = options.find(
            (option) =>
                option &&
                String(option.id ?? option.configId ?? "") ===
                    String(preferredId),
        );
        if (exact) return exact;
    }
    return (
        options.find(
            (option) =>
                option &&
                String(option.category ?? "").toLowerCase() === "model",
        ) ??
        options.find(
            (option) =>
                option &&
                String(option.id ?? option.configId ?? "").toLowerCase() ===
                    "model",
        ) ??
        null
    );
}
function optionValueForModel(option, requestedModel) {
    const values = flattenOptionValues(option?.options);
    const exact = values.find(
        (item) => item.value === requestedModel || item.name === requestedModel,
    );
    return exact?.value;
}
function optionAllowsValue(option, value) {
    const values = flattenOptionValues(option?.options);
    return !values.length || values.some((item) => item.value === value);
}
function flattenOptionValues(options) {
    const out = [];
    for (const item of Array.isArray(options) ? options : []) {
        if (!item || typeof item !== "object") continue;
        if (Object.prototype.hasOwnProperty.call(item, "value"))
            out.push({
                value: String(item.value),
                name: item.name == null ? "" : String(item.name),
            });
        if (Array.isArray(item.options))
            out.push(...flattenOptionValues(item.options));
    }
    return out;
}

export function eventsFromUpdate(update, exposeToolUpdates = false) {
    const { kind, payload } = normalizeUpdate(update);
    if (!kind) return [];
    if (kind === "agent_message_chunk") {
        const text = contentText(
            payload.content ?? payload.message ?? payload.text,
        );
        return text ? [{ kind: "chunk", text }] : [];
    }
    if (kind === "agent_thought_chunk") return [];
    if (
        ["usage", "usage_update", "token_usage", "token_usage_update"].includes(
            kind,
        )
    ) {
        const usage = usageFromUpdate(payload);
        if (usage) return [{ kind: "usage", usage }];
        if (exposeToolUpdates && kind === "usage_update")
            return [{ kind: "tool", text: formatUsageUpdate(payload) }];
        return [];
    }
    if (
        exposeToolUpdates &&
        ["tool_call", "tool_call_update", "plan"].includes(kind)
    ) {
        const text = toolUpdateText(kind, payload);
        return text ? [{ kind: "tool", text }] : [];
    }
    return [];
}
function normalizeUpdate(update) {
    if (!update || typeof update !== "object") return { kind: "", payload: {} };
    const sessionUpdate = update.sessionUpdate ?? update.session_update;
    if (typeof sessionUpdate === "string")
        return { kind: sessionUpdate, payload: update };
    if (sessionUpdate && typeof sessionUpdate === "object")
        return {
            kind: String(
                sessionUpdate.type ??
                    sessionUpdate.kind ??
                    sessionUpdate.sessionUpdate ??
                    "",
            ),
            payload: sessionUpdate,
        };
    return { kind: String(update.type ?? update.kind ?? ""), payload: update };
}
export function contentText(content) {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map(contentText).join("");
    if (typeof content !== "object") return String(content);
    const type = content.type;
    if (type === "text") return String(content.text ?? content.content ?? "");
    if (
        type === "resource" &&
        content.resource &&
        typeof content.resource.text === "string"
    )
        return content.resource.text;
    if (type === "image") {
        const mime = content.mimeType ?? content.mime_type ?? "image/*";
        if (typeof content.data === "string" && content.data)
            return `![image](data:${mime};base64,${content.data})`;
        if (typeof content.uri === "string") return `![image](${content.uri})`;
        return `[image:${mime}]`;
    }
    if (type === "audio") {
        const mime = content.mimeType ?? content.mime_type ?? "audio/*";
        return `[audio:${mime}]`;
    }
    return "";
}
export function openaiUsageFromAcpUsage(value) {
    if (!value || typeof value !== "object") return null;
    const promptTokens = intField(value, [
        "prompt_tokens",
        "input_tokens",
        "inputTokens",
        "promptTokens",
    ]);
    const completionTokens = intField(value, [
        "completion_tokens",
        "output_tokens",
        "outputTokens",
        "completionTokens",
    ]);
    let totalTokens = intField(value, [
        "total_tokens",
        "totalTokens",
        "tokens",
    ]);
    if (promptTokens == null && completionTokens == null && totalTokens == null)
        return null;
    const prompt = promptTokens ?? 0;
    const completion = completionTokens ?? 0;
    if (totalTokens == null) totalTokens = prompt + completion;
    const usage = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: totalTokens,
    };
    const cachedTokens = intField(value, [
        "cached_read_tokens",
        "cache_read_input_tokens",
        "cachedTokens",
        "cached_tokens",
    ]);
    if (cachedTokens != null)
        usage.prompt_tokens_details = { cached_tokens: cachedTokens };
    const reasoningTokens = intField(value, [
        "thought_tokens",
        "reasoning_tokens",
        "reasoningTokens",
    ]);
    if (reasoningTokens != null)
        usage.completion_tokens_details = { reasoning_tokens: reasoningTokens };
    return usage;
}
function usageFromUpdate(update) {
    return (
        openaiUsageFromAcpUsage(update?.usage) ??
        openaiUsageFromAcpUsage(update?.tokenUsage) ??
        openaiUsageFromAcpUsage(update)
    );
}
function intField(value, names) {
    for (const name of names) {
        const raw = value?.[name];
        if (raw == null || typeof raw === "boolean") continue;
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}
function formatUsageUpdate(update) {
    const u = usageFromUpdate(update);
    return u
        ? `\n\n[usage] prompt=${u.prompt_tokens} completion=${u.completion_tokens} total=${u.total_tokens}\n\n`
        : "";
}
function toolUpdateText(kind, update) {
    if (kind === "plan") {
        const entries = update.entries ?? update.plan ?? update.steps;
        if (Array.isArray(entries))
            return `\n\n[plan]\n${entries.map((x) => `- ${typeof x === "string" ? x : JSON.stringify(x)}`).join("\n")}\n\n`;
    }
    const title =
        update.title ??
        update.name ??
        update.toolCallId ??
        update.tool_call_id ??
        kind;
    const status = update.status ? ` ${update.status}` : "";
    return `\n\n[${kind}] ${title}${status}\n\n`;
}
const ACP_SAFE_KINDS = new Set(["read", "think", "fetch"]);
const ACP_DESTRUCTIVE_KINDS = new Set(["edit", "delete", "move", "execute"]);
const DESTRUCTIVE_RE = new RegExp(
    String.raw`\b(write|delete|remove|rmdir|unlink|chmod|chown|exec(?:ute)?|shell|bash|terminal|spawn|patch|apply|install|push|rebase|sudo|kill|signal|download|format)\b` +
        String.raw`|\bgit\s+(?:push|reset|rebase)\b` +
        String.raw`|(?:^|[\s;&|])(?:rm|mv|cp|tee|dd|curl|wget|npm|pip|yarn|pnpm|cargo|gem|brew|apt)(?:\s|$)` +
        String.raw`|[>]{1,2}\s*\S` +
        String.raw`|\|\s*sh\b`,
    "i",
);

export function permissionLooksReadOnly(params) {
    const tc = params?.toolCall ?? params?.tool_call;
    const kind = String(tc?.kind ?? "").toLowerCase();
    if (ACP_DESTRUCTIVE_KINDS.has(kind)) return false;
    if (ACP_SAFE_KINDS.has(kind)) return true;
    const pieces = [tc?.title, tc?.toolCallId, tc?.tool_call_id];
    if (tc?.content !== undefined) {
        try { pieces.push(JSON.stringify(tc.content)); } catch { pieces.push(String(tc.content)); }
    }
    const text = pieces.filter(Boolean).join(" ");
    if (!text) return false;
    return !DESTRUCTIVE_RE.test(text);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAgentEnv(config) {
    const allow = Array.isArray(config.envPassthrough) ? config.envPassthrough : [];
    const env = {};
    if (allow.length === 1 && allow[0] === "*") {
        Object.assign(env, process.env);
    } else {
        for (const name of allow) {
            if (process.env[name] !== undefined) env[name] = process.env[name];
        }
    }
    Object.assign(env, config.env);
    return env;
}
