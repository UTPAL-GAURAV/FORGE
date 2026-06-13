// Retry an async LLM call up to maxAttempts on 429/503, with exponential backoff.
async function withRetry(fn, maxAttempts = 3, baseDelayMs = 1500) {
  let lastErr
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const status = err.response?.status
      if ((status === 429 || status === 503) && attempt < maxAttempts - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        await new Promise(r => setTimeout(r, delay))
        lastErr = err
        continue
      }
      throw err
    }
  }
  throw lastErr
}

module.exports = { withRetry }
