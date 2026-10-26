export type Tokens = {
  all: number
  io: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  thinking: number
  calls: number
  toolCalls: number
  cacheHitRate: number
}

/** What `scanner.js --summary` and the dashboard's /api/summary answer. */
export type Summary = {
  generatedAt: string
  session: (Tokens & { id: string; title: string | null; prompts: number }) | null
  today: Tokens & { sessions: number }
  week: { date: string; all: number; io: number }[]
  totals: Tokens & { sessions: number }
  avg7: { all: number; io: number }
  projection30: { all: number; io: number }
  topProjects: { name: string; all: number }[]
  diet: DietDigest | null
  source: 'dashboard' | 'scan'
}

/** The latest TokenDiet audit of the session's project, when there is one. */
export type DietDigest = {
  at: string
  agent: string
  perRequest: number
  saves: number
  findings: number
}

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** The session's live readings, also written to <config dir>/tokenmeter-live.json for the dashboard. */
export type Live = {
  at: string
  sessionId: string
  title: string | null
  model: string
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: RateLimit[]
}

declare module 'claude-code' {
  interface PluginState {
    'tokenmeter': {
      summary: Summary | null
      live: Live | null
      problem: string | null
    }
  }
}
