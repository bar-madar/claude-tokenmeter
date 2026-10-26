'use strict';

// Reads Claude Code session logs (<config dir>/projects/**/*.jsonl) and turns
// them into token statistics. Files are read incrementally: only the bytes
// appended since the previous scan are parsed, so refreshing stays cheap even
// with hundreds of megabytes of logs.
//
// Usage:
//   node scanner.js                     print a short report
//   node scanner.js --summary <session> print the pane's JSON digest

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(CONFIG_DIR, 'projects');
const HISTORY_DAYS = 90;
const SPARK_DAYS = 14;
const PEAK_HOURS_DAYS = 30;
const DAY_MS = 86_400_000;

// ---------- reading ----------

function listJsonl(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function newFileState() {
  return { offset: 0, msgs: new Map(), sessions: new Map() };
}

function sessionOf(state, id) {
  let s = state.sessions.get(id);
  if (!s) {
    s = {
      id, cwd: null, aiTitle: null, customTitle: null, agentName: null,
      entrypoints: {}, firstTs: null, lastTs: null, prompts: 0, activeMs: 0, prs: new Set(),
    };
    state.sessions.set(id, s);
  }
  return s;
}

function touch(s, ts) {
  if (!ts) return;
  if (!s.firstTs || ts < s.firstTs) s.firstTs = ts;
  if (!s.lastTs || ts > s.lastTs) s.lastTs = ts;
}

// A prompt the person typed, as opposed to tool results, slash-command output
// and other user-role rows the log also records.
function isPrompt(content) {
  if (typeof content === 'string') {
    return !/^\s*<(local-command|command-name|command-message|bash-|task-notification)/.test(content);
  }
  if (Array.isArray(content)) {
    return content.some(b => b && (b.type === 'text' || b.type === 'image'))
      && !content.some(b => b && b.type === 'tool_result');
  }
  return false;
}

function handleRecord(state, d) {
  const sid = d.sessionId;
  const s = sid ? sessionOf(state, sid) : null;
  if (s) {
    if (d.cwd) s.cwd = d.cwd;
    if (d.entrypoint) s.entrypoints[d.entrypoint] = (s.entrypoints[d.entrypoint] || 0) + 1;
  }

  switch (d.type) {
    case 'assistant': {
      const m = d.message;
      if (!m || !m.usage) return;
      if (s && !d.isSidechain) touch(s, d.timestamp);
      const key = (m.id || d.uuid) + '|' + (d.requestId || '');
      let e = state.msgs.get(key);
      if (!e) {
        e = {
          ts: d.timestamp, sid, model: m.model || 'unknown', cwd: d.cwd || null,
          sidechain: !!d.isSidechain, tools: new Map(),
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0,
          thinking: 0, webSearch: 0, webFetch: 0,
        };
        state.msgs.set(key, e);
      }
      // Claude Code logs one line per content block of a response, each
      // carrying the same usage. Keep the largest value seen so the repeats
      // never add up (summing every line overcounts about threefold).
      const u = m.usage;
      const cc = u.cache_creation || {};
      const stu = u.server_tool_use || {};
      e.input = Math.max(e.input, u.input_tokens || 0);
      e.output = Math.max(e.output, u.output_tokens || 0);
      e.cacheRead = Math.max(e.cacheRead, u.cache_read_input_tokens || 0);
      e.cacheWrite = Math.max(e.cacheWrite, u.cache_creation_input_tokens || 0);
      e.cacheWrite5m = Math.max(e.cacheWrite5m, cc.ephemeral_5m_input_tokens || 0);
      e.cacheWrite1h = Math.max(e.cacheWrite1h, cc.ephemeral_1h_input_tokens || 0);
      e.thinking = Math.max(e.thinking, (u.output_tokens_details || {}).thinking_tokens || 0);
      e.webSearch = Math.max(e.webSearch, stu.web_search_requests || 0);
      e.webFetch = Math.max(e.webFetch, stu.web_fetch_requests || 0);
      for (const b of m.content || []) {
        if (b && b.type === 'tool_use') e.tools.set(b.id, b.name);
      }
      return;
    }
    case 'user':
      if (!s || d.isMeta || d.isSidechain) return;
      touch(s, d.timestamp);
      if (isPrompt(d.message && d.message.content)) s.prompts++;
      return;
    case 'ai-title':
      if (s) s.aiTitle = d.aiTitle;
      return;
    case 'custom-title':
      if (s) s.customTitle = d.customTitle;
      return;
    case 'agent-name':
      if (s) s.agentName = d.agentName;
      return;
    case 'system':
      if (s && d.subtype === 'turn_duration' && d.durationMs) s.activeMs += d.durationMs;
      return;
    case 'pr-link':
      if (s && d.prUrl) s.prs.add(d.prUrl);
      return;
  }
}

function readFile(cache, file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    cache.delete(file);
    return null;
  }
  let state = cache.get(file);
  if (!state || size < state.offset) {
    // New, or rewritten shorter than before: start over.
    state = newFileState();
    cache.set(file, state);
  }
  if (size === state.offset) return state;

  const fd = fs.openSync(file, 'r');
  try {
    const len = size - state.offset;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, state.offset);
    // Only consume complete lines; a half-written last line is read next time.
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return state;
    state.offset += end + 1;
    for (const line of buf.toString('utf8', 0, end).split('\n')) {
      if (line.charCodeAt(0) !== 123 /* { */) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      handleRecord(state, d);
    }
  } finally {
    fs.closeSync(fd);
  }
  return state;
}

// ---------- aggregation ----------

function localDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The last `count` calendar days ending today, oldest first. Steps by calendar
// day rather than by 24 hours so daylight-saving changes never skip or repeat one.
function lastDays(now, count) {
  const days = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - (count - 1));
  for (let i = 0; i < count; i++) {
    days.push(localDate(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function zero() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0,
    thinking: 0, calls: 0, toolCalls: 0, webSearch: 0, webFetch: 0,
  };
}

function add(t, e) {
  t.input += e.input;
  t.output += e.output;
  t.cacheRead += e.cacheRead;
  t.cacheWrite += e.cacheWrite;
  t.cacheWrite5m += e.cacheWrite5m;
  t.cacheWrite1h += e.cacheWrite1h;
  t.thinking += e.thinking;
  t.webSearch += e.webSearch;
  t.webFetch += e.webFetch;
  t.toolCalls += e.tools.size;
  t.calls++;
}

function finish(t) {
  t.all = t.input + t.output + t.cacheRead + t.cacheWrite;
  t.io = t.input + t.output;
  const inputSide = t.input + t.cacheRead + t.cacheWrite;
  t.cacheHitRate = inputSide ? t.cacheRead / inputSide : 0;
  return t;
}

function projectName(cwd) {
  if (!cwd) return 'Unknown';
  const base = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
  // The desktop app runs folder-less sessions in throwaway "scratch" workspaces.
  const scratch = /scratch-workspaces/i.test(cwd) && base.match(/^scratch-(\d{4}-\d{2}-\d{2})-?(\w*)/);
  return scratch ? `No folder (${scratch[1]}${scratch[2] ? ' · ' + scratch[2] : ''})` : base;
}

function mergeSessions(into, s) {
  const t = into.get(s.id);
  if (!t) {
    into.set(s.id, { ...s, entrypoints: { ...s.entrypoints }, prs: new Set(s.prs) });
    return;
  }
  t.cwd = t.cwd || s.cwd;
  t.aiTitle = s.aiTitle || t.aiTitle;
  t.customTitle = s.customTitle || t.customTitle;
  t.agentName = s.agentName || t.agentName;
  t.prompts += s.prompts;
  t.activeMs += s.activeMs;
  for (const [k, v] of Object.entries(s.entrypoints)) t.entrypoints[k] = (t.entrypoints[k] || 0) + v;
  for (const p of s.prs) t.prs.add(p);
  if (s.firstTs && (!t.firstTs || s.firstTs < t.firstTs)) t.firstTs = s.firstTs;
  if (s.lastTs && (!t.lastTs || s.lastTs > t.lastTs)) t.lastTs = s.lastTs;
}

function aggregate(msgs, sessions, now) {
  const today = localDate(now);
  const days = lastDays(now, HISTORY_DAYS);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const sparkFrom = HISTORY_DAYS - SPARK_DAYS;

  const totals = zero();
  const todayT = zero();
  const daily = days.map(date => ({ date, ...zero() }));
  const hours = Array.from({ length: 24 }, () => zero());
  const byModel = new Map();
  const byProject = new Map();
  const bySession = new Map();
  const tools = new Map();
  let errors = 0;
  let firstTs = null;

  for (const e of msgs.values()) {
    if (e.model === '<synthetic>') {
      // Placeholder rows Claude Code writes for API errors; no tokens were used.
      errors++;
      continue;
    }
    if (!firstTs || e.ts < firstTs) firstTs = e.ts;
    const date = localDate(e.ts);
    const s = sessions.get(e.sid);
    const cwd = (s && s.cwd) || e.cwd;

    add(totals, e);
    if (date === today) add(todayT, e);
    const di = dayIndex.get(date);
    if (di !== undefined) add(daily[di], e);
    if (now - Date.parse(e.ts) <= PEAK_HOURS_DAYS * DAY_MS) add(hours[new Date(e.ts).getHours()], e);

    if (!byModel.has(e.model)) byModel.set(e.model, { model: e.model, ...zero() });
    add(byModel.get(e.model), e);

    const pk = (cwd || 'unknown').toLowerCase();
    if (!byProject.has(pk)) {
      byProject.set(pk, {
        key: pk, path: cwd, name: projectName(cwd), sessionIds: new Set(), lastTs: null,
        spark: new Array(SPARK_DAYS).fill(0), ...zero(),
      });
    }
    const p = byProject.get(pk);
    add(p, e);
    p.sessionIds.add(e.sid);
    if (!p.lastTs || e.ts > p.lastTs) p.lastTs = e.ts;
    if (di !== undefined && di >= sparkFrom) {
      p.spark[di - sparkFrom] += e.input + e.output + e.cacheRead + e.cacheWrite;
    }

    if (!bySession.has(e.sid)) bySession.set(e.sid, { modelCounts: {}, ...zero() });
    const bs = bySession.get(e.sid);
    add(bs, e);
    bs.modelCounts[e.model] = (bs.modelCounts[e.model] || 0) + 1;

    for (const name of e.tools.values()) tools.set(name, (tools.get(name) || 0) + 1);
  }

  for (const d of daily) finish(d);
  for (const h of hours) finish(h);
  finish(totals);
  finish(todayT);

  const sessionList = [];
  let prompts = 0;
  let activeMs = 0;
  for (const [id, { modelCounts, ...t }] of bySession) {
    const s = sessions.get(id) || { id, entrypoints: {}, prs: new Set(), prompts: 0, activeMs: 0 };
    prompts += s.prompts;
    activeMs += s.activeMs;
    const entry = Object.entries(s.entrypoints).sort((a, b) => b[1] - a[1])[0];
    sessionList.push({
      id,
      title: s.customTitle || s.aiTitle || s.agentName || null,
      project: projectName(s.cwd),
      path: s.cwd || null,
      entrypoint: entry ? entry[0] : null,
      models: Object.keys(modelCounts).sort((a, b) => modelCounts[b] - modelCounts[a]),
      firstTs: s.firstTs,
      lastTs: s.lastTs,
      prompts: s.prompts,
      activeMs: s.activeMs,
      prs: [...s.prs],
      ...finish(t),
    });
  }
  sessionList.sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
  todayT.sessions = sessionList.filter(s => s.lastTs && localDate(s.lastTs) === today).length;

  totals.sessions = sessionList.length;
  totals.prompts = prompts;
  totals.activeMs = activeMs;
  totals.errors = errors;
  totals.firstTs = firstTs;

  // 30-day projection from the average of the last 7 days, today included.
  const avg7 = { all: 0, io: 0 };
  for (const d of daily.slice(-7)) {
    avg7.all += d.all / 7;
    avg7.io += d.io / 7;
  }

  const projects = [...byProject.values()]
    .map(({ sessionIds, ...rest }) => ({ ...finish(rest), sessions: sessionIds.size }))
    .sort((a, b) => b.all - a.all);

  return {
    generatedAt: new Date(now).toISOString(),
    totals,
    today: todayT,
    avg7: { all: Math.round(avg7.all), io: Math.round(avg7.io) },
    projection30: { all: Math.round(avg7.all * 30), io: Math.round(avg7.io * 30) },
    daily,
    hours,
    models: [...byModel.values()].map(finish).sort((a, b) => b.all - a.all),
    projects,
    sessions: sessionList,
    tools: [...tools.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  };
}

const DIET_FILE = path.join(CONFIG_DIR, 'tokendiet', 'audits.json');
const pathKey = p => (p || '').replace(/\\/g, '/').toLowerCase();

// Audit summaries the TokenDiet skill leaves behind: how many tokens of
// instructions each agent loads per request, and how much can go.
function readDiet(file = DIET_FILE) {
  try {
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (store.version !== 1 || !store.audits) return [];
    return Object.values(store.audits)
      .filter(a => a && a.project && Array.isArray(a.agents))
      .map(a => ({ ...a, name: projectName(a.project) }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  } catch {
    return [];
  }
}

/**
 * A scanner over one projects folder. It remembers how far it has read each
 * file, so calling scan() again only parses what was appended since.
 */
function createScanner(root = PROJECTS_DIR, { dietFile = DIET_FILE } = {}) {
  const cache = new Map();

  function scan({ now = Date.now() } = {}) {
    const files = listJsonl(root);
    const seen = new Set(files);
    for (const f of cache.keys()) if (!seen.has(f)) cache.delete(f);

    const msgs = new Map();
    const sessions = new Map();
    for (const f of files) {
      const st = readFile(cache, f);
      if (!st) continue;
      for (const [k, e] of st.msgs) msgs.set(k, e);
      for (const s of st.sessions.values()) mergeSessions(sessions, s);
    }
    const result = aggregate(msgs, sessions, now);
    const diet = readDiet(dietFile);
    const byPath = new Map(diet.map(a => [pathKey(a.project), a]));
    for (const p of result.projects) p.diet = byPath.get(pathKey(p.path)) || null;
    for (const s of result.sessions) s.diet = byPath.get(pathKey(s.path)) || null;
    return { root, files: files.length, ...result, diet };
  }

  return { root, scan };
}

// The small digest the in-session pane draws.
function summarize(r, sessionId) {
  const pick = t => ({
    all: t.all, io: t.io, input: t.input, output: t.output, cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite, thinking: t.thinking, calls: t.calls, toolCalls: t.toolCalls,
    cacheHitRate: t.cacheHitRate,
  });
  const s = r.sessions.find(x => x.id === sessionId);
  return {
    generatedAt: r.generatedAt,
    session: s ? { id: s.id, title: s.title, prompts: s.prompts, ...pick(s) } : null,
    today: { ...pick(r.today), sessions: r.today.sessions },
    week: r.daily.slice(-7).map(d => ({ date: d.date, all: d.all, io: d.io })),
    totals: { ...pick(r.totals), sessions: r.totals.sessions },
    avg7: r.avg7,
    projection30: r.projection30,
    topProjects: r.projects.slice(0, 3).map(p => ({ name: p.name, all: p.all })),
    diet: s && s.diet ? dietDigest(s.diet) : null,
  };
}

// What the pane shows from a TokenDiet audit: Claude Code's numbers when
// present, otherwise the heaviest agent's.
function dietDigest(a) {
  const agent = a.agents.find(x => x.name === 'Claude Code') || [...a.agents].sort((x, y) => y.perRequest - x.perRequest)[0];
  return agent ? { at: a.at, agent: agent.name, perRequest: agent.perRequest, saves: agent.saves, findings: a.findings } : null;
}

const defaultScanner = createScanner();

module.exports = {
  CONFIG_DIR,
  PROJECTS_DIR,
  DIET_FILE,
  createScanner,
  readDiet,
  scan: options => defaultScanner.scan(options),
  summarize,
  lastDays,
  projectName,
};

if (require.main === module) {
  const i = process.argv.indexOf('--summary');
  if (i >= 0) {
    process.stdout.write(JSON.stringify(summarize(defaultScanner.scan(), process.argv[i + 1])));
  } else {
    const t0 = Date.now();
    const r = defaultScanner.scan();
    const f = n => n.toLocaleString();
    console.log(`Read ${r.files} log files in ${Date.now() - t0} ms from ${r.root}`);
    console.log(`Sessions      ${f(r.totals.sessions)}`);
    console.log(`All tokens    ${f(r.totals.all)}`);
    console.log(`  input       ${f(r.totals.input)}`);
    console.log(`  output      ${f(r.totals.output)}`);
    console.log(`  cache read  ${f(r.totals.cacheRead)}`);
    console.log(`  cache write ${f(r.totals.cacheWrite)}`);
    console.log(`Today         ${f(r.today.all)}`);
  }
}
