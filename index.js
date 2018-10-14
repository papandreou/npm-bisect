#!/usr/bin/env node

const childProcess = require('child_process');
const pathModule = require('path');
const spawnWrap = require('spawn-wrap');
const inquirer = require('inquirer');
const promisify = require('util').promisify;
const rimrafAsync = promisify(require('rimraf'));
const consumeReadableStream = require('./consumeReadableStream');
const chalk = require('chalk');
const os = require('os');

const { good, bad } = require('yargs')
  .option('good', {
    type: 'string'
  })
  .option('bad', {
    type: 'string'
  }).argv;

async function getTimeOfHeadCommit() {
  // 2018-10-13 23:53:46 +0200
  return new Date(
    await promisify(cb =>
      childProcess.exec('git show -s --format=%ci', cb.bind(null))
    )()
  );
}

async function freshNpmInstall({ ignoreNewerThan, computeTimeline = false }) {
  await rimrafAsync('node_modules');
  // Use a separate cache dir for each point in time so the monkey patched
  // payloads don't mess anything up:
  const cacheDir = pathModule.resolve(
    os.tmpdir(),
    `npm-bisect-cache-dir-${ignoreNewerThan.toJSON()}-${Math.floor(
      1000000 * Math.random()
    )}`
  );
  const env = {
    npm_config_cache: cacheDir,
    NPM_BISECT_IGNORE_NEWER_THAN: ignoreNewerThan.toJSON()
  };
  const options = {
    stdio: ['inherit', 'inherit', 'pipe']
  };
  if (computeTimeline) {
    env.NPM_BISECT_COMPUTE_TIMELINE = true;
  }
  return new Promise((resolve, reject) => {
    const unwrap = spawnWrap([pathModule.resolve(__dirname, 'main.js')], env);
    const command = 'npm';
    const args = ['install'];
    const p = childProcess.spawn(command, args, options);
    const stderrPromise = consumeReadableStream(p.stderr);
    p.on('error', reject).on('exit', async exitCode => {
      unwrap();
      const { body, err } = await stderrPromise;
      if (exitCode === 0) {
        if (err) {
          reject(err);
        }
        const matchTimeline = body
          .toString('utf-8')
          .match(/^NPM_BISECT_COMPUTE_TIMELINE:(\[.*\])$/m);
        if (matchTimeline) {
          resolve(
            JSON.parse(matchTimeline[1]).map(({ time, ...rest }) => ({
              time: new Date(time),
              ...rest
            }))
          );
        }
        resolve();
      } else {
        reject(
          new Error(
            `${command} ${args.join(' ')} exited with ${exitCode}:\n${body}`
          )
        );
      }
    });
  });
}

function addTimeStrs(timeline) {
  let maxTimeWidth = Math.max(
    ...timeline.map(({ time }) => time.toLocaleTimeString().length)
  );
  let maxDateWidth = Math.max(
    ...timeline.map(({ time }) => time.toLocaleDateString().length)
  );

  for (const event of timeline) {
    event.timeStr = `${event.time
      .toLocaleDateString()
      .padEnd(maxDateWidth, ' ')} ${event.time
      .toLocaleTimeString()
      .padEnd(maxTimeWidth, ' ')}`;
  }
}

function dumpState(timeline, goodBeforeIndex, badAfterIndex, tryBeforeIndex) {
  for (const [i, { timeStr, packageName, version }] of timeline.entries()) {
    let line = `${timeStr} ${packageName} ${version}`;
    if (i < goodBeforeIndex) {
      line = chalk.green(line);
    } else if (i > badAfterIndex) {
      line = chalk.red(line);
    } else if (i + 1 === tryBeforeIndex) {
      line = chalk.yellow(line);
    }
    console.log(line);
  }
}

(async () => {
  let goodTime = new Date(
    good ||
      (await inquirer.prompt({
        type: 'input',
        message: 'When did it last work?',
        default: (await getTimeOfHeadCommit()).toLocaleString(),
        name: 'good',
        validate: str => !isNaN(new Date(str).getTime())
      })).good
  );

  let badTime = new Date(
    bad ||
      (await inquirer.prompt({
        type: 'input',
        message: 'When did it stop working?',
        name: 'bad',
        default: new Date().toLocaleString(),
        validate: str => !isNaN(new Date(str).getTime())
      })).bad
  );
  let timeline = await freshNpmInstall({
    ignoreNewerThan: goodTime,
    computeTimeline: true
  });

  timeline = timeline.filter(({ time }) => time > goodTime && time <= badTime);
  if (timeline.length === 0) {
    console.log(
      `No relevant packages have been published between ${badTime.toLocaleString()} and ${goodTime.toLocaleString()}`
    );
    return;
  }

  console.log(
    `There has been ${timeline.length} publication${
      timeline.length === 1 ? '' : 's'
    } that could have caused the problem:`
  );
  addTimeStrs(timeline);
  if (timeline.length > 1) {
    timeline = (await inquirer.prompt({
      type: 'checkbox',
      message:
        'Optionally deselect publications that you know did not cause the problem',
      name: 'publications',
      pageSize: timeline.length,
      choices: timeline.map(event => ({
        name: `${event.timeStr} ${event.packageName}@${event.version}`,
        checked: true,
        value: event
      }))
    })).publications;
  }
  let goodBeforeIndex = 0;
  let badAfterIndex = timeline.length - 1;
  while (badAfterIndex - goodBeforeIndex > 1) {
    const tryBeforeIndex = Math.ceil(
      goodBeforeIndex + (badAfterIndex - goodBeforeIndex) / 2
    );
    dumpState(timeline, goodBeforeIndex, badAfterIndex, tryBeforeIndex);
    const { packageName, version, time } = timeline[tryBeforeIndex];
    console.log(
      `Let's try right before ${packageName}@${version} was published`
    );
    const ignoreNewerThan = new Date(time.getTime() - 1);
    await freshNpmInstall({ ignoreNewerThan });
    const works = (await inquirer.prompt({
      type: 'confirm',
      name: 'works',
      message: 'Does it work now?'
    })).works;
    if (works) {
      goodBeforeIndex = tryBeforeIndex;
    } else {
      badAfterIndex = tryBeforeIndex - 1;
    }
  }
})();
