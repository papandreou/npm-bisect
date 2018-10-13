const mitm = require('mitm-papandreou')();

const http = require('http');
const https = require('https');
const pick = require('lodash.pick');

const metadataPropertyNames = [
  ...require('messy').HttpRequest.metadataPropertyNames,
  'rejectUnauthorized'
];

const ignoreNewerThan = new Date(process.env.NPM_BISECT_IGNORE_NEWER_THAN);

function consumeReadableStream(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream
      .on('data', chunk => {
        chunks.push(chunk);
      })
      .on('end', chunk => {
        resolve({ body: Buffer.concat(chunks) });
      })
      .on('error', err => {
        resolve({
          body: Buffer.concat(chunks),
          error: err
        });
      });
  });
}

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
            if (result.error) {
              // TODO: Consider adding support for recording this (the upstream response erroring out while we're recording it)
              return reject(result.error);
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
      if (version !== 'modified' && version !== 'changed') {
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

let bypassNextConnect = false;
mitm
  .on('connect', (socket, opts) => {
    if (bypassNextConnect) {
      socket.bypass();
      bypassNextConnect = false;
    } else if (opts.servername === 'registry.npmjs.org') {
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

    const { body, error } = await consumeReadableStream(req);

    if (error) {
      throw error;
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
    if (host === 'registry.npmjs.org') {
      delete req.headers['accept-encoding']; // Save the trouble of decoding gzip/brotli/deflate
      delete req.headers['if-none-match']; // Avoid 304s so we don't get to patch up the response
      delete req.headers.connection;
      couldBePackageMetadataRequest = true;
      if (
        req.url === '/messy' &&
        req.headers.accept ===
          'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'
      ) {
        req.headers.accept = 'application/json';
      }
    }
    try {
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

      const responseResult = await performRequest(upstreamRequestOptions);

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
            timeByVersion = JSON.parse(
              fullMetadataResult.body.toString('utf-8')
            ).time;
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
    } catch (err) {
      clientSocket.emit('error', err);
    }
  });

// Run the wrapped executable:
require('spawn-wrap').runMain();
