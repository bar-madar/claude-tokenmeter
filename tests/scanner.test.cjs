'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createScanner, summarize, lastDays, projectName } = require('../scanner');
const { writeDemoData } = require('../scripts/demo-data');

const NOW = new Date(2026, 9, 19, 15, 0, 0).getTime(); // Oct 19 2026, 15:00 local

function tempProjects() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenmeter-test-'));
  const projects = path.join(dir, 'projects', '-code-app');
  fs.mkdirSync(projects, { recursive: true });
  return { root: path.join(dir, 'projects'), file: path.join(projects, 'session.jsonl') };
}

const at = (h, m = 0) => new Date(2026, 9, 19, h, m).toISOString();
const base = { sessionId: 's1', cwd: '/code/app', entrypoint: 'cli' };

function response(id, usage, content, ts = at(10)) {
  return { ...base, type: 'assistant', timestamp: ts, requestId: `req_${id}`, message: { id: `msg_${id}`, model: 'claude-opus-5-5', usage, content } };
}

const USAGE = {
  input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000,
  output_tokens_details: { thinking_tokens: 50 },
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
};

const lines = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

test('counts a response once although it is logged once per content block', () => {
  const { root, file } = tempProjects();
  fs.writeFileSync(file, lines([
    response('a', USAGE, [{ type: 'thinking', thinking: '…' }]),
    response('a', USAGE, [{ type: 'text', text: 'hi' }]),
    response('a', USAGE, [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
  ]));
  const r = createScanner(root).scan({ now: NOW });
  assert.equal(r.totals.calls, 1);
  assert.equal(r.totals.input, 10);
  assert.equal(r.totals.output, 200);
  assert.equal(r.totals.cacheRead, 5000);
  assert.equal(r.totals.cacheWrite, 1000);
  assert.equal(r.totals.cacheWrite1h, 1000);
  assert.equal(r.totals.thinking, 50);
  assert.equal(r.totals.all, 6210);
  assert.equal(r.totals.io, 210);
  assert.equal(r.totals.toolCalls, 1);
  assert.deepEqual(r.tools, [{ name: 'Bash', count: 1 }]);
  assert.equal(r.today.all, 6210);
});

test('treats API error placeholders as errors, not usage', () => {
  const { root, file } = tempProjects();
  const err = response('e', { input_tokens: 0, output_tokens: 0 }, []);
  err.message.model = '<synthetic>';
  fs.writeFileSync(file, lines([response('a', USAGE, []), err]));
  const r = createScanner(root).scan({ now: NOW });
  assert.equal(r.totals.calls, 1);
  assert.equal(r.totals.errors, 1);
  assert.deepEqual(r.models.map(m => m.model), ['claude-opus-5-5']);
});

test('counts typed prompts but not tool results, meta rows or command output', () => {
  const { root, file } = tempProjects();
  const user = content => ({ ...base, type: 'user', timestamp: at(9), message: { role: 'user', content } });
  fs.writeFileSync(file, lines([
    user('Fix the login bug'),
    user([{ type: 'text', text: 'And add a test' }]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    user('<command-name>/clear</command-name>'),
    { ...user('caveat'), isMeta: true },
    response('a', USAGE, []),
  ]));
  const r = createScanner(root).scan({ now: NOW });
  assert.equal(r.totals.prompts, 2);
  assert.equal(r.sessions[0].prompts, 2);
});

test('names sessions by custom title, then AI title', () => {
  const { root, file } = tempProjects();
  fs.writeFileSync(file, lines([
    { type: 'ai-title', aiTitle: 'Generated title', sessionId: 's1' },
    response('a', USAGE, []),
  ]));
  const scanner = createScanner(root);
  assert.equal(scanner.scan({ now: NOW }).sessions[0].title, 'Generated title');
  fs.appendFileSync(file, lines([{ type: 'custom-title', customTitle: 'My title', sessionId: 's1' }]));
  assert.equal(scanner.scan({ now: NOW }).sessions[0].title, 'My title');
});

test('reads appended lines on the next scan and waits for a half-written line', () => {
  const { root, file } = tempProjects();
  fs.writeFileSync(file, lines([response('a', USAGE, [])]));
  const scanner = createScanner(root);
  assert.equal(scanner.scan({ now: NOW }).totals.calls, 1);

  const next = JSON.stringify(response('b', USAGE, [], at(11)));
  fs.appendFileSync(file, next.slice(0, 40));
  assert.equal(scanner.scan({ now: NOW }).totals.calls, 1);
  fs.appendFileSync(file, next.slice(40) + '\n');
  assert.equal(scanner.scan({ now: NOW }).totals.calls, 2);
});

test('builds the daily, hourly, project and session breakdowns', () => {
  const { root, file } = tempProjects();
  fs.writeFileSync(file, lines([
    response('a', USAGE, [], at(10)),
    response('b', USAGE, [], new Date(2026, 9, 18, 14).toISOString()),
    { ...base, type: 'system', subtype: 'turn_duration', durationMs: 90_000, timestamp: at(10) },
  ]));
  const r = createScanner(root).scan({ now: NOW });
  assert.equal(r.daily.length, 90);
  assert.equal(r.daily.at(-1).date, '2026-10-19');
  assert.equal(r.daily.at(-1).calls, 1);
  assert.equal(r.daily.at(-2).calls, 1);
  assert.equal(r.hours[10].calls, 1);
  assert.equal(r.hours[14].calls, 1);
  assert.equal(r.projects[0].name, 'app');
  assert.equal(r.projects[0].sessions, 1);
  assert.equal(r.projects[0].spark.length, 14);
  assert.equal(r.sessions[0].activeMs, 90_000);
  assert.equal(r.sessions[0].entrypoint, 'cli');
  assert.equal(r.avg7.all, Math.round((6210 * 2) / 7));
  assert.equal(r.projection30.all, Math.round(((6210 * 2) / 7) * 30));
});

test('attaches TokenDiet audits to matching projects and sessions', () => {
  const { root, file } = tempProjects();
  fs.writeFileSync(file, lines([response('a', USAGE, [])]));
  const dietFile = path.join(path.dirname(root), 'tokendiet', 'audits.json');
  fs.mkdirSync(path.dirname(dietFile), { recursive: true });
  fs.writeFileSync(dietFile, JSON.stringify({
    version: 1,
    audits: {
      '/code/app': { project: '/code/app', at: at(9), agents: [{ name: 'Cursor', perRequest: 900, saves: 100 }, { name: 'Claude Code', perRequest: 2000, saves: 1500 }], findings: 4, top: [] },
      '/code/other': { project: '/code/other', at: at(8), agents: [{ name: 'Codex', perRequest: 300, saves: 0 }], findings: 0, top: [] },
    },
  }));
  const r = createScanner(root, { dietFile }).scan({ now: NOW });
  assert.equal(r.diet.length, 2, 'audits of projects without Claude Code logs are listed too');
  assert.equal(r.diet[0].name, 'app');
  assert.equal(r.projects[0].diet.findings, 4);
  const s = summarize(r, 's1');
  assert.deepEqual(s.diet, { at: at(9), agent: 'Claude Code', perRequest: 2000, saves: 1500, findings: 4 });

  fs.writeFileSync(dietFile, '{ not json');
  assert.deepEqual(createScanner(root, { dietFile }).scan({ now: NOW }).diet, [], 'a broken file is ignored');
});

test('summarize picks the requested session', () => {
  const { root, file } = tempProjects();
  fs.writeFileSync(file, lines([response('a', USAGE, [])]));
  const s = summarize(createScanner(root).scan({ now: NOW }), 's1');
  assert.equal(s.session.id, 's1');
  assert.equal(s.session.all, 6210);
  assert.equal(s.week.length, 7);
  assert.equal(s.topProjects[0].name, 'app');
  assert.equal(summarize(createScanner(root).scan({ now: NOW }), 'nope').session, null);
});

test('lastDays steps by calendar day', () => {
  const days = lastDays(NOW, 90);
  assert.equal(days.length, 90);
  assert.equal(new Set(days).size, 90);
  assert.equal(days.at(-1), '2026-10-19');
  assert.equal(days[0], '2026-07-22');
});

test('projectName shortens paths and names folder-less sessions', () => {
  assert.equal(projectName('C:\\code\\acme-web'), 'acme-web');
  assert.equal(projectName('/home/me/acme-web/'), 'acme-web');
  assert.equal(projectName('C:\\Users\\me\\AppData\\Roaming\\Claude\\scratch-workspaces\\x\\y\\scratch-2026-10-19-a1b2c3'), 'No folder (2026-10-19 · a1b2c3)');
  assert.equal(projectName(null), 'Unknown');
});

test('demo data scans into a realistic dashboard and never overwrites real data', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenmeter-demo-')), 'claude');
  const { sessions } = writeDemoData(dir, { now: NOW });
  const r = createScanner(path.join(dir, 'projects')).scan({ now: NOW });
  assert.equal(r.totals.sessions, sessions);
  assert.ok(r.totals.all > 1_000_000);
  assert.ok(r.today.calls > 0);
  assert.ok(r.projects.length >= 3);
  // Same seed, same data.
  writeDemoData(dir, { now: NOW });
  assert.equal(createScanner(path.join(dir, 'projects')).scan({ now: NOW }).totals.all, r.totals.all);

  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenmeter-real-'));
  assert.throws(() => writeDemoData(real, { now: NOW }), /Refusing/);
});
