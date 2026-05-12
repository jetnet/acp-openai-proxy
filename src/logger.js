const LEVELS = new Map([
    ["debug", 10],
    ["info", 20],
    ["warn", 30],
    ["error", 40],
    ["silent", 50],
]);

export function createLogger({
    level = process.env.ACP_OPENAI_PROXY_LOG_LEVEL || "info",
    format = process.env.ACP_OPENAI_PROXY_LOG_FORMAT || "json",
    service = "acp-openai-proxy",
} = {}) {
    const threshold =
        LEVELS.get(String(level).toLowerCase()) ?? LEVELS.get("info");
    const logFormat = String(format).toLowerCase() === "text" ? "text" : "json";
    const log = (name, message, fields = {}) => {
        const severity = LEVELS.get(name);
        if (severity < threshold) return;
        const stream =
            severity >= LEVELS.get("warn") ? process.stderr : process.stdout;
        const entry = {
            time: new Date().toISOString(),
            level: name,
            service,
            msg: String(message),
            ...cleanFields(fields),
        };
        stream.write(
            `${logFormat === "text" ? formatText(entry) : JSON.stringify(entry)}\n`,
        );
    };
    return {
        debug: (message, fields) => log("debug", message, fields),
        info: (message, fields) => log("info", message, fields),
        warn: (message, fields) => log("warn", message, fields),
        error: (message, fields) => log("error", message, fields),
    };
}

function cleanFields(fields) {
    if (fields instanceof Error) return { error: formatValue(fields) };
    if (!fields || typeof fields !== "object") return {};
    const out = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        out[key] = formatValue(value);
    }
    return out;
}

function formatValue(value) {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }
    return value;
}

function formatText(entry) {
    const { time, level, service, msg, ...fields } = entry;
    const suffix = Object.keys(fields).length
        ? ` ${JSON.stringify(fields)}`
        : "";
    return `${time} ${level.toUpperCase()} ${service}: ${msg}${suffix}`;
}
