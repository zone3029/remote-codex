const path = require('node:path');

process.env.REMOTE_CODEX_APP_ROOT ||= __dirname;
process.env.REMOTE_CODEX_APP_VERSION ||= require(path.join(__dirname, 'package.json')).version;

require('./worker');
