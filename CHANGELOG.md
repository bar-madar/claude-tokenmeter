# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-26

### Added

- Works with the TokenDiet skill: the dashboard shows each project's
  instruction weight (tokens per request, and how much can go) from TokenDiet
  audits, with a "Per request" column in the projects table.
- The pane shows the latest TokenDiet audit of the session's project, and
  suggests a diet when the context passes half the window or the prompt cache
  keeps missing.
- Links to the website and support (replies within 2 business days).

### Fixed

- Heatmap month labels no longer overlap when the 90 days start late in a month.

## [0.1.0] - 2026-10-19

First public release.

### Added

- **Tokens pane** for Claude Code: this session's tokens, context window fill,
  5-hour and weekly plan limits with reset times, today, the last 7 days, a
  30-day projection and all-time totals. Refreshes after every reply and every
  minute; `/tokens` reopens it.
- **Web dashboard** on `localhost`: usage summary, 14-day stacked chart,
  90-day heatmap, peak hours, per-project sparklines, sessions, models and
  tools, with an idle pixel companion.
- Incremental log scanner that counts each API response once, even though
  Claude Code logs it once per content block.
- Demo mode (`npm run demo`) with generated data.
- Support for `CLAUDE_CONFIG_DIR` and a configurable port (`TOKENMETER_PORT`).

[0.2.0]: https://github.com/bar-madar/claude-tokenmeter/releases/tag/v0.2.0
[0.1.0]: https://github.com/bar-madar/claude-tokenmeter/releases/tag/v0.1.0
