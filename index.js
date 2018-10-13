#!/usr/bin/env node

const childProcess = require('child_process');
const pathModule = require('path');
const spawnWrap = require('spawn-wrap');

const indexOfNpm = process.argv.findIndex(option =>
  /(?:^|\/)npm$/.test(option)
);

if (indexOfNpm === -1) {
  throw new Error('npm not found in the command line');
}
const { time } = require('yargs')(process.argv.slice(0, indexOfNpm)).option(
  'time',
  {
    type: 'string',
    demand: true
  }
).argv;

const ignoreNewerThan = new Date(time);
if (isNaN(ignoreNewerThan.getTime())) {
  throw new Error(`Invalid date: ${time}`);
}

const unwrap = spawnWrap([pathModule.resolve(__dirname, 'main.js')], {
  NPM_BISECT_IGNORE_NEWER_THAN: ignoreNewerThan.toJSON()
});

const [command, ...args] = process.argv.slice(indexOfNpm);

(async () => {
  const p = childProcess.spawn(command, args, { stdio: 'inherit' });
  p.on('exit', exitCode => {
    unwrap();
    process.exit(exitCode);
  });
})();
