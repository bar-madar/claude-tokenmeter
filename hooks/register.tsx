import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Live, Summary } from '../types'

const PANE = 'tokens'
const DEFAULT_PORT = '4545'
const REFRESH_MS = 60_000
const ACCENT = '#e8650a'

const summary = atom({ plugin: 'tokenmeter', key: 'summary' } as const, null)
const live = atom({ plugin: 'tokenmeter', key: 'live' } as const, null)
const problem = atom({ plugin: 'tokenmeter', key: 'problem' } as const, null)

// ---------- formatting ----------

export function fmt(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

export function meter(percent: number, width = 16): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function spark(values: number[]): string {
  const ticks = '▁▂▃▄▅▆▇█'
  const max = Math.max(...values, 1)
  return values.map(v => (v <= 0 ? '·' : ticks[Math.min(7, Math.floor((v / max) * 7.999))])).join(' ')
}

export function resetsIn(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (ms <= 0) return 'resets now'
  const h = Math.floor(ms / 3_600_000)
  if (h >= 24) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`
  return `resets in ${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
}

const LIMIT_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', spend_limit: 'Spend' }

// ---------- data ----------

let isRefreshing = false

async function dashboardUrl($: EngineInterface): Promise<string> {
  return `http://127.0.0.1:${(await $.env.get('TOKENMETER_PORT')) ?? DEFAULT_PORT}`
}

// Asks the dashboard when it runs (it keeps an incremental cache), else runs
// the scanner shipped with this plugin.
async function loadSummary($: EngineInterface, sessionId: string): Promise<Summary> {
  try {
    const res = await $.http.fetch(`${await dashboardUrl($)}/api/summary?session=${encodeURIComponent(sessionId)}`)
    if (res.ok) return { ...JSON.parse(res.text), source: 'dashboard' }
  } catch {
    // The dashboard isn't running.
  }
  const run = await $.process.run(['node', `${$.plugin.root}/scanner.js`, '--summary', sessionId], { timeoutMs: 60_000 })
  if (run.exitCode !== 0) throw new Error(run.stderr.trim().split('\n').pop() || `node exited with ${run.exitCode}`)
  return { ...JSON.parse(run.stdout), source: 'scan' }
}

async function claudeConfigDir($: EngineInterface): Promise<string | undefined> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured) return configured
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? `${home}/.claude` : undefined
}

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const sessionId = await $.session.id()
    const [usage, model, now] = await Promise.all([$.session.usage(), $.session.model(), $.clock.now()])

    let next: Summary | null = null
    try {
      next = await loadSummary($, sessionId)
      await update($, problem, () => null)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      await update($, problem, () => `Couldn't read the session logs (${why}). Is Node.js installed and on your PATH?`)
    }
    if (next) await update($, summary, () => next)

    const reading: Live = {
      at: new Date(now).toISOString(),
      sessionId,
      title: next?.session?.title ?? null,
      model,
      context: { tokens: usage.context.tokens, window: usage.context.window, percent: usage.context.percent },
      rateLimits: usage.rateLimits,
    }
    await update($, live, () => reading)

    // Hand the readings the logs don't carry to the web dashboard.
    const dir = await claudeConfigDir($)
    if (dir) await $.fs.write(`${dir}/tokenmeter-live.json`, JSON.stringify(reading))
  } finally {
    isRefreshing = false
  }
}

async function openInBrowser($: EngineInterface, url: string): Promise<void> {
  if ((await $.env.get('OS')) === 'Windows_NT') {
    await $.process.run(['explorer.exe', url])
    return
  }
  try {
    const opened = await $.process.run(['open', url]) // macOS
    if (opened.exitCode === 0) return
  } catch {
    // not macOS
  }
  await $.process.run(['xdg-open', url]) // Linux
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'tokens', description: 'Show live token usage in a pane' })
    void $.ui.open({ id: PANE, title: 'Tokens' })
    void refresh($)
    $.clock.every(REFRESH_MS, () => refresh($))

    return started
  })

  on('command.run', { command: 'tokens' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Tokens' })
    await refresh($)

    return { text: 'Tokens pane opened.' }
  })

  // Fresh numbers after every reply.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void refresh($)

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, summary)
    const l = await read($, live)
    const issue = await read($, problem)
    const now = await $.clock.now()

    const heading = (label: string) => (
      <Text dimColor bold>
        {label}
      </Text>
    )
    const line = (label: string, value: string) => (
      <Box key={label} flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Text dimColor>{label}</Text>
        <Text tabular>{value}</Text>
      </Box>
    )
    const bar = (key: string, label: string, percent: number, note: string) => (
      <Box key={key} flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Text dimColor>{label}</Text>
          <Text tabular>{`${percent}%`}</Text>
        </Box>
        <Text mono color={percent >= 80 ? 'warning' : ACCENT}>
          {meter(percent)}
        </Text>
        {note ? <Text dimColor>{note}</Text> : null}
      </Box>
    )

    const cur = s?.session
    const ctx = l?.context
    const ctxPercent = ctx ? (ctx.percent ?? (ctx.tokens ? Math.round((ctx.tokens / ctx.window) * 100) : 0)) : 0

    return (
      <Box flexDirection="column" rowGap={1} paddingX={1}>
        {issue ? <Text color="error">{issue}</Text> : null}
        {!s && !issue ? <Text dimColor>Reading your session logs…</Text> : null}

        {cur ? (
          <Box flexDirection="column">
            {heading('THIS SESSION')}
            <Text bold color={ACCENT}>
              {`${fmt(cur.all)} tokens`}
            </Text>
            {line('Input / output', `${fmt(cur.input)} / ${fmt(cur.output)}`)}
            {line('Cache read / write', `${fmt(cur.cacheRead)} / ${fmt(cur.cacheWrite)}`)}
            {line('Thinking', fmt(cur.thinking))}
            {line('Responses · tools', `${cur.calls} · ${cur.toolCalls}`)}
            {line('Cache hit', `${Math.round(cur.cacheHitRate * 100)}%`)}
          </Box>
        ) : null}

        {l ? (
          <Box flexDirection="column" rowGap={1}>
            {heading('LIMITS & CONTEXT')}
            {ctx && ctx.window ? bar('ctx', 'Context window', ctxPercent, `${fmt(ctx.tokens ?? 0)} of ${fmt(ctx.window)}`) : null}
            {l.rateLimits.map(r =>
              bar(r.kind, `${LIMIT_NAMES[r.kind] ?? r.kind} limit`, r.percentUsed, resetsIn(r.resetsAt, now)),
            )}
            {l.rateLimits.length === 0 ? <Text dimColor>No plan-limit reading yet.</Text> : null}
          </Box>
        ) : null}

        {s ? (
          <Box flexDirection="column">
            {heading('TODAY')}
            <Text bold>{`${fmt(s.today.all)} tokens`}</Text>
            {line('In / out', `${fmt(s.today.input)} / ${fmt(s.today.output)}`)}
            {line('Sessions · responses', `${s.today.sessions} · ${s.today.calls}`)}
          </Box>
        ) : null}

        {s ? (
          <Box flexDirection="column">
            {heading('LAST 7 DAYS')}
            <Text mono color={ACCENT}>
              {spark(s.week.map(d => d.all))}
            </Text>
            {line('7-day average', `${fmt(s.avg7.all)}/day`)}
            {line('30-day projection', `~${fmt(s.projection30.all)}`)}
          </Box>
        ) : null}

        {s ? (
          <Box flexDirection="column">
            {heading('ALL TIME')}
            <Text bold>{`${fmt(s.totals.all)} tokens`}</Text>
            {line('In / out', `${fmt(s.totals.input)} / ${fmt(s.totals.output)}`)}
            {line('Sessions · cache hit', `${s.totals.sessions} · ${Math.round(s.totals.cacheHitRate * 100)}%`)}
            {s.topProjects.map(p => line(p.name, fmt(p.all)))}
          </Box>
        ) : null}

        <Box flexDirection="row" columnGap={2}>
          <Button key="refresh" hotkey="r" onPress={() => refresh($)}>
            Refresh
          </Button>
          {s?.source === 'dashboard' ? (
            <Button key="open" hotkey="o" onPress={async () => openInBrowser($, (await dashboardUrl($)).replace('127.0.0.1', 'localhost'))}>
              Open dashboard
            </Button>
          ) : null}
        </Box>
        {l ? <Text dimColor>{`Updated ${new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</Text> : null}
      </Box>
    )
  })
}
