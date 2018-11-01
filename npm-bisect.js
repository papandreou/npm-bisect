#!/usr/bin/env node

const childProcess = require('child_process');
const pathModule = require('path');
const spawnWrap = require('spawn-wrap');
const semver = require('semver');
const inquirer = require('inquirer');
const promisify = require('util').promisify;
const fs = require('fs');
const readFileAsync = promisify(fs.readFile);
const mkdirAsync = promisify(fs.mkdir);
const rimrafAsync = promisify(require('rimraf'));
const globAsync = promisify(require('glob'));
const chalk = require('chalk');
const os = require('os');
const uniq = require('lodash.uniq');
const uniqBy = require('lodash.uniqby');
const flatten = require('lodash.flatten');

let { good, bad, debug, ignore, only, yarn, run, candidates } = require('yargs')
  .option('debug', {
    type: 'boolean',
    default: false,
    describe: 'Produce verbose output for each step'
  })
  .option('candidates', {
    type: 'boolean',
    default: false,
    describe:
      'Instead of bisecting, just output a list of candidate packages and exit'
  })
  .option('yarn', {
    type: 'boolean',
    default: false,
    describe: 'Use yarn instead of npm'
  })
  .option('run', {
    type: 'string',
    describe:
      'Shell command to run for each step. Will use interactive mode if not given'
  })
  .option('ignore', {
    type: 'string',
    describe:
      'Name of a package to ignore, optionally suffixed with a version number or version range, eg. underscore@^1.2.3. Can be repeated',
    array: true,
    default: []
  })
  .option('only', {
    type: 'string',
    describe:
      'Name of a package to include in the search, optionally suffixed with a version number or version range, eg. underscore@^1.2.3. Can be repeated. Using this switch implicitly excludes all packages that are not included',
    array: true,
    default: []
  })
  .option('good', {
    type: 'string',
    describe: 'Date or datetime where the project was last known to work'
  })
  .option('bad', {
    type: 'string',
    describe: 'Date or datetime where the project was first found broken'
  }).argv;

function parsePackageAndVersionRange(packageName) {
  let versionRange = '*';
  const matchVersion = packageName.match(/^([^@]+)@(.+)$/);
  if (matchVersion) {
    [, packageName, versionRange] = matchVersion;
  }
  return { packageName, versionRange };
}

function matchesPackageSpec(event, spec) {
  return (
    event.packageName === spec.packageName &&
    semver.satisfies(event.version, spec.versionRange)
  );
}

async function exec(cmd) {
  return await promisify(cb => childProcess.exec(cmd, cb.bind(null)))();
}

async function getTimeOfHeadCommit() {
  try {
    return new Date(await exec('git show -s --format=%ci'));
  } catch (err) {}
}

async function installDependencies({
  ignoreNewerThan,
  computeTimeline = false
}) {
  await rimrafAsync('node_modules/*', { glob: { dot: true } });
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
    stdio: 'inherit'
  };
  if (computeTimeline) {
    await mkdirAsync(cacheDir);
    const timelineOutputDir = pathModule.resolve(
      cacheDir,
      `npm-bisect-out-${Math.floor(1000000 * Math.random())}`
    );
    await mkdirAsync(timelineOutputDir);
    env.NPM_BISECT_COMPUTE_TIMELINE = timelineOutputDir;
  }
  try {
    return await new Promise((resolve, reject) => {
      const unwrap = spawnWrap([pathModule.resolve(__dirname, 'main.js')], env);
      const command = yarn ? 'yarn' : 'npm';
      const args = ['install'];
      if (yarn) {
        args.push('--cache-folder', cacheDir, '--pure-lockfile');
      } else {
        args.push('--no-audit');
      }
      const p = childProcess.spawn(command, args, options);
      p.on('error', reject).on('exit', async exitCode => {
        unwrap();
        if (exitCode === 0) {
          if (computeTimeline) {
            const fileNames = await globAsync(
              pathModule.resolve(env.NPM_BISECT_COMPUTE_TIMELINE, '*.json')
            );
            const jsonStrs = await Promise.all(
              fileNames.map(
                async fileName => await readFileAsync(fileName, 'utf-8')
              )
            );
            let timeline = flatten(
              jsonStrs.map(jsonStr =>
                JSON.parse(jsonStr).map(({ time, ...rest }) => ({
                  time: new Date(time),
                  ...rest
                }))
              )
            );
            timeline.sort((a, b) => {
              return a.time.getTime() - b.time.getTime();
            });
            timeline = uniqBy(
              timeline,
              ({ packageName, version }) => `${packageName}@${version}`
            );
            resolve(timeline);
          } else {
            resolve();
          }
        } else {
          reject(
            new Error(`${command} ${args.join(' ')} exited with ${exitCode}`)
          );
        }
      });
    });
  } finally {
    await rimrafAsync(cacheDir);
  }
}

async function checkWorkingState() {
  if (run) {
    const err = await promisify(cb =>
      childProcess.exec(run, cb.bind(null, null))
    )();
    return !err;
  } else {
    return (await inquirer.prompt({
      type: 'confirm',
      name: 'works',
      message: 'Does it work now?'
    })).works;
  }
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
    if (i === tryBeforeIndex) {
      line += ' tryBeforeIndex';
    }
    if (i === goodBeforeIndex) {
      line += ' goodBeforeIndex';
    }
    if (i === badAfterIndex) {
      line += ' badAfterIndex';
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
        default: await getTimeOfHeadCommit(),
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
  let timeline = await installDependencies({
    ignoreNewerThan: goodTime,
    computeTimeline: true
  });

  timeline = timeline.filter(({ time }) => time > goodTime && time <= badTime);

  if (candidates) {
    for (const { time, packageName, version } of timeline) {
      console.log(`${time.toJSON()}: ${packageName}@${version}`);
    }
    process.exit();
  }

  if (only.length > 0) {
    const onlySpecs = only.map(parsePackageAndVersionRange);

    timeline = timeline.filter(event =>
      onlySpecs.some(spec => matchesPackageSpec(event, spec))
    );
  }

  const packageNames = uniq(timeline.map(event => event.packageName));
  if (packageNames.length > 1 && ignore.length === 0 && only.length === 0) {
    ignore = (await inquirer.prompt({
      type: 'checkbox',
      message:
        'Optionally select packages that you know did not cause the problem',
      name: 'ignore',
      choices: packageNames.map(packageName => ({
        name: `${packageName} (${
          timeline.filter(event => event.packageName === packageName).length
        })`,
        value: packageName
      }))
    })).ignore;
  }

  const ignoreSpecs = ignore.map(parsePackageAndVersionRange);

  timeline = timeline.filter(
    event => !ignoreSpecs.some(spec => matchesPackageSpec(event, spec))
  );

  if (timeline.length === 0) {
    console.log(
      `No relevant packages have been published between ${goodTime.toLocaleString()} and ${badTime.toLocaleString()}`
    );
    return;
  }

  console.log(
    `There has been ${timeline.length} publication${
      timeline.length === 1 ? '' : 's'
    } that could have caused the problem:`
  );
  addTimeStrs(timeline);

  let goodBeforeIndex = 0;
  let badAfterIndex = timeline.length - 1;
  while (badAfterIndex > goodBeforeIndex) {
    const tryBeforeIndex = Math.round(
      goodBeforeIndex + (badAfterIndex - goodBeforeIndex) / 2
    );
    if (debug) {
      dumpState(timeline, goodBeforeIndex, badAfterIndex, tryBeforeIndex);
    }
    const { packageName, version, time } = timeline[tryBeforeIndex];
    console.log(
      `Let's try right before ${packageName}@${version} was published`
    );
    const numStepsLeft = Math.ceil(Math.log2(badAfterIndex - goodBeforeIndex));
    console.log(
      `Roughly ${numStepsLeft} step${numStepsLeft === 1 ? '' : 's'} left`
    );
    const ignoreNewerThan = new Date(time.getTime() - 1);
    await installDependencies({ ignoreNewerThan });
    const works = await checkWorkingState();
    if (works) {
      goodBeforeIndex = tryBeforeIndex;
    } else {
      badAfterIndex = tryBeforeIndex - 1;
    }
  }
  if (debug) {
    dumpState(timeline, goodBeforeIndex, badAfterIndex);
  }
  const badEvent = timeline[goodBeforeIndex];
  console.log(
    `The problem was introduced by the upgrade to ${badEvent.packageName}@${
      badEvent.version
    } published at ${badEvent.time.toLocaleString()}`
  );
})();
