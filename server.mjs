#!/usr/bin/env node
/**
 * copilot-bridge — 把 GitHub Copilot CLI 的模型包装成 OpenAI 兼容 HTTP 接口。
 *
 * 设计要点：
 *  - 直连模式：用 GitHub OAuth token 换 Copilot 短效 token，直接转发 /responses（快，支持工具调用）。
 *  - 回退模式：直连不可用时，调用 copilot -s [--model <id>] 并把 stdout 当作回答。
 *  - 不传 --allow-all-tools：模型不会自动执行 shell / 写文件等工具。
 *  - 支持流式（SSE）与非流式 chat.completions。
 *  - 无第三方依赖，只用 Node 内置模块。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 17866);
const HOST = process.env.HOST || '127.0.0.1';
const COPILOT_BIN = process.env.COPILOT_BIN || 'copilot';
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 240000);
const CONCURRENCY = Math.max(1, Number(process.env.BRIDGE_CONCURRENCY || 2));
const AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || '';
const WORKDIR = process.env.BRIDGE_WORKDIR || path.join(os.tmpdir(), 'copilot-bridge-cwd');
const DENY_TOOLS = (process.env.BRIDGE_DENY_TOOLS !== undefined ? process.env.BRIDGE_DENY_TOOLS : 'shell,write,edit').split(',').map(s => s.trim()).filter(Boolean);
const DEBUG = process.env.BRIDGE_DEBUG === '1';

fs.mkdirSync(WORKDIR, { recursive: true });

const BUILTIN_MODELS = [
  { id: 'default', name: 'Copilot 默认模型' },
  { id: 'auto', name: 'Copilot Auto' },
];

function loadExtraModels() {
  const out = [];
  const envList = (process.env.BRIDGE_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const id of envList) out.push({ id, name: id });
  const file = process.env.BRIDGE_MODELS_FILE || path.join(process.cwd(), 'models.json');
  if (fs.existsSync(file)) {
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(arr)) for (const m of arr) if (m && m.id) out.push({ id: String(m.id), name: String(m.name || m.id) });
    } catch (e) {
      log('warn', 'ignore bad models.json: ' + e.message);
    }
  }
  return out;
}

const MODELS = [...BUILTIN_MODELS];
{
  const seen = new Set(MODELS.map(m => m.id));
  for (const m of loadExtraModels()) if (!seen.has(m.id)) { seen.add(m.id); MODELS.push(m); }
}

let active = 0;
const waiters = [];
function acquire() {
  return new Promise(resolve => {
    const start = () => {
      active++;
      resolve(() => { active--; const next = waiters.shift(); if (next) next(); });
    };
    if (active < CONCURRENCY) start(); else waiters.push(start);
  });
}

function log(level, msg) {
  if (level === 'debug' && !DEBUG) return;
  process.stderr.write('[copilot-bridge] ' + level + ' ' + msg + '\n');
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => {
      if (!p) return '';
      if (p.type === 'text') return p.text || '';
      if (p.type === 'image_url') return '[image omitted]';
      return typeof p.text === 'string' ? p.text : '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') return typeof content.text === 'string' ? content.text : '';
  return '';
}

function buildPrompt(messages) {
  const parts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const t = textOf(m && m.content);
    if (!t.trim()) continue;
    if (m.role === 'system') parts.push('System:\n' + t);
    else if (m.role === 'assistant') parts.push('Assistant:\n' + t);
    else if (m.role === 'tool') parts.push('Tool result:\n' + t);
    else parts.push('User:\n' + t);
  }
  parts.push('Assistant:');
  return parts.join('\n\n');
}

function modelArg(model) {
  if (!model || model === 'default') return null;
  return model;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GH_TOKEN_FILE = process.env.BRIDGE_GH_TOKEN_FILE || path.join(SCRIPT_DIR, '.auth', 'gh-token.json');
const COPILOT_HEADERS = {
  'Copilot-Integration-Id': 'vscode-chat',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'X-GitHub-Api-Version': '2026-06-01',
  'User-Agent': 'GitHubCopilotChat/0.35.0',
};
let directAuth = null;            // { token, base, expires }
let modelsCache = { at: 0, data: null };

function readGhToken() {
  try {
    const j = JSON.parse(fs.readFileSync(GH_TOKEN_FILE, 'utf8'));
    if (j.access_token || j.token) return j.access_token || j.token;
  } catch (_) { /* fall through */ }
  return process.env.COPILOT_GH_TOKEN || null;
}

async function getAuth() {
  const now = Math.floor(Date.now() / 1000);
  if (directAuth && directAuth.expires - 300 > now) return directAuth;
  const gh = readGhToken();
  if (!gh) return null;
  try {
    const r = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: { Authorization: 'Bearer ' + gh, Accept: 'application/json', 'User-Agent': 'copilot-bridge' },
    });
    if (!r.ok) { log('warn', 'token exchange failed: HTTP ' + r.status); directAuth = null; return null; }
    const j = await r.json();
    const m = /proxy-ep=([^;]+)/.exec(j.token || '');
    const base = m ? 'https://' + m[1].replace(/^proxy\./, 'api.') : 'https://api.individual.githubcopilot.com';
    directAuth = { token: j.token, base, expires: j.expires_at || now + 1800 };
    log('info', 'copilot token ok base=' + base + ' ttl=' + (directAuth.expires - now) + 's');
    return directAuth;
  } catch (e) {
    log('warn', 'token exchange error: ' + e.message);
    directAuth = null;
    return null;
  }
}

async function directModels() {
  const a = await getAuth();
  if (!a) return null;
  if (modelsCache.data && Date.now() - modelsCache.at < 60000) return modelsCache.data;
  try {
    const r = await fetch(a.base + '/models', { headers: Object.assign({}, COPILOT_HEADERS, { Authorization: 'Bearer ' + a.token, Accept: 'application/json' }) });
    if (!r.ok) return null;
    const j = await r.json();
    modelsCache = { at: Date.now(), data: Array.isArray(j.data) ? j.data : [] };
    return modelsCache.data;
  } catch (e) {
    log('warn', 'models fetch failed: ' + e.message);
    return null;
  }
}

async function handleResponses(req, res, rawBody) {
  const a = await getAuth();
  if (!a) return sendJson(res, 503, errorPayload('copilot direct auth unavailable (no valid GitHub token); falling back not possible on this endpoint', 'auth_error'));
  let initiator = 'user';
  try {
    const parsed = JSON.parse(rawBody);
    const input = Array.isArray(parsed.input) ? parsed.input : [];
    const last = input[input.length - 1];
    if (last && last.role && last.role !== 'user') initiator = 'agent';
  } catch (_) { /* keep default */ }
  const r = await fetch(a.base + '/responses', {
    method: 'POST',
    headers: Object.assign({}, COPILOT_HEADERS, {
      Authorization: 'Bearer ' + a.token,
      'Content-Type': 'application/json',
      Accept: req.headers.accept || 'text/event-stream',
      'X-Initiator': initiator,
      'Openai-Intent': 'conversation-edits',
    }),
    body: rawBody,
  });
  res.writeHead(r.status, {
    'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  if (r.body) for await (const chunk of r.body) res.write(chunk);
  res.end();
}

function runCopilot(prompt, model, onChunk) {
  return new Promise((resolve, reject) => {
    const args = ['-s'];
    const ma = modelArg(model);
    if (ma) args.push('--model', ma);
    for (const t of DENY_TOOLS) args.push('--deny-tool=' + t);
    const env = Object.assign({}, process.env, { COPILOT_AUTO_UPDATE: 'false', NO_COLOR: '1' });
    log('debug', 'spawn ' + COPILOT_BIN + ' ' + JSON.stringify(args.slice(0, 4)));
    const child = spawn(COPILOT_BIN, args, { cwd: WORKDIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    let out = '', err = '', finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      log('warn', 'timeout after ' + TIMEOUT_MS + 'ms, killing');
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000);
    }, TIMEOUT_MS);
    child.stdout.on('data', d => { const s = d.toString(); out += s; if (onChunk) onChunk(s); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => { finished = true; clearTimeout(timer); reject(e); });
    child.on('close', code => {
      finished = true; clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

function estimateTokens(s) { return Math.max(1, Math.ceil((s || '').length / 4)); }

function errorPayload(message, type, code) {
  return { error: { message, type: type || 'bridge_error', code: code || 'bridge_error' } };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > 32 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!AUTH_TOKEN) return true;
  const h = req.headers['authorization'] || '';
  return h === 'Bearer ' + AUTH_TOKEN;
}

function listModels() {
  return MODELS.map(m => ({ id: m.id, object: 'model', created: 0, owned_by: 'github-copilot' }));
}

async function handleChat(req, res, body) {
  const release = await acquire();
  try {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return sendJson(res, 400, errorPayload('messages is required', 'invalid_request_error'));
    const model = typeof body.model === 'string' && body.model ? body.model : 'default';
    const prompt = buildPrompt(messages);
    const stream = body.stream === true;
    const id = 'chatcmpl-' + Math.random().toString(36).slice(2, 12);
    const created = Math.floor(Date.now() / 1000);

    if (!stream) {
      const { code, out, err } = await runCopilot(prompt, model, null);
      const content = out;
      if (!content.trim()) {
        const msg = (err || '').trim().split('\n').slice(-3).join('\n') || 'copilot returned empty output (exit ' + code + ')';
        const status = /is not available/i.test(msg) ? 400 : 502;
        return sendJson(res, status, errorPayload(msg, status === 400 ? 'model_not_found' : 'bridge_upstream_error'));
      }
      const usage = { prompt_tokens: estimateTokens(prompt), completion_tokens: estimateTokens(content), total_tokens: estimateTokens(prompt) + estimateTokens(content) };
      return sendJson(res, 200, {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage,
      });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    let sentAny = false;
    const write = (obj) => { if (closed) return; res.write('data: ' + JSON.stringify(obj) + '\n\n'); };
    const delta = (text) => {
      if (!text) return;
      sentAny = true;
      write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    };
    res.on('close', () => { closed = true; });

    let result;
    try {
      result = await runCopilot(prompt, model, (s) => delta(s));
    } catch (e) {
      if (!closed) write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: '[bridge error] ' + e.message }, finish_reason: null }] });
      if (!closed) res.end('data: [DONE]\n\n');
      return;
    }
    const { code, err } = result;
    if (!sentAny) {
      const msg = (err || '').trim().split('\n').slice(-3).join('\n') || 'copilot returned empty output (exit ' + code + ')';
      write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: '[copilot error] ' + msg }, finish_reason: null }] });
    }
    if (!closed) {
      write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    }
  } finally {
    release();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, models: MODELS.map(m => m.id) });
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      if (!authorized(req)) return sendJson(res, 401, errorPayload('unauthorized', 'auth_error'));
      const dm = await directModels();
      if (dm) {
        return sendJson(res, 200, { object: 'list', data: dm.map(m => ({
          id: m.id, object: 'model', created: 0, owned_by: 'github-copilot',
          name: m.name, endpoints: m.supported_endpoints,
          context_window: m.capabilities && m.capabilities.limits && m.capabilities.limits.max_context_window_tokens,
          max_output_tokens: m.capabilities && m.capabilities.limits && m.capabilities.limits.max_output_tokens,
        })) });
      }
      return sendJson(res, 200, { object: 'list', data: listModels() });
    }
    if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) {
      if (!authorized(req)) return sendJson(res, 401, errorPayload('unauthorized', 'auth_error'));
      const raw = await readRaw(req);
      return await handleResponses(req, res, raw);
    }
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      if (!authorized(req)) return sendJson(res, 401, errorPayload('unauthorized', 'auth_error'));
      const body = await readBody(req);
      return await handleChat(req, res, body);
    }
    return sendJson(res, 404, errorPayload('not found: ' + url.pathname, 'not_found'));
  } catch (e) {
    log('error', (e && e.stack) || String(e));
    if (!res.headersSent) sendJson(res, 500, errorPayload(e.message || 'internal error'));
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  log('info', 'listening on http://' + HOST + ':' + PORT + '  (models: ' + MODELS.map(m => m.id).join(', ') + ')');
  log('info', 'copilot bin: ' + COPILOT_BIN + '  workdir: ' + WORKDIR);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log('info', 'shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); });
}
