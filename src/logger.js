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
            msg: redact(String(message), STRING_MAX),
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

const STACK_MAX = 4 * 1024;
const STRING_MAX = 8 * 1024;
const SECRET_RE = /(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{16,}|sk_[A-Za-z0-9_-]{16,}|gh[ps]_[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_-]{20,}|ghu_[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,})/g;

function redact(text, max) {
    if (typeof text !== "string") return text;
    const s = text.replace(SECRET_RE, "<redacted>");
    return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}

function formatValue(value) {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: redact(value.message ?? "", STRING_MAX),
            stack: redact(value.stack ?? "", STACK_MAX),
        };
    }
    if (typeof value === "string") return redact(value, STRING_MAX);
    return value;
}

function formatText(entry) {
    const { time, level, service, msg, ...fields } = entry;
    const suffix = Object.keys(fields).length
        ? ` ${JSON.stringify(fields)}`
        : "";
    return `${time} ${level.toUpperCase()} ${service}: ${msg}${suffix}`;
}
