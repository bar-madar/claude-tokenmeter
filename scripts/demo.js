'use strict';

// Starts the dashboard on made-up data, so you can try it without logs of your
// own:  npm run demo
// The data lives in a temporary folder; your real Claude Code data is untouched.

const os = require('os');
const path = require('path');
const { writeDemoData } = require('./demo-data');

const dir = path.join(os.tmpdir(), 'claude-tokenmeter-demo');
const { sessions } = writeDemoData(dir);
console.log(`Wrote ${sessions} demo sessions to ${dir}`);

// The scanner reads these when it loads, so set them first.
process.env.CLAUDE_CONFIG_DIR = dir;
delete process.env.CLAUDE_PROJECTS_DIR;
process.env.TOKENMETER_PORT = process.env.TOKENMETER_PORT || '4546';

require('../dashboard/server').start();
