# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Setup

There is nothing to install: the scanner and dashboard use only Node.js
built-ins, and the pane is a Claude Code plugin.

```bash
git clone https://github.com/bar-madar/claude-tokenmeter
cd claude-tokenmeter
npm run demo          # dashboard on made-up data, at http://localhost:4546
npm start             # dashboard on your own logs, at http://localhost:4545
```

To run the pane from your working copy instead of an installed release:

```bash
claude --plugin-dir .
```

## Tests

```bash
npm test              # scanner tests (Node's built-in test runner)
npm run test:plugin   # plugin manifest checks and pane tests (needs Claude Code)
```

CI runs both on every push and pull request.

## Guidelines

- Keep the runtime dependency-free.
- Never send data anywhere: everything stays on the user's machine.
- Add a test for each behaviour you change, and an entry under
  "Unreleased" in [CHANGELOG.md](CHANGELOG.md).
- Screenshots in the README use `npm run demo`, never real logs.
