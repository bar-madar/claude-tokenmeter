import { describe, expect, mock, test } from 'claude-code/testing'

import { fmt, meter, resetsIn, spark } from '../hooks/register'
import type { Summary } from '../types'

const NOW = Date.parse('2026-10-19T11:00:00.000Z')

const tokens = {
  all: 3_460_000, io: 53_000, input: 28, output: 52_972, cacheRead: 3_300_000,
  cacheWrite: 120_000, thinking: 20_000, calls: 30, toolCalls: 39, cacheHitRate: 0.96,
}

const sample: Omit<Summary, 'source'> = {
  generatedAt: '2026-10-19T11:00:00.000Z',
  session: { id: 's1', title: 'Add OAuth login flow', prompts: 1, ...tokens },
  today: { ...tokens, sessions: 2 },
  week: [0, 0, 0, 0, 0, 84_000_000, 3_400_000].map((all, i) => ({ date: `2026-10-1${i + 3}`, all, io: 0 })),
  totals: { ...tokens, all: 120_670_000, sessions: 12 },
  avg7: { all: 12_600_000, io: 90_000 },
  projection30: { all: 378_000_000, io: 2_700_000 },
  topProjects: [{ name: 'acme-web', all: 93_540_000 }],
}

const usage = {
  startedAt: 0,
  context: { tokens: 96_000, window: 200_000, percent: 48 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-19T13:00:00.000Z' }],
}

const paneProps = { title: 'Tokens', isFocused: false, bodyColumns: 40, placement: 'dock' } as const

describe('formatting', () => {
  test('fmt abbreviates like the dashboard', async () => {
    expect(fmt(950)).toBe('950')
    expect(fmt(380_000)).toBe('380.0K')
    expect(fmt(120_670_000)).toBe('120.67M')
    expect(fmt(2_500_000_000)).toBe('2.50B')
  })

  test('meter and spark draw text bars', async () => {
    expect(meter(50, 10)).toBe('█████░░░░░')
    expect(meter(140, 4)).toBe('████')
    expect(spark([0, 5, 10])).toBe('· ▄ █')
  })

  test('resetsIn counts down in hours or days', async () => {
    expect(resetsIn('2026-10-19T13:14:00.000Z', NOW)).toBe('resets in 2h 14m')
    expect(resetsIn('2026-10-23T17:00:00.000Z', NOW)).toBe('resets in 4d 6h')
    expect(resetsIn('2026-10-19T10:00:00.000Z', NOW)).toBe('resets now')
    expect(resetsIn(undefined, NOW)).toBe('')
  })
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`refresh fills the pane from the dashboard on ${surface}`, async ($, on) => {
    const urls: string[] = []
    const writes: { path: string; text: string }[] = []
    mock.clock(on, { now: NOW })
    mock.env(on, { USERPROFILE: 'C:/Users/me' })
    on('session.id', () => ({ value: 's1' }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({ value: usage }))
    on('http.fetch', ($, e) => {
      urls.push(e.url)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(sample) } }
    })
    on('fs.write', ($, e) => {
      writes.push({ path: e.path, text: e.text })
      return { value: undefined }
    })

    const ui = await $.ui.mount({ plugin: 'tokenmeter', surface, component: 'Pane', requestId: 'tokens', props: paneProps })
    expect(await ui.find({ text: /Reading your session logs/ })).toBeDefined()

    await ui.press({ key: 'refresh' })

    expect(urls[0]).toBe('http://127.0.0.1:4545/api/summary?session=s1')
    expect(await ui.find({ text: 'THIS SESSION' })).toBeDefined()
    expect(await ui.find({ text: '3.46M tokens' })).toBeDefined()
    expect(await ui.find({ text: '5-hour limit' })).toBeDefined()
    expect(await ui.find({ text: 'resets in 2h 0m' })).toBeDefined()
    expect(await ui.find({ text: '120.67M tokens' })).toBeDefined()
    expect(await ui.find({ key: 'open' })).toBeDefined()

    expect(writes).toHaveLength(1)
    expect(writes[0]?.path.split('\\').join('/')).toBe('C:/Users/me/.claude/tokenmeter-live.json')
    expect(JSON.parse(writes[0]?.text ?? '{}').rateLimits[0].percentUsed).toBe(23.5)
  })
}

test('honours TOKENMETER_PORT and CLAUDE_CONFIG_DIR', async ($, on) => {
  const urls: string[] = []
  const paths: string[] = []
  mock.clock(on, { now: NOW })
  mock.env(on, { TOKENMETER_PORT: '5000', CLAUDE_CONFIG_DIR: '/data/claude', HOME: '/home/me' })
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: usage }))
  on('http.fetch', ($, e) => {
    urls.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(sample) } }
  })
  on('fs.write', ($, e) => {
    paths.push(e.path.split('\\').join('/'))
    return { value: undefined }
  })

  const ui = await $.ui.mount({ plugin: 'tokenmeter', surface: 'terminal', component: 'Pane', requestId: 'tokens', props: paneProps })
  await ui.press({ key: 'refresh' })

  expect(urls[0]?.startsWith('http://127.0.0.1:5000/')).toBe(true)
  expect(paths[0]?.endsWith('/data/claude/tokenmeter-live.json')).toBe(true)
})

test('falls back to scanning the logs when the dashboard is down', async ($, on) => {
  const runs: (readonly string[])[] = []
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: usage }))
  on('http.fetch', () => ({ deny: 'connection refused' }))
  on('process.run', ($, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: JSON.stringify(sample), stderr: '' } }
  })

  const ui = await $.ui.mount({ plugin: 'tokenmeter', surface: 'desktop', component: 'Pane', requestId: 'tokens', props: paneProps })
  await ui.press({ key: 'refresh' })

  expect(runs[0]?.[0]).toBe('node')
  expect(runs[0]?.[1]?.split('\\').join('/').endsWith('/scanner.js')).toBe(true)
  expect(runs[0]?.slice(2)).toEqual(['--summary', 's1'])
  expect(await ui.find({ text: '3.46M tokens' })).toBeDefined()
  expect(await ui.find({ key: 'open' })).toBeUndefined()
})

test('explains what went wrong when the logs cannot be read', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  on('session.id', () => ({ value: 's1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { ...usage, rateLimits: [] } }))
  on('http.fetch', () => ({ deny: 'connection refused' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'node: command not found' } }))

  const ui = await $.ui.mount({ plugin: 'tokenmeter', surface: 'terminal', component: 'Pane', requestId: 'tokens', props: paneProps })
  await ui.press({ key: 'refresh' })

  expect(await ui.find({ text: /Couldn't read the session logs \(node: command not found\)/ })).toBeDefined()
  expect(await ui.find({ text: 'No plan-limit reading yet.' })).toBeDefined()
})
