import crypto from 'node:crypto';

export class BadRequest extends Error { constructor(message) { super(message); this.name = 'BadRequest'; } }
export class AgentCapabilityError extends BadRequest { constructor(message) { super(message); this.name = 'AgentCapabilityError'; } }

const DATA_URI_RE = /^data:([^;,]+);base64,(.*)$/is;
const AUDIO_FORMAT_TO_MIME = { wav: 'audio/wav', wave: 'audio/wav', mp3: 'audio/mpeg', mpeg: 'audio/mpeg', mpga: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac' };
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function now() { return Math.floor(Date.now() / 1000); }
export function makeId(prefix) { return `${prefix}_${crypto.randomBytes(12).toString('hex')}`; }
export function dumps(value) { return JSON.stringify(value); }
export function sseData(value) { return `data: ${dumps(value)}\n\n`; }
export function sseEvent(event, value) { return `event: ${event}\ndata: ${dumps(value)}\n\n`; }
export function doneSse() { return 'data: [DONE]\n\n'; }

export function checkSingleChoice(body) { const raw = body?.n ?? 1; const n = Number.parseInt(raw, 10); if (!Number.isFinite(n) || n < 1) throw new BadRequest('n must be a positive integer'); if (n !== 1) throw new BadRequest('n > 1 is not supported because one ACP prompt turn yields one agent response'); }
export function checkTools(body) { const tools = body?.tools ?? []; const functions = body?.functions ?? []; const toolChoice = body?.tool_choice ?? body?.toolChoice; const functionCall = body?.function_call ?? body?.functionCall; if ((Array.isArray(tools) && tools.length) || (Array.isArray(functions) && functions.length) || ![undefined, null, 'none'].includes(toolChoice) || ![undefined, null, 'none'].includes(functionCall)) throw new BadRequest('OpenAI request-level tools are only supported on /v1/chat/completions by this proxy.'); }
export function modelOrDefault(body, defaultModel) { const model = body?.model ?? defaultModel; if (!model || typeof model !== 'string') throw new BadRequest('model must be a string'); return model; }

export function buildChatPrompt(body, agentCapabilities = {}) {
  checkSingleChoice(body);
  const messages = body?.messages;
  if (!Array.isArray(messages) || !messages.length) throw new BadRequest('messages must be a non-empty array');
  const toolContext = clientToolContext(body);
  const textSections = toolContext.promptText ? [`[system(openai_client_tools)]\n${toolContext.promptText}`] : [];
  const attachments = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') throw new BadRequest('each message must be an object');
    const role = String(message.role ?? 'user'); const label = message.name ? `${role}(${message.name})` : role;
    let { text, blocks } = contentToTextAndBlocks(message.content, agentCapabilities);
    if (message.tool_calls) { const toolCalls = dumps(message.tool_calls); text = text ? `${text}\n\ntool_calls: ${toolCalls}` : `tool_calls: ${toolCalls}`; }
    if (message.tool_call_id) text = `tool_call_id: ${message.tool_call_id}\n${text}`;
    if (text.trim()) textSections.push(`[${label}]\n${text.trim()}`);
    attachments.push(...blocks, ...attachmentsToBlocks(message.attachments, agentCapabilities));
  }
  const blocks = [];
  if (textSections.length) blocks.push({ type: 'text', text: textSections.join('\n\n') });
  blocks.push(...attachments);
  if (!blocks.length) throw new BadRequest('request did not contain text or supported resource content');
  return blocks;
}

export function clientToolContext(body) {
  const tools = normalizeClientTools(body);
  const choice = normalizeToolChoice(body);
  if (!tools.length || choice.mode === 'none') return { tools, choice, promptText: '', enabled: false };
  const selected = choice.mode === 'function' ? tools.filter((tool) => tool.function.name === choice.name) : tools;
  if (choice.mode === 'function' && !selected.length) throw new BadRequest(`tool_choice references unknown function ${JSON.stringify(choice.name)}`);
  const instruction = [
    'The HTTP client supplied OpenAI function tools. The proxy cannot execute these tools; the client will execute them after you request them.',
    'When a tool is needed, respond with only a JSON object in this exact shape: {"tool_calls":[{"name":"function_name","arguments":{}}]}.',
    'Do not wrap that JSON in markdown and do not include explanatory prose. If no tool is needed, answer normally.',
    'After a [tool] message appears in the conversation, use that tool result to answer the user.'
  ];
  if (choice.mode === 'required') instruction.push('You must call at least one supplied tool.');
  if (choice.mode === 'function') instruction.push(`You must call ${JSON.stringify(choice.name)}.`);
  instruction.push(`Available tools: ${dumps(selected.map((tool) => tool.function))}`);
  return { tools, choice, promptText: instruction.join('\n'), enabled: true };
}

export function normalizeClientTools(body) {
  const out = [];
  const tools = body?.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) throw new BadRequest('tools must be an array');
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object' || tool.type !== 'function' || !tool.function || typeof tool.function !== 'object') throw new BadRequest('only function tools are supported');
      out.push(normalizeFunctionTool(tool.function));
    }
  }
  const functions = body?.functions;
  if (functions !== undefined) {
    if (!Array.isArray(functions)) throw new BadRequest('functions must be an array');
    for (const fn of functions) out.push(normalizeFunctionTool(fn));
  }
  return out;
}

export function normalizeToolChoice(body) {
  const raw = body?.tool_choice ?? body?.toolChoice ?? body?.function_call ?? body?.functionCall;
  if (raw === undefined || raw === null || raw === 'auto') return { mode: 'auto' };
  if (raw === 'none') return { mode: 'none' };
  if (raw === 'required') return { mode: 'required' };
  if (typeof raw === 'object') {
    const name = raw.function?.name ?? raw.name;
    if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) throw new BadRequest('tool_choice function name must be a valid function name');
    return { mode: 'function', name };
  }
  throw new BadRequest('tool_choice must be auto, none, required, or a function tool choice');
}

export function extractClientToolCalls(text, body) {
  const context = clientToolContext(body);
  if (!context.enabled) return [];
  const parsed = parseToolCallEnvelope(text);
  if (!parsed) return [];
  const allowed = new Set(context.tools.map((tool) => tool.function.name));
  const calls = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const name = item.name ?? item.function?.name;
    if (typeof name !== 'string' || !allowed.has(name)) continue;
    if (context.choice.mode === 'function' && name !== context.choice.name) continue;
    const args = item.arguments ?? item.function?.arguments ?? {};
    calls.push({ id: item.id && typeof item.id === 'string' ? item.id : makeId('call'), type: 'function', function: { name, arguments: argumentsString(args) } });
  }
  return calls;
}

export function buildCompletionPrompt(body) { checkSingleChoice(body); const prompt = body?.prompt ?? ''; const text = Array.isArray(prompt) ? prompt.map(stringify).join('\n') : stringify(prompt); if (!text) throw new BadRequest('prompt must not be empty'); return [{ type: 'text', text }]; }

export function buildResponsesPrompt(body, agentCapabilities = {}) {
  checkTools(body);
  const pseudoMessages = [];
  if (typeof body?.instructions === 'string' && body.instructions.trim()) pseudoMessages.push({ role: 'system', content: body.instructions });
  const input = body?.input;
  if (typeof input === 'string') pseudoMessages.push({ role: 'user', content: input });
  else if (Array.isArray(input)) {
    let flatParts = [];
    for (const item of input) {
      if (item && typeof item === 'object' && item.type === 'message') { if (flatParts.length) { pseudoMessages.push({ role: 'user', content: flatParts }); flatParts = []; } pseudoMessages.push({ role: item.role ?? 'user', content: item.content ?? [], attachments: item.attachments ?? [] }); }
      else if (item && typeof item === 'object' && ('role' in item || 'content' in item)) { if (flatParts.length) { pseudoMessages.push({ role: 'user', content: flatParts }); flatParts = []; } pseudoMessages.push({ role: item.role ?? 'user', content: item.content ?? [], attachments: item.attachments ?? [] }); }
      else if (item && typeof item === 'object' && isContentPartType(item.type)) flatParts.push(item);
      else if (item && typeof item === 'object') flatParts.push({ type: 'text', text: dumps(item) });
      else flatParts.push({ type: 'text', text: stringify(item) });
    }
    if (flatParts.length) pseudoMessages.push({ role: 'user', content: flatParts });
  } else throw new BadRequest('input must be a string or an array');
  return buildChatPrompt({ messages: pseudoMessages }, agentCapabilities);
}
function normalizeFunctionTool(fn) {
  if (!fn || typeof fn !== 'object') throw new BadRequest('function tool definitions must be objects');
  const name = fn.name;
  if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) throw new BadRequest('function tool name must match /^[A-Za-z0-9_-]{1,64}$/');
  const normalized = { name };
  if (fn.description !== undefined) normalized.description = String(fn.description);
  if (fn.parameters !== undefined) {
    if (!fn.parameters || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters)) throw new BadRequest(`function tool ${name} parameters must be an object JSON schema`);
    normalized.parameters = fn.parameters;
  }
  if (fn.strict !== undefined) normalized.strict = Boolean(fn.strict);
  return { type: 'function', function: normalized };
}
function parseToolCallEnvelope(text) {
  for (const candidate of toolJsonCandidates(text)) {
    try {
      const value = JSON.parse(candidate);
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.tool_calls)) return value.tool_calls;
      if (Array.isArray(value?.toolCalls)) return value.toolCalls;
      if (value?.name || value?.function?.name) return [value];
    } catch {}
  }
  return null;
}
function toolJsonCandidates(text) {
  const trimmed = String(text ?? '').trim();
  const candidates = [];
  if (trimmed) candidates.push(trimmed);
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fence) candidates.push(fence[1].trim());
  for (const marker of ['"tool_calls"', '"toolCalls"', '"name"']) {
    const index = trimmed.indexOf(marker);
    if (index < 0) continue;
    const open = Math.max(trimmed.lastIndexOf('{', index), trimmed.lastIndexOf('[', index));
    if (open < 0) continue;
    const extracted = balancedJsonSlice(trimmed, open);
    if (extracted) candidates.push(extracted);
  }
  return [...new Set(candidates)];
}
function balancedJsonSlice(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : '';
  if (!close) return '';
  let depth = 0; let quote = false; let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (quote && ch === '\\') { escape = true; continue; }
    if (ch === '"') { quote = !quote; continue; }
    if (quote) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}
function argumentsString(value) {
  if (typeof value === 'string') {
    try { return dumps(JSON.parse(value)); } catch { return value; }
  }
  if (value === undefined || value === null) return '{}';
  return dumps(value);
}
function isContentPartType(type) { return ['text','input_text','output_text','image_url','input_image','input_audio','audio','audio_url','file','input_file'].includes(type); }
function contentToTextAndBlocks(content, caps) { if (content == null) return { text: '', blocks: [] }; if (typeof content === 'string') return { text: content, blocks: [] }; if (!Array.isArray(content)) return { text: stringify(content), blocks: [] }; const texts = []; const blocks = []; for (const part of content) { if (!part || typeof part !== 'object') { texts.push(stringify(part)); continue; } const type = String(part.type ?? 'text'); if (type === 'text' || type === 'input_text' || type === 'output_text') texts.push(String(part.text ?? part.content ?? '')); else if (type === 'image_url' || type === 'input_image') blocks.push(imagePartToBlock(part, caps)); else if (type === 'input_audio' || type === 'audio' || type === 'audio_url') blocks.push(audioPartToBlock(part, caps)); else if (type === 'file' || type === 'input_file') blocks.push(filePartToBlock(part, caps)); else texts.push(dumps(part)); } return { text: texts.filter(Boolean).join('\n'), blocks: blocks.filter(Boolean) }; }
function attachmentsToBlocks(attachments, caps) { if (attachments == null) return []; if (!Array.isArray(attachments)) throw new BadRequest('attachments must be an array'); return attachments.map((item) => filePartToBlock(item, caps)).filter(Boolean); }
function imagePartToBlock(part, caps) { const imageUrl = part.image_url ?? part.imageUrl ?? part.url ?? part.image; const rawUrl = typeof imageUrl === 'string' ? imageUrl : imageUrl?.url; if (!rawUrl && typeof part.data === 'string') { requirePromptCapability(caps, 'image', 'ACP agent does not advertise image prompt support'); return { type: 'image', mimeType: String(part.mime_type ?? part.mimeType ?? 'image/png'), data: stripBase64(part.data) }; } if (!rawUrl) throw new BadRequest('image content requires image_url.url, url, or base64 data'); const dataUri = parseDataUri(rawUrl); if (dataUri) { requirePromptCapability(caps, 'image', 'ACP agent does not advertise image prompt support'); if (!dataUri.mime.toLowerCase().startsWith('image/')) throw new BadRequest('image data URI must have an image/* MIME type'); return { type: 'image', mimeType: dataUri.mime, data: dataUri.data }; } return resourceLink(rawUrl, part.name ?? 'image', part.mime_type ?? part.mimeType ?? 'image/*'); }
function audioPartToBlock(part, caps) { const inputAudio = part.input_audio ?? part.inputAudio ?? part.audio ?? part; const rawUrl = part.audio_url?.url ?? part.audioUrl?.url ?? part.audio_url ?? part.audioUrl ?? part.url ?? inputAudio.url; const rawData = inputAudio.data ?? part.data; if (typeof rawData === 'string' && rawData) { const dataUri = parseDataUri(rawData); const format = String(inputAudio.format ?? part.format ?? '').toLowerCase(); const mime = dataUri?.mime ?? part.mime_type ?? part.mimeType ?? AUDIO_FORMAT_TO_MIME[format] ?? 'audio/wav'; if (dataUri && !dataUri.mime.toLowerCase().startsWith('audio/')) throw new BadRequest('audio data URI must have an audio/* MIME type'); requirePromptCapability(caps, 'audio', 'ACP agent does not advertise audio prompt support'); return { type: 'audio', mimeType: mime, data: dataUri?.data ?? stripBase64(rawData) }; } if (typeof rawUrl === 'string' && rawUrl) return resourceLink(rawUrl, part.name ?? 'audio', part.mime_type ?? part.mimeType ?? 'audio/*'); throw new BadRequest('audio content requires base64 data or a URL'); }
function filePartToBlock(part, caps) { if (!part || typeof part !== 'object') throw new BadRequest('file attachment must be an object'); const fileId = part.file_id ?? part.fileId; if (fileId) throw new BadRequest('file_id is not supported because a local ACP agent cannot dereference OpenAI-hosted files'); const uri = part.uri ?? part.url ?? part.file_url ?? part.fileUrl; if (typeof uri === 'string' && uri) return resourceLink(uri, part.filename ?? part.name, part.mime_type ?? part.mimeType); const data = part.file_data ?? part.fileData ?? part.data; if (typeof data === 'string' && data) { const dataUri = parseDataUri(data); requirePromptCapability(caps, 'embeddedContext', 'ACP agent does not advertise embedded-context/resource prompt support'); return { type: 'resource', resource: { uri: part.filename ?? part.name ?? 'attachment', mimeType: dataUri?.mime ?? part.mime_type ?? part.mimeType ?? 'application/octet-stream', blob: dataUri?.data ?? stripBase64(data) } }; } const text = part.text ?? part.content; if (typeof text === 'string') { requirePromptCapability(caps, 'embeddedContext', 'ACP agent does not advertise embedded-context/resource prompt support'); return { type: 'resource', resource: { uri: part.filename ?? part.name ?? 'attachment.txt', mimeType: part.mime_type ?? part.mimeType ?? 'text/plain', text } }; } throw new BadRequest('file attachment requires uri/url, text/content, file_data, or data'); }
function resourceLink(uri, name = undefined, mimeType = undefined) { const block = { type: 'resource_link', uri: String(uri) }; if (name) block.name = String(name); if (mimeType) block.mimeType = String(mimeType); return block; }
function requirePromptCapability(caps, capability, message) { const promptCaps = caps?.promptCapabilities ?? caps?.prompt_capabilities ?? {}; if (!promptCaps || typeof promptCaps !== 'object' || !promptCaps[capability]) throw new AgentCapabilityError(message); }
function parseDataUri(value) { const match = DATA_URI_RE.exec(value); return match ? { mime: match[1], data: match[2] } : null; }
function stripBase64(value) { const dataUri = parseDataUri(value); return dataUri?.data ?? value.replace(/\s+/g, ''); }
function stringify(value) { if (value == null) return ''; if (typeof value === 'string') return value; return dumps(value); }

export function estimateTokens(text) { if (!text) return 0; return Math.max(1, Math.ceil(text.length / 4)); }
export function promptTextForUsage(blocks) { const pieces = []; for (const block of blocks ?? []) { if (!block || typeof block !== 'object') continue; if (block.type === 'text') pieces.push(String(block.text ?? '')); else if (block.type === 'resource_link') pieces.push(String(block.uri ?? block.name ?? '')); else if (block.type === 'resource') pieces.push(String(block.resource?.uri ?? block.resource?.mimeType ?? '[resource]')); else if (block.type === 'image' || block.type === 'audio') pieces.push(`[${block.type}:${block.mimeType ?? 'unknown'}]`); else pieces.push(dumps(block)); } return pieces.filter(Boolean).join('\n'); }
export function usage(promptBlocks, completionText) { const promptTokens = estimateTokens(promptTextForUsage(promptBlocks)); const completionTokens = estimateTokens(completionText); return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }; }
export function responseUsage(promptBlocks, completionText, usageOverride = null) { return usageOverride && typeof usageOverride === 'object' ? usageOverride : usage(promptBlocks, completionText); }
export function finishReason(stopReason) { return { end_turn: 'stop', max_tokens: 'length', max_turn_requests: 'length', refusal: 'content_filter', cancelled: 'stop', tool_calls: 'tool_calls' }[stopReason] ?? 'stop'; }
export function chatCompletionResponse(model, promptBlocks, text, stopReason = 'end_turn', usageOverride = null, toolCalls = []) { const message = toolCalls?.length ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content: text }; return { id: makeId('chatcmpl'), object: 'chat.completion', created: now(), model, choices: [{ index: 0, message, finish_reason: toolCalls?.length ? 'tool_calls' : finishReason(stopReason) }], usage: responseUsage(promptBlocks, text, usageOverride) }; }
export function completionResponse(model, promptBlocks, text, stopReason = 'end_turn', usageOverride = null) { return { id: makeId('cmpl'), object: 'text_completion', created: now(), model, choices: [{ index: 0, text, finish_reason: finishReason(stopReason), logprobs: null }], usage: responseUsage(promptBlocks, text, usageOverride) }; }
export function responsesApiResponse(model, promptBlocks, text, stopReason = 'end_turn', usageOverride = null) { const outputId = makeId('msg'); return { id: makeId('resp'), object: 'response', created_at: now(), status: 'completed', model, output: [{ id: outputId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], output_text: text, error: null, incomplete_details: null, usage: responseUsage(promptBlocks, text, usageOverride), metadata: {} }; }
