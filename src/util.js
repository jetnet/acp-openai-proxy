export function compactError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message).replace(/\s+/g, ' ').trim();
  try { return JSON.stringify(err); } catch { return String(err); }
}

export function jsonResponse(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(`${JSON.stringify(body)}\n`);
}

export function openAiError(message, type = 'server_error', status = 500, code = null) {
  return { status, body: { error: { message: String(message), type, param: null, code } } };
}

export async function readJsonBody(req, maxBytes = 64 * 1024 * 1024) {
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const err = new Error(`request body exceeds max_request_bytes (${declared} > ${maxBytes})`);
    err.status = 413;
    err.type = 'invalid_request_error';
    throw err;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error('request body too large');
      err.status = 413;
      err.type = 'invalid_request_error';
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch (cause) {
    const err = new Error(`request body must be valid JSON: ${cause.message}`);
    err.status = 400;
    err.type = 'invalid_request_error';
    throw err;
  }
}
