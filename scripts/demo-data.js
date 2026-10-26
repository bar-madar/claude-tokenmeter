'use strict';

// Writes realistic, made-up Claude Code session logs: for trying the dashboard
// without data of your own, for the README screenshots, and for the tests.
// Deterministic: the same `seed` and `now` always write the same logs.

const fs = require('fs');
const path = require('path');

const MARKER = '.tokenmeter-demo';
const MINUTE = 60_000;
const DAY = 86_400_000;

const PROJECTS = [
  { dir: 'acme-web', weight: 6, titles: ['Add OAuth login flow', 'Fix flaky checkout test', 'Dark mode for settings page', 'Speed up product search', 'Upgrade to React 19'] },
  { dir: 'payments-api', weight: 5, titles: ['Refactor billing service', 'Add idempotency keys', 'Investigate webhook retries', 'Write migration for invoices'] },
  { dir: 'ml-pipeline', weight: 3, titles: ['Debug memory leak in worker', 'Parallelize feature extraction', 'Add model eval report'] },
  { dir: 'infra', weight: 2, titles: ['Set up CI pipeline', 'Terraform for staging', 'Speed up Docker builds'] },
  { dir: 'docs-site', weight: 1, titles: ['Write API reference', 'Fix broken links'] },
];
const MODELS = [['claude-opus-5-5', 0.7], ['claude-sonnet-5-5', 0.25], ['claude-haiku-5-5', 0.05]];
const ENTRYPOINTS = [['cli', 0.5], ['claude-desktop', 0.35], ['claude-vscode', 0.15]];
const TOOLS = [['Bash', 0.3], ['Read', 0.22], ['Edit', 0.2], ['Grep', 0.1], ['Write', 0.08], ['Glob', 0.05], ['WebFetch', 0.03], ['WebSearch', 0.02]];
const PROMPTS = ['Can you take a look at this?', 'Run the tests again', 'Looks good, now update the docs', 'Why is this failing?', 'Commit that'];

// mulberry32: a tiny seeded PRNG.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Writes demo logs under `<configDir>/projects` and a plan-limit reading at
 * `<configDir>/tokenmeter-live.json`. Refuses a folder it did not create, so
 * it can never touch real Claude Code data.
 */
function writeDemoData(configDir, { now = Date.now(), seed = 7, days = 75 } = {}) {
  if (fs.existsSync(configDir) && !fs.existsSync(path.join(configDir, MARKER))) {
    throw new Error(`Refusing to write demo data into ${configDir}: it was not created by this script.`);
  }
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, MARKER), 'Demo data written by claude-tokenmeter. Safe to delete.\n');

  const rand = rng(seed);
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const int = (lo, hi) => Math.floor(between(lo, hi + 1));
  const weighted = list => {
    let r = rand() * list.reduce((a, [, w]) => a + w, 0);
    for (const [v, w] of list) if ((r -= w) <= 0) return v;
    return list[list.length - 1][0];
  };
  const project = () => weighted(PROJECTS.map(p => [p, p.weight]));

  let sessionNo = 0;
  let last = { title: '', model: '' };
  const sessionsToWrite = [];
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  for (let ago = days; ago >= 1; ago--) {
    const day = new Date(startOfToday);
    day.setDate(day.getDate() - ago);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    // Busier in recent weeks, quieter at weekends.
    const busy = (weekend ? 0.2 : 0.7) * (0.55 + 0.45 * (1 - ago / days));
    if (rand() > busy) continue;
    for (let n = int(1, 3); n > 0; n--) {
      const hour = weighted([[9, 2], [10, 3], [11, 3], [13, 2], [14, 3], [15, 3], [16, 2], [20, 1], [21, 1]]);
      sessionsToWrite.push({ start: day.getTime() + hour * 3_600_000 + int(0, 50) * MINUTE });
    }
  }
  // Two sessions today, the last one still going.
  sessionsToWrite.push({ start: now - int(150, 240) * MINUTE, endBy: now - 75 * MINUTE });
  sessionsToWrite.push({ start: now - 40 * MINUTE, endBy: now - 2 * MINUTE });

  for (const plan of sessionsToWrite) {
    const p = project();
    const id = `00000000-demo-4000-8000-${String(++sessionNo).padStart(12, '0')}`;
    const cwd = `/Users/dev/code/${p.dir}`;
    const entrypoint = weighted(ENTRYPOINTS);
    const model = weighted(MODELS);
    const lines = [];
    const base = { sessionId: id, cwd, entrypoint, version: '2.1.0', gitBranch: 'main', isSidechain: false };
    let t = plan.start;
    const stamp = () => new Date(t).toISOString();

    const title = p.titles[int(0, p.titles.length - 1)];
    last = { title, model };
    lines.push({ type: 'ai-title', aiTitle: title, sessionId: id });
    let responses = int(15, 110);
    if (plan.endBy) responses = Math.max(4, Math.min(responses, Math.floor((plan.endBy - plan.start) / (45 * 1000))));
    let context = int(14_000, 22_000);
    let turnStart = t;

    for (let k = 0; k < responses; k++) {
      if (k === 0 || rand() < 0.1) {
        if (k > 0) lines.push({ ...base, type: 'system', subtype: 'turn_duration', durationMs: t - turnStart, timestamp: stamp() });
        lines.push({ ...base, type: 'user', timestamp: stamp(), message: { role: 'user', content: PROMPTS[int(0, PROMPTS.length - 1)] } });
        turnStart = t;
      }
      t += int(15, 80) * 1000;
      if (plan.endBy && t > plan.endBy) t = plan.endBy;

      if (rand() < 0.004) {
        lines.push({ ...base, type: 'assistant', timestamp: stamp(), requestId: `req_demo_${sessionNo}_${k}_err`, message: { id: `msg_demo_${sessionNo}_${k}_err`, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error' }], usage: { input_tokens: 0, output_tokens: 0 } } });
        continue;
      }

      const tool = weighted(TOOLS);
      const write = rand() < 0.15 ? int(8_000, 30_000) : int(400, 4_000);
      const output = int(120, 2_800);
      const usage = {
        input_tokens: int(1, 9),
        cache_creation_input_tokens: write,
        cache_read_input_tokens: context,
        output_tokens: output,
        output_tokens_details: { thinking_tokens: Math.floor(output * between(0, 0.6)) },
        server_tool_use: { web_search_requests: tool === 'WebSearch' ? 1 : 0, web_fetch_requests: 0 },
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
      };
      context += write;
      if (context > 180_000) context = int(30_000, 45_000); // compacted
      const message = { id: `msg_demo_${sessionNo}_${k}`, model, role: 'assistant', usage };
      const reqId = `req_demo_${sessionNo}_${k}`;
      // Like Claude Code, one line per content block, each repeating the usage.
      lines.push({ ...base, type: 'assistant', timestamp: stamp(), requestId: reqId, message: { ...message, content: [{ type: 'thinking', thinking: '…' }] } });
      lines.push({ ...base, type: 'assistant', timestamp: stamp(), requestId: reqId, message: { ...message, content: [{ type: 'tool_use', id: `toolu_demo_${sessionNo}_${k}`, name: tool, input: {} }] } });
      lines.push({ ...base, type: 'user', timestamp: stamp(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_demo_${sessionNo}_${k}`, content: 'ok' }] } });
    }
    lines.push({ ...base, type: 'system', subtype: 'turn_duration', durationMs: t - turnStart, timestamp: stamp() });

    const dir = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  }

  fs.writeFileSync(path.join(configDir, 'tokenmeter-live.json'), JSON.stringify({
    at: new Date(now - MINUTE).toISOString(),
    sessionId: `00000000-demo-4000-8000-${String(sessionNo).padStart(12, '0')}`,
    title: last.title,
    model: last.model,
    context: { tokens: 83_000, window: 200_000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 37.5, resetsAt: new Date(now + 2 * 3_600_000 + 14 * MINUTE).toISOString() },
      { kind: 'seven_day', percentUsed: 18, resetsAt: new Date(now + 4 * DAY + 6 * 3_600_000).toISOString() },
    ],
  }));

  // What the TokenDiet skill leaves behind after auditing two of the projects.
  const audit = (dir, daysAgo, agents, top) => ({
    project: `/Users/dev/code/${dir}`,
    at: new Date(now - daysAgo * DAY).toISOString(),
    agents,
    findings: top.length,
    top: top.slice(0, 3),
  });
  const audits = [
    audit('acme-web', 2, [
      { name: 'Claude Code', perRequest: 2865, saves: 2456 },
      { name: 'Cursor', perRequest: 631, saves: 398 },
    ], [
      { title: '"Release process" in CLAUDE.md (lines 20-39) loads on every request', saves: 1142 },
      { title: '32-line code sample in CLAUDE.md (lines 55-86)', saves: 799 },
      { title: '"Changelog" in CLAUDE.md (lines 40-52) loads on every request', saves: 417 },
    ]),
    audit('payments-api', 5, [{ name: 'Claude Code', perRequest: 1240, saves: 0 }], []),
  ];
  fs.mkdirSync(path.join(configDir, 'tokendiet'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'tokendiet', 'audits.json'), JSON.stringify({
    version: 1,
    audits: Object.fromEntries(audits.map(a => [a.project.toLowerCase(), a])),
  }));

  return { configDir, sessions: sessionNo };
}

module.exports = { writeDemoData };
