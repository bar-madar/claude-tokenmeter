(() => {
  'use strict';

  const REFRESH_MS = 60000;
  const SVG = 'http://www.w3.org/2000/svg';
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const SERIES = [
    { key: 'cacheRead', label: 'Cache read', color: 'var(--s-cache-read)' },
    { key: 'cacheWrite', label: 'Cache write', color: 'var(--s-cache-write)' },
    { key: 'input', label: 'Input', color: 'var(--s-input)' },
    { key: 'output', label: 'Output', color: 'var(--s-output)' },
  ];

  let data = null;
  let dailyMode = 'all';
  let showAllSessions = false;

  // ---------- formatting ----------
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmt(n) {
    n = Number(n) || 0;
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }
  const fmtFull = n => (Number(n) || 0).toLocaleString();
  const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';

  function ago(ts) {
    if (!ts) return '–';
    const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function duration(ms) {
    const m = Math.round((ms || 0) / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }

  function until(ts) {
    if (!ts) return '';
    const ms = Date.parse(ts) - Date.now();
    if (ms <= 0) return 'resets now';
    const h = Math.floor(ms / 3600000);
    const d = Math.floor(h / 24);
    if (d >= 1) return `resets in ${d}d ${h % 24}h`;
    return `resets in ${h}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }

  const dayLabel = (iso, opts = { month: 'short', day: 'numeric' }) =>
    new Date(iso + 'T00:00:00').toLocaleDateString(undefined, opts);
  const clock = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const shortModel = m => String(m || '').replace(/^claude-/, '');
  const WHERE = { 'claude-desktop': 'Desktop', cli: 'CLI', 'claude-vscode': 'VS Code' };

  // ---------- tooltip ----------
  const tip = $('tooltip');
  function showTip(evt, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  const row = (label, value, color) =>
    `<div class="t-row"><span>${color ? `<i style="background:${color}"></i>` : ''}${esc(label)}</span><b>${value}</b></div>`;

  function el(name, attrs = {}, parent) {
    const n = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }

  // Bar with only its top corners rounded, anchored to the baseline.
  function topRounded(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  // ---------- sections ----------
  function renderHeader(d) {
    const t = d.totals;
    const since = t.firstTs ? new Date(t.firstTs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '–';
    $('subtitle').textContent = `${t.sessions} sessions · ${fmt(t.all)} tokens · since ${since}`;
    $('updated').textContent = 'Updated ' + clock(d.generatedAt);
    $('footer-updated').textContent = 'Updated ' + clock(d.generatedAt);
    $('footer-total').textContent = `● ${fmt(d.today.all)} today · ${fmt(t.all)} all time`;
    document.title = `${fmt(d.today.all)} today · Tokenmeter`;
  }

  function renderLastSession(d) {
    const s = d.sessions[0];
    if (!s) {
      $('last-session').innerHTML = '<div class="label">Last session</div><div class="muted">No sessions found yet.</div>';
      return;
    }
    $('last-session').innerHTML = `
      <div class="label">Last session</div>
      <div class="name">${esc(s.title || s.project)}</div>
      <div class="meta">
        <span>${esc(ago(s.lastTs))}</span>
        <span>${esc(s.project)}</span>
        <span>${fmt(s.all)} tokens</span>
        <span>${fmt(s.io)} in/out</span>
        <span>${s.prompts} prompts</span>
        <span>${s.toolCalls} tool calls</span>
        ${s.activeMs ? `<span>${duration(s.activeMs)} working</span>` : ''}
        <span>${esc(s.models.map(shortModel).join(', '))}</span>
        ${s.entrypoint ? `<span class="pill">${esc(WHERE[s.entrypoint] || s.entrypoint)}</span>` : ''}
      </div>`;
  }

  function renderHero(d) {
    const t = d.totals;
    $('today-all').textContent = fmt(d.today.all);
    $('today-sub').textContent = `${fmt(d.today.io)} in/out · ${d.today.calls} responses · ${d.today.sessions} sessions`;
    $('proj-all').textContent = fmt(d.projection30.all);
    $('proj-sub').textContent = `based on 7-day avg of ${fmt(d.avg7.all)}/day · ${fmt(d.projection30.io)} in/out`;
    $('cache-rate').textContent = pct(t.cacheHitRate);
    $('cache-sub').textContent = `${fmt(t.cacheRead)} input tokens served from cache`;
    $('all-time').textContent = fmt(t.all);
    $('all-time-sub').textContent = `${fmtFull(t.all)} tokens`;
  }

  function renderLive(d) {
    const live = d.live;
    if (!live) {
      $('live').innerHTML = `<div class="card live-empty">Plan limits and context fill come from the live
        <b>Tokens</b> pane inside a Code session. Open any Code session with the pane loaded and they'll appear here.</div>`;
      return;
    }
    const names = { five_hour: '5-hour limit', seven_day: 'Weekly limit', spend_limit: 'Spend limit' };
    const cards = (live.rateLimits || []).map(r => `
      <div class="card">
        <div class="label">${esc(names[r.kind] || r.kind)}</div>
        <div class="big">${r.percentUsed}%<span class="muted" style="font-size:12px;font-weight:400"> used</span></div>
        <div class="meter"><div style="width:${Math.min(100, r.percentUsed)}%"></div></div>
        <div class="sub">${esc(until(r.resetsAt))}</div>
      </div>`);
    const c = live.context;
    if (c && c.window) {
      const p = c.percent ?? (c.tokens ? Math.round((c.tokens / c.window) * 100) : 0);
      cards.push(`
      <div class="card">
        <div class="label">Context window</div>
        <div class="big">${p}%<span class="muted" style="font-size:12px;font-weight:400"> full</span></div>
        <div class="meter"><div style="width:${Math.min(100, p)}%"></div></div>
        <div class="sub">${fmt(c.tokens || 0)} of ${fmt(c.window)} tokens · ${esc(shortModel(live.model))}</div>
        ${live.title ? `<div class="sub" title="${esc(live.title)}">${esc(live.title)}</div>` : ''}
      </div>`);
    }
    if (!cards.length) cards.push('<div class="card live-empty">No plan-limit reading yet. It appears after the next reply in a Code session.</div>');
    cards.push(`<div class="card"><div class="label">Last reading</div><div class="big" style="font-size:18px">${esc(ago(live.at))}</div>
      <div class="sub">from the Tokens pane at ${esc(clock(live.at))}</div></div>`);
    $('live').innerHTML = cards.join('');
  }

  function renderSummary(d) {
    const t = d.totals;
    const items = [
      ['Input tokens', fmt(t.input), 'var(--s-input)', 'uncached input'],
      ['Output tokens', fmt(t.output), 'var(--s-output)', `${fmt(t.thinking)} of it thinking`],
      ['Cache read', fmt(t.cacheRead), 'var(--s-cache-read)', 'reused context'],
      ['Cache write', fmt(t.cacheWrite), 'var(--s-cache-write)', `5m ${fmt(t.cacheWrite5m)} · 1h ${fmt(t.cacheWrite1h)}`],
      ['In + out', fmt(t.io), null, 'input + output only'],
      ['Responses', fmtFull(t.calls), null, `${t.errors} API errors`],
      ['Tool calls', fmtFull(t.toolCalls), null, `${t.webSearch} web searches`],
      ['Prompts', fmtFull(t.prompts), null, `${t.sessions} sessions`],
      ['Time working', duration(t.activeMs), null, 'Claude busy on turns'],
      ['Avg / session', fmt(t.sessions ? t.all / t.sessions : 0), null, `${fmt(t.sessions ? t.io / t.sessions : 0)} in/out`],
    ];
    $('summary').innerHTML = items.map(([label, val, color, sub]) => `
      <div class="card">
        <div class="label">${color ? `<span class="swatch" style="background:${color}"></span>` : ''}${esc(label)}</div>
        <div class="val">${val}</div>
        <div class="sub">${esc(sub)}</div>
      </div>`).join('');
  }

  // ---------- daily stacked bars ----------
  function renderDaily(d) {
    const host = $('daily-chart');
    const days = d.daily.slice(-14);
    const series = dailyMode === 'all' ? SERIES : SERIES.filter(s => s.key !== 'cacheRead');
    const total = day => series.reduce((a, s) => a + day[s.key], 0);

    $('daily-legend').innerHTML = series.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');

    const W = Math.max(280, host.clientWidth);
    const H = 230;
    const m = { t: 10, r: 6, b: 24, l: 52 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const max = niceMax(Math.max(...days.map(total), 1));
    const y = v => m.t + ih - (v / max) * ih;
    const step = iw / days.length;
    const bw = Math.max(4, Math.min(34, step * 0.62));

    host.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Daily tokens, last 14 days' }, host);
    const axis = el('g', { class: 'axis' }, svg);
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      el('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, axis);
      el('text', { x: m.l - 8, y: y(v) + 3.5, 'text-anchor': 'end' }, axis).textContent = fmt(v);
    }
    const every = step < 34 ? 2 : 1;
    days.forEach((day, i) => {
      const cx = m.l + step * i + step / 2;
      if ((days.length - 1 - i) % every === 0) {
        el('text', { x: cx, y: H - 6, 'text-anchor': 'middle' }, axis).textContent = dayLabel(day.date);
      }
      const segs = series.filter(s => day[s.key] > 0);
      let acc = 0;
      segs.forEach((s, si) => {
        const v = day[s.key];
        const y0 = y(acc);
        const y1 = y(acc + v);
        acc += v;
        const isTop = si === segs.length - 1;
        // 2px surface gap between stacked segments
        const h = Math.max(isTop ? 1 : 0, y0 - y1 - (si > 0 ? 2 : 0));
        if (h <= 0) return;
        const top = y0 - (si > 0 ? 2 : 0) - h;
        if (isTop) el('path', { d: topRounded(cx - bw / 2, top, bw, h, 4), fill: s.color }, svg);
        else el('rect', { x: cx - bw / 2, y: top, width: bw, height: h, fill: s.color }, svg);
      });
      const hit = el('rect', { class: 'hit', x: m.l + step * i, y: m.t, width: step, height: ih }, svg);
      hit.addEventListener('mousemove', e => showTip(e,
        `<div class="t-title">${esc(dayLabel(day.date, { weekday: 'short', month: 'short', day: 'numeric' }))}</div>` +
        series.slice().reverse().map(s => row(s.label, fmt(day[s.key]), s.color)).join('') +
        row('Total', fmt(total(day))) + row('Responses', day.calls)));
      hit.addEventListener('mouseleave', hideTip);
    });

    $('daily-table').innerHTML = table(
      ['Date', ...SERIES.map(s => s.label), 'All', 'Responses'],
      days.slice().reverse().map(day => [dayLabel(day.date), ...SERIES.map(s => fmtFull(day[s.key])), fmtFull(day.all), day.calls]),
      [false, true, true, true, true, true, true]);
  }

  // ---------- 90-day heatmap ----------
  function renderHeatmap(d) {
    const host = $('heatmap');
    const days = d.daily;
    const vals = days.map(x => x.all).filter(v => v > 0).sort((a, b) => a - b);
    const q = p => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0;
    const cuts = [q(0.25), q(0.5), q(0.75)];
    const level = v => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
    const colors = ['--h0', '--h1', '--h2', '--h3', '--h4'].map(css);

    const firstDow = new Date(days[0].date + 'T00:00:00').getDay();
    const weeks = Math.ceil((days.length + firstDow) / 7);
    const W = Math.max(260, host.clientWidth);
    const left = 26;
    const top = 16;
    const gap = 3;
    const cell = Math.max(6, Math.min(20, Math.floor((W - left) / weeks) - gap));
    const H = top + 7 * (cell + gap);

    host.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Tokens per day, last 90 days' }, host);
    const axis = el('g', { class: 'axis' }, svg);
    ['Mon', 'Wed', 'Fri'].forEach((n, i) => {
      el('text', { x: 0, y: top + (1 + i * 2) * (cell + gap) + cell - 2 }, axis).textContent = n;
    });
    let lastMonth = -1;
    let lastLabelX = -Infinity;
    days.forEach((day, i) => {
      const k = i + firstDow;
      const col = Math.floor(k / 7);
      const dow = k % 7;
      const x = left + col * (cell + gap);
      const yy = top + dow * (cell + gap);
      const dt = new Date(day.date + 'T00:00:00');
      if (dow === 0 || i === 0) {
        // Label a month where it starts; skip the first column's month when
        // it ends within a week or two, so labels never collide.
        const starts = dt.getDate() <= 7 || (i === 0 && dt.getDate() <= 17);
        if (dt.getMonth() !== lastMonth && starts && x - lastLabelX >= 30) {
          lastMonth = dt.getMonth();
          lastLabelX = x;
          el('text', { x, y: 10 }, axis).textContent = dt.toLocaleDateString(undefined, { month: 'short' });
        }
      }
      const r = el('rect', { x, y: yy, width: cell, height: cell, rx: 2, fill: colors[level(day.all)] }, svg);
      r.style.cursor = 'default';
      r.addEventListener('mousemove', e => showTip(e,
        `<div class="t-title">${esc(dayLabel(day.date, { weekday: 'short', month: 'short', day: 'numeric' }))}</div>` +
        row('All tokens', fmt(day.all)) + row('In/out', fmt(day.io)) + row('Responses', day.calls)));
      r.addEventListener('mouseleave', hideTip);
    });
    $('heat-legend').innerHTML = '<span class="muted">Less</span>' + colors.map(c => `<i style="background:${c}"></i>`).join('') + '<span class="muted">More</span>';
  }

  // ---------- peak hours ----------
  function renderHours(d) {
    const host = $('hours-chart');
    const hours = d.hours;
    const W = Math.max(260, host.clientWidth);
    const H = 160;
    const m = { t: 8, r: 4, b: 22, l: 46 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const max = niceMax(Math.max(...hours.map(h => h.all), 1));
    const y = v => m.t + ih - (v / max) * ih;
    const step = iw / 24;
    const bw = Math.max(3, step - 3);

    host.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Tokens by hour of day' }, host);
    const axis = el('g', { class: 'axis' }, svg);
    for (let i = 0; i <= 2; i++) {
      const v = (max / 2) * i;
      el('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, axis);
      el('text', { x: m.l - 8, y: y(v) + 3.5, 'text-anchor': 'end' }, axis).textContent = fmt(v);
    }
    const peak = hours.reduce((b, h, i) => (h.all > hours[b].all ? i : b), 0);
    hours.forEach((h, i) => {
      const x = m.l + step * i + (step - bw) / 2;
      if (i % 3 === 0) el('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle' }, axis).textContent = String(i).padStart(2, '0');
      if (h.all > 0) {
        const bh = Math.max(1, m.t + ih - y(h.all));
        el('path', { d: topRounded(x, m.t + ih - bh, bw, bh, 3), fill: 'var(--s-output)', opacity: i === peak ? 1 : 0.7 }, svg);
      }
      const hit = el('rect', { class: 'hit', x: m.l + step * i, y: m.t, width: step, height: ih }, svg);
      hit.addEventListener('mousemove', e => showTip(e,
        `<div class="t-title">${String(i).padStart(2, '0')}:00–${String(i).padStart(2, '0')}:59</div>` +
        row('All tokens', fmt(h.all)) + row('In/out', fmt(h.io)) + row('Responses', h.calls)));
      hit.addEventListener('mouseleave', hideTip);
    });
  }

  // ---------- tables ----------
  function table(head, rows, numeric = []) {
    return `<table><thead><tr>${head.map((h, i) => `<th class="${numeric[i] ? 'num' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${numeric[i] ? 'num' : ''}${i === 0 ? ' wrap' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function sparkline(values) {
    const w = 110;
    const h = 24;
    const max = Math.max(...values, 1);
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * (w - 4) + 2},${h - 3 - (v / max) * (h - 6)}`).join(' ');
    const last = pts.split(' ').pop().split(',');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--orange)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${last[0]}" cy="${last[1]}" r="2.5" fill="var(--orange)"/></svg>`;
  }

  // Claude Code's numbers from a TokenDiet audit, or the heaviest agent's.
  function dietAgent(a) {
    return a.agents.find(x => x.name === 'Claude Code') || a.agents.slice().sort((x, y) => y.perRequest - x.perRequest)[0];
  }

  function perRequestCell(p) {
    const a = p.diet && dietAgent(p.diet);
    if (!a) return '<span class="muted" title="No TokenDiet audit yet">–</span>';
    const save = a.saves ? ` <span class="green">-${Math.round((a.saves / Math.max(1, a.perRequest)) * 100)}%</span>` : '';
    return `<span title="${esc(a.name)}: ~${fmtFull(a.perRequest)} tokens of instructions per request, ~${fmtFull(a.saves)} can go">~${fmt(a.perRequest)}${save}</span>`;
  }

  function renderProjects(d) {
    $('projects').innerHTML = table(
      ['Project', 'Sessions', 'All tokens', 'In/out', 'Cache hit', 'Per request', 'Last active', '14 days'],
      d.projects.map(p => [
        `<span title="${esc(p.path)}">${esc(p.name)}</span>`, p.sessions, fmt(p.all), fmt(p.io), pct(p.cacheHitRate, 0), perRequestCell(p), esc(ago(p.lastTs)), sparkline(p.spark),
      ]),
      [false, true, true, true, true, true, true, false]);
  }

  function renderDiet(d) {
    const audits = (d.diet || []).slice(0, 6);
    if (!audits.length) {
      $('diet').innerHTML = `
        <div class="card diet-empty">
          <div class="label">Not measured yet</div>
          <p>Every request also carries your CLAUDE.md, AGENTS.md and rules files.
          <b>TokenDiet</b> measures what they add per request, for every agent, and trims them without losing anything.
          Its audits appear here.</p>
          <a class="text-link" href="https://bar-madar.github.io/tokendiet/" target="_blank" rel="noopener">See how TokenDiet works</a>
        </div>`;
      return;
    }
    $('diet').innerHTML = audits.map(a => `
      <div class="card diet-card">
        <div class="label">${esc(a.name)} <span class="muted">· audited ${esc(ago(a.at))}</span></div>
        ${a.agents.map(g => `
          <div class="diet-row">
            <span>${esc(g.name)}</span>
            <span class="num">~${fmtFull(g.perRequest)}${g.saves ? ` → <b class="green">~${fmtFull(g.perRequest - g.saves)}</b>` : ''}</span>
          </div>`).join('')}
        ${a.top && a.top.length ? `<ul class="diet-top">${a.top.map(t => `<li>${esc(t.title)}</li>`).join('')}</ul>` : '<p class="muted">Already lean.</p>'}
      </div>`).join('');
  }

  function renderSessions(d) {
    const list = showAllSessions ? d.sessions : d.sessions.slice(0, 12);
    $('sessions').innerHTML = table(
      ['Session', 'Project', 'Where', 'Prompts', 'Responses', 'All tokens', 'In/out', 'Last active'],
      list.map(s => [
        esc(s.title || '(untitled)'), esc(s.project), s.entrypoint ? `<span class="pill">${esc(WHERE[s.entrypoint] || s.entrypoint)}</span>` : '',
        s.prompts, s.calls, fmt(s.all), fmt(s.io), esc(ago(s.lastTs)),
      ]),
      [false, false, false, true, true, true, true, true]);
    $('more-sessions').hidden = showAllSessions || d.sessions.length <= 12;
    $('more-sessions').textContent = `Show all ${d.sessions.length} sessions`;
  }

  function renderModels(d) {
    $('models').innerHTML = table(
      ['Model', 'Responses', 'Input', 'Output', 'Cache read', 'Cache write', 'All'],
      d.models.map(m => [esc(shortModel(m.model)), m.calls, fmt(m.input), fmt(m.output), fmt(m.cacheRead), fmt(m.cacheWrite), fmt(m.all)]),
      [false, true, true, true, true, true, true]);
  }

  function renderTools(d) {
    const top = d.tools.slice(0, 12);
    const max = Math.max(...top.map(t => t.count), 1);
    $('tools').innerHTML = top.length
      ? top.map(t => `<div class="tool-row"><span class="nm" title="${esc(t.name)}">${esc(t.name.replace(/^mcp__.*?__/, ''))}</span><div class="bar" style="width:${(t.count / max) * 100}%"></div><span class="n">${t.count}</span></div>`).join('')
      : '<div class="muted">No tool calls yet.</div>';
  }

  function renderAll() {
    if (!data) return;
    renderHeader(data);
    renderLastSession(data);
    renderHero(data);
    renderLive(data);
    renderSummary(data);
    renderDaily(data);
    renderHeatmap(data);
    renderHours(data);
    renderProjects(data);
    renderDiet(data);
    renderSessions(data);
    renderModels(data);
    renderTools(data);
  }

  // ---------- data ----------
  async function load() {
    const btn = $('refresh');
    btn.classList.add('spin');
    buddy.play('think');
    try {
      const res = await fetch('/api/stats', { cache: 'no-store' });
      if (!res.ok) throw new Error(await res.text());
      data = await res.json();
      $('error').hidden = true;
      renderAll();
    } catch (err) {
      $('error').hidden = false;
      $('error').textContent = 'Could not load stats: ' + (err && err.message || err);
    } finally {
      btn.classList.remove('spin');
    }
  }

  // ---------- pixel buddy ----------
  const buddy = (() => {
    const canvas = $('buddy');
    const ctx = canvas.getContext('2d');
    const S = 4;
    const BODY = [
      '...#....#...',
      '....#..#....',
      '...######...',
      '..########..',
      '.##EE##EE##.',
      '.##EE##EE##.',
      '############',
      '#.########.#',
      '#.########.#',
      '...##..##...',
      '...##..##...',
    ];
    const C = { '#': '#c8724f', h: '#e0916f', E: '#1a1a1a', '.': null };
    let anim = 'breath';
    let frame = 0;
    let until = 0;

    function draw(opts = {}) {
      const { dx = 0, dy = 0, eyes = 'open', arms = 'down', dots = 0 } = opts;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const ox = 1 + dx;
      const oy = 2 + dy;
      BODY.forEach((line, r) => {
        [...line].forEach((ch, c) => {
          let col = C[ch];
          if (ch === 'E') {
            const leftEye = c < 6;
            const closed = eyes === 'closed' || (eyes === 'wink' && !leftEye);
            const isTop = r === 4;
            if (closed) col = isTop ? C['#'] : C.E;
            else if (eyes === 'up') col = isTop && (c === 4 || c === 8) ? C.E : C['#'];
          }
          if (arms === 'up' && r >= 7 && r <= 8 && (c === 0 || c === 11)) col = null;
          if (col) {
            ctx.fillStyle = col;
            ctx.fillRect((ox + c) * S, (oy + r) * S, S, S);
          }
        });
      });
      // highlight row on the head
      ctx.fillStyle = C.h;
      ctx.fillRect((ox + 3) * S, (oy + 2) * S, S * 6, S);
      if (arms === 'up') {
        ctx.fillStyle = C['#'];
        ctx.fillRect(ox * S, (oy + 4) * S, S, S * 2);
        ctx.fillRect((ox + 11) * S, (oy + 4) * S, S, S * 2);
      }
      if (eyes === 'wide') {
        ctx.fillStyle = C.E;
        ctx.fillRect((ox + 3) * S, (oy + 3) * S, S * 2, S);
        ctx.fillRect((ox + 7) * S, (oy + 3) * S, S * 2, S);
      }
      for (let i = 0; i < dots; i++) {
        ctx.fillStyle = '#8a8a8a';
        ctx.fillRect((ox + 9 + i) * S, (oy - 1 - i) * S, S - 1, S - 1);
      }
    }

    const ANIMS = {
      breath: f => ({ dy: Math.floor(f / 6) % 2 }),
      blink: f => ({ eyes: f % 12 < 2 ? 'closed' : 'open' }),
      wink: f => ({ eyes: f % 16 < 5 ? 'wink' : 'open' }),
      think: f => ({ eyes: 'up', dots: 1 + (Math.floor(f / 4) % 3) }),
      dance: f => ({ dx: [0, 1, 0, -1][Math.floor(f / 2) % 4], dy: f % 4 < 2 ? 0 : 1, arms: Math.floor(f / 4) % 2 ? 'up' : 'down' }),
      surprise: f => ({ eyes: 'wide', dy: f < 3 ? -1 : 0, arms: 'up' }),
      sway: f => ({ dx: [0, 0, 1, 1, 0, 0, -1, -1][Math.floor(f / 3) % 8] }),
    };
    const IDLE = ['breath', 'breath', 'blink', 'blink', 'wink', 'sway', 'dance', 'surprise', 'think'];

    function play(name, ms = 2400) {
      anim = name;
      frame = 0;
      until = performance.now() + ms;
    }

    setInterval(() => {
      if (performance.now() > until) {
        anim = IDLE[Math.floor(Math.random() * IDLE.length)];
        frame = 0;
        until = performance.now() + 2500 + Math.random() * 3500;
      }
      draw(ANIMS[anim](frame++));
    }, 120);
    canvas.addEventListener('click', () => play('dance', 3000));
    draw();
    return { play };
  })();

  // ---------- wiring ----------
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
    dailyMode = b.dataset.mode;
    document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
    if (data) renderDaily(data);
  }));
  $('more-sessions').addEventListener('click', () => {
    showAllSessions = true;
    renderSessions(data);
  });
  $('refresh').addEventListener('click', load);
  addEventListener('keydown', e => {
    if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey && !/input|textarea/i.test(e.target.tagName)) load();
  });
  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => data && (renderDaily(data), renderHeatmap(data), renderHours(data)), 80);
  }).observe($('app'));
  // Keep "x ago" labels and the stats fresh.
  setInterval(load, REFRESH_MS);
  load();
})();
