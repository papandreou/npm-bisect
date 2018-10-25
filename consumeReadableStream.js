module.exports = function consumeReadableStream(readableStream) {
  return new Promise(resolve => {
    const chunks = [];
    readableStream
      .on('data', chunk => {
        chunks.push(chunk);
      })
      .on('end', () => {
        resolve({ body: Buffer.concat(chunks) });
      })
      .on('error', err => {
        resolve({
          body: Buffer.concat(chunks),
          err
        });
      });
  });
};
