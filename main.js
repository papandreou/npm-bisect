const mitm = require('mitm-papandreou')();

const http = require('http');
const https = require('https');
const pick = require('lodash.pick');
const uniqBy = require('lodash.uniqby');
const consumeReadableStream = require('./consumeReadableStream');

const metadataPropertyNames = [
  'host',
  'port',
  'encrypted',
  'cert',
  'key',
  'ca',
  'credentials',
  'rejectUnauthorized'
];

const ignoreNewerThan = new Date(process.env.NPM_BISECT_IGNORE_NEWER_THAN);

function performRequest(requestResult) {
  return new Promise((resolve, reject) => {
    (requestResult.encrypted ? https : http)
      .request({
        headers: requestResult.headers,
        method: requestResult.method,
        host: requestResult.host,
        port: requestResult.port,
        path: requestResult.path,
        ...requestResult.metadata
      })
      .on('response', response => {
        consumeReadableStream(response)
          .catch(reject)
          .then(result => {
            if (result.err) {
              // TODO: Consider adding support for recording this (the upstream response erroring out while we're recording it)
              return reject(result.err);
            }

            resolve({
              statusCode: response.statusCode,
              headers: response.headers,
              body: result.body
            });
          });
      })
      .on('error', reject)
      .end(requestResult.body);
  });
}

function removeVersionsFromPackageMetadata(obj, timeByVersion) {
  let changesMade = false;
  if (timeByVersion && obj.versions) {
    const deletedVersions = new Set();
    let latestPreservedVersion;
    let latestPreservedVersionTime;
    for (const version of Object.keys(timeByVersion)) {
      if (version !== 'modified' && version !== 'created') {
        const time = new Date(timeByVersion[version]);
        if (time > ignoreNewerThan) {
          delete timeByVersion[version];
          delete obj.versions[version];
          changesMade = true;
          deletedVersions.add(version);
        } else {
          if (
            !latestPreservedVersionTime ||
            time > latestPreservedVersionTime
          ) {
            latestPreservedVersion = version;
            latestPreservedVersionTime = time;
          }
        }
      }
    }
    if (
      changesMade &&
      obj['dist-tags'] &&
      obj['dist-tags'].latest &&
      deletedVersions.has(obj['dist-tags'].latest)
    ) {
      obj['dist-tags'].latest = latestPreservedVersion;
    }
  }
  return changesMade;
}

const timeline = [];
function updateTimeline(packageName, timeByVersion) {
  for (const version of Object.keys(timeByVersion)) {
    if (version !== 'modified' && version !== 'created') {
      timeline.push({
        packageName,
        version,
        time: new Date(timeByVersion[version])
      });
    }
  }
}

function isRegistryHostname(hostname) {
  return ['registry.npmjs.org', 'registry.yarnpkg.com'].includes(hostname);
}

let bypassNextConnect = false;
mitm
  .on('connect', (socket, opts) => {
    if (bypassNextConnect) {
      socket.bypass();
      bypassNextConnect = false;
    } else if (isRegistryHostname(opts.servername)) {
      bypassNextConnect = true;
    } else {
      socket.bypass();
    }
  })
  .on('request', async (req, res) => {
    const clientSocket = req.connection._mitm.client;
    const clientSocketOptions = req.connection._mitm.opts;
    const metadata = {
      ...pick(
        clientSocketOptions.agent && clientSocketOptions.agent.options,
        metadataPropertyNames
      ),
      ...pick(clientSocketOptions, metadataPropertyNames)
    };

    const { body, err } = await consumeReadableStream(req);

    if (err) {
      throw err;
    }

    bypassNextConnect = true;
    const matchHostHeader =
      req.headers.host && req.headers.host.match(/^([^:]*)(?::(\d+))?/);

    let host;
    let port;

    // https://github.com/moll/node-mitm/issues/14
    if (matchHostHeader) {
      if (matchHostHeader[1]) {
        host = matchHostHeader[1];
      }
      if (matchHostHeader[2]) {
        port = parseInt(matchHostHeader[2], 10);
      }
    }

    let couldBePackageMetadataRequest = false;
    if (isRegistryHostname(host)) {
      delete req.headers['accept-encoding']; // Save the trouble of decoding gzip/brotli/deflate
      delete req.headers['if-none-match']; // Avoid 304s so we don't get to patch up the response
      delete req.headers.connection;
      couldBePackageMetadataRequest = true;
      if (req.headers.accept.includes('application/vnd.npm.install-v1+json')) {
        // Avoid an extra metadata lookup to get the publication times
        req.headers.accept = 'application/json';
      }
    }
    const upstreamRequestOptions = {
      encrypted: req.socket.encrypted,
      headers: req.headers,
      method: req.method,
      host,
      // default the port to HTTP values if not set
      port: port || (req.socket.encrypted ? 443 : 80),
      path: req.url,
      body,
      metadata
    };

    let responseResult;
    try {
      responseResult = await performRequest(upstreamRequestOptions);
    } catch (err) {
      clientSocket.emit('error', err);
      return;
    }

    setImmediate(async () => {
      if (
        couldBePackageMetadataRequest &&
        /json/.test(responseResult.headers['content-type'])
      ) {
        const obj = JSON.parse(responseResult.body.toString('utf-8'));
        let timeByVersion = obj.time;
        if (
          !timeByVersion &&
          upstreamRequestOptions.headers.accept &&
          upstreamRequestOptions.headers.accept.includes(
            'application/vnd.npm.install-v1+json'
          )
        ) {
          upstreamRequestOptions.headers = {
            ...upstreamRequestOptions.headers,
            accept: 'application/json'
          };
          bypassNextConnect = true;

          const fullMetadataResult = await performRequest(
            upstreamRequestOptions
          );
          timeByVersion = JSON.parse(fullMetadataResult.body.toString('utf-8'))
            .time;
        }

        if (timeByVersion) {
          updateTimeline(obj.name, timeByVersion);
        }
        const changesMade = removeVersionsFromPackageMetadata(
          obj,
          timeByVersion
        );

        if (changesMade) {
          responseResult.body = Buffer.from(
            JSON.stringify(obj, undefined, '  ')
          );
          responseResult.headers['content-length'] = String(
            responseResult.body.length
          );
          delete responseResult.headers['transfer-encoding'];
          delete responseResult.headers['content-encoding'];
          responseResult.headers.connection = 'close';
        }
      }
      res.statusCode = responseResult.statusCode;
      for (const headerName of Object.keys(responseResult.headers)) {
        res.setHeader(headerName, responseResult.headers[headerName]);
      }
      res.end(responseResult.body);
    });
  });

if (process.env.NPM_BISECT_COMPUTE_TIMELINE) {
  const processExit = process.exit;
  process.exit = exitCode => {
    timeline.sort((a, b) => {
      return a.time.getTime() - b.time.getTime();
    });
    const uniquetimeline = uniqBy(
      timeline,
      ({ packageName, version }) => `${packageName}@${version}`
    );

    console.error(
      `\nNPM_BISECT_COMPUTE_TIMELINE:${JSON.stringify(uniquetimeline)}`
    );
    // Don't exit until stderr has been fully flushed to avoid losing output:
    process.stderr.on('drain', () => processExit.call(process, exitCode));
  };
}

// Run the wrapped executable:
require('spawn-wrap').runMain();
