// Global serial queue for Featherless API calls.
// Their plan limit is 4 units and every model costs 4 units — only 1 request at a time.
let _queue = Promise.resolve()

function featherlessSerial(fn) {
  const result = _queue.then(() => fn())
  // Chain on the settled promise so a failure doesn't block the queue
  _queue = result.then(() => {}, () => {})
  return result
}

module.exports = { featherlessSerial }
