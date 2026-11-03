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
const USAGE_DIR = path.join(SCRIPT_DIR, '.usage');
const USAGE_FILE = path.join(USAGE_DIR, 'usage.jsonl');
const QUOTA_TTL_MS = 5 * 60 * 1000;
fs.mkdirSync(USAGE_DIR, { recursive: true });
let quotaCache = { at: 0, data: null };

function creditsFromUsage(cu) {
  if (cu && typeof cu.total_nano_aiu === 'number') return { credits: cu.total_nano_aiu / 1e9, raw: cu.total_nano_aiu };
  if (!cu || !Array.isArray(cu.token_details)) return { credits: null, raw: 0 };
  let raw = 0;
  for (const d of cu.token_details) {
    const tc = Number(d.token_count) || 0;
    const bs = Number(d.batch_size) || 1;
    const cpb = Number(d.cost_per_batch) || 0;
    raw += (tc / bs) * cpb;
  }
  return { credits: raw / 1e9, raw };
}

function recordUsage(rec) {
  try {
    fs.appendFileSync(USAGE_FILE, JSON.stringify(rec) + '\n');
  } catch (e) {
    log('warn', 'usage record failed: ' + e.message);
  }
}

function readUsage() {
  try {
    return fs.readFileSync(USAGE_FILE, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function parseRange(q) {
  if (!q || q === 'all') return 0;
  if (q === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  const m = /^(\d+)([dhm])$/.exec(q);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2] === 'd' ? 86400000 : m[2] === 'h' ? 3600000 : 60000;
  return Date.now() - n * unit;
}

function p95(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

function usageSummary(range) {
  const since = parseRange(range);
  const rows = readUsage().filter(r => (r.ts || 0) >= since);
  const byDay = new Map(), byModel = new Map();
  let credits = 0, creditsKnown = 0, input = 0, output = 0, errors = 0;
  const ttfts = [];
  for (const r of rows) {
    const day = new Date(r.ts).toISOString().slice(0, 10);
    const d = byDay.get(day) || { date: day, requests: 0, credits: 0, input: 0, output: 0 };
    d.requests++; d.input += r.input_tokens || 0; d.output += r.output_tokens || 0;
    if (typeof r.credits === 'number') d.credits += r.credits;
    byDay.set(day, d);
    const mk = r.model || 'unknown';
    const mo = byModel.get(mk) || { model: mk, requests: 0, credits: 0, input: 0, output: 0 };
    mo.requests++; mo.input += r.input_tokens || 0; mo.output += r.output_tokens || 0;
    if (typeof r.credits === 'number') mo.credits += r.credits;
    byModel.set(mk, mo);
    if (typeof r.credits === 'number') { credits += r.credits; creditsKnown++; }
    input += r.input_tokens || 0; output += r.output_tokens || 0;
    if (r.ttft_ms != null) ttfts.push(r.ttft_ms);
    if (r.ok === false || (r.status && r.status >= 400)) errors++;
  }
  const round = v => Math.round(v * 1e6) / 1e6;
  return {
    range: range || 'all',
    since,
    summary: {
      requests: rows.length,
      errors,
      input_tokens: input,
      output_tokens: output,
      credits: round(credits),
      credits_requests: creditsKnown,
      avg_ttft_ms: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null,
      p95_ttft_ms: p95(ttfts),
    },
    by_day: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map(d => ({ ...d, credits: round(d.credits) })),
    by_model: [...byModel.values()].sort((a, b) => b.credits - a.credits || b.requests - a.requests).map(m => ({ ...m, credits: round(m.credits) })),
    recent: rows.slice(-50).reverse(),
  };
}

async function getQuota() {
  if (quotaCache.data && Date.now() - quotaCache.at < QUOTA_TTL_MS) return quotaCache.data;
  const gh = readGhToken();
  if (!gh) return null;
  try {
    const r = await fetch('https://api.github.com/copilot_internal/user', {
      headers: { Authorization: 'Bearer ' + gh, Accept: 'application/json', 'User-Agent': 'copilot-bridge' },
    });
    if (!r.ok) { log('warn', 'quota fetch failed: HTTP ' + r.status); return null; }
    const j = await r.json();
    const quotas = j.quota_snapshots || {};
    const data = {
      login: j.login,
      plan: j.copilot_plan,
      sku: j.access_type_sku,
      reset_date: j.quota_reset_date,
      quotas: Object.fromEntries(Object.entries(quotas).map(([k, v]) => [k, {
        unlimited: v.unlimited,
        percent_remaining: v.percent_remaining,
        remaining: v.quota_remaining,
        used: v.credits_used,
        overage_permitted: v.overage_permitted,
      }])),
      fetched_at: Date.now(),
    };
    quotaCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    log('warn', 'quota fetch error: ' + e.message);
    return null;
  }
}


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
  const t0 = Date.now();
  let parsedReq = null;
  try { parsedReq = JSON.parse(rawBody); } catch (_) { /* keep null */ }
  const reqModel = parsedReq && parsedReq.model ? String(parsedReq.model) : null;
  const reqStream = !!(parsedReq && parsedReq.stream);
  const reqId = 'req-' + Math.random().toString(36).slice(2, 12);
  const base = {
    ts: Date.now(), id: reqId, mode: 'direct', model: reqModel, stream: reqStream,
    tools: parsedReq && Array.isArray(parsedReq.tools) ? parsedReq.tools.length : 0,
    body_bytes: Buffer.byteLength(rawBody),
  };
  const a = await getAuth();
  if (!a) {
    recordUsage(Object.assign({}, base, { ok: false, status: 0, error: 'no_auth', duration_ms: Date.now() - t0 }));
    return sendJson(res, 503, errorPayload('copilot direct auth unavailable (no valid GitHub token)', 'auth_error'));
  }
  let initiator = 'user';
  const input = parsedReq && Array.isArray(parsedReq.input) ? parsedReq.input : [];
  const last = input[input.length - 1];
  if (last && last.role && last.role !== 'user') initiator = 'agent';
  let r;
  try {
    r = await fetch(a.base + '/responses', {
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
  } catch (e) {
    recordUsage(Object.assign({}, base, { ok: false, status: 0, error: e.message, duration_ms: Date.now() - t0 }));
    return sendJson(res, 502, errorPayload('upstream fetch failed: ' + e.message, 'bridge_upstream_error'));
  }
  const ctype = r.headers.get('content-type') || '';
  const sse = ctype.includes('text/event-stream');
  res.writeHead(r.status, {
    'Content-Type': ctype || 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  let ttft = null, sseBuf = '', nonStream = '', captured = null;
  if (r.body) {
    for await (const chunk of r.body) {
      if (ttft === null) ttft = Date.now() - t0;
      res.write(chunk);
      const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      if (!sse) { nonStream += s; continue; }
      sseBuf += s;
      let idx;
      while ((idx = sseBuf.indexOf('\n\n')) !== -1) {
        const frame = sseBuf.slice(0, idx);
        sseBuf = sseBuf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const u = (j && j.response && j.response.usage) || (j && j.usage) || null;
            const c = (j && j.copilot_usage) || (j && j.response && j.response.copilot_usage) || null;
            if (u || c) captured = { usage: u, copilot_usage: c };
          } catch (_) { /* partial frame */ }
        }
      }
    }
  }
  res.end();
  let usage = null, cu = null;
  if (sse) {
    if (captured) { usage = captured.usage || null; cu = captured.copilot_usage || null; }
  } else {
    try { const j = JSON.parse(nonStream); usage = j.usage || null; cu = j.copilot_usage || null; } catch (_) { /* ignore */ }
  }
  const cred = creditsFromUsage(cu);
  recordUsage(Object.assign({}, base, {
    ok: r.ok, status: r.status,
    input_tokens: usage ? usage.input_tokens : null,
    output_tokens: usage ? usage.output_tokens : null,
    cached_tokens: usage && usage.input_tokens_details ? usage.input_tokens_details.cached_tokens : null,
    credits: cred.credits, credits_raw: cred.raw,
    ttft_ms: ttft, duration_ms: Date.now() - t0,
  }));
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
  const t0 = Date.now();
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
        recordUsage({ ts: Date.now(), id, mode: 'cli', model, stream: false, ok: false, status,
          input_tokens: estimateTokens(prompt), output_tokens: null, credits: null, ttft_ms: null, duration_ms: Date.now() - t0 });
        return sendJson(res, status, errorPayload(msg, status === 400 ? 'model_not_found' : 'bridge_upstream_error'));
      }
      const usage = { prompt_tokens: estimateTokens(prompt), completion_tokens: estimateTokens(content), total_tokens: estimateTokens(prompt) + estimateTokens(content) };
      recordUsage({ ts: Date.now(), id, mode: 'cli', model, stream: false, ok: true, status: 200,
        input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens,
        credits: null, ttft_ms: null, duration_ms: Date.now() - t0 });
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
    recordUsage({ ts: Date.now(), id, mode: 'cli', model, stream: true, ok: true, status: 200,
      input_tokens: estimateTokens(prompt), output_tokens: null, credits: null, ttft_ms: null, duration_ms: Date.now() - t0 });
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
    if (req.method === 'GET' && url.pathname === '/v1/quota') {
      if (!authorized(req)) return sendJson(res, 401, errorPayload('unauthorized', 'auth_error'));
      const q = await getQuota();
      if (!q) return sendJson(res, 503, errorPayload('quota unavailable (no valid GitHub token or upstream error)', 'auth_error'));
      return sendJson(res, 200, q);
    }
    if (req.method === 'GET' && url.pathname === '/v1/usage') {
      if (!authorized(req)) return sendJson(res, 401, errorPayload('unauthorized', 'auth_error'));
      return sendJson(res, 200, usageSummary(url.searchParams.get('range')));
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
