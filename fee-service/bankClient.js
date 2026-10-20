const http = require('http');
const { URL } = require('url');

const isKeepAliveEnabled = process.env.DISABLE_KEEP_ALIVE !== 'true';

const bankAgent = new http.Agent({
  keepAlive: isKeepAliveEnabled,
  keepAliveMsecs: 10000,
  maxSockets: 30,
  maxFreeSockets: 30,
  timeout: 30000
});

const REQUEST_TIMEOUT_MS = 4000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 100;
const TOTAL_DEADLINE_MS = 4300;

function sendSingleBankRequest(bankUrl, payload, idempotencyKey, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL('/charges', bankUrl);
    const postData = JSON.stringify(payload);

    let isTimeout = false;
    let timer = null;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 4002,
      path: parsedUrl.pathname,
      method: 'POST',
      agent: bankAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Idempotency-Key': idempotencyKey,
        'Connection': 'keep-alive'
      }
    };

    const req = http.request(options, (res) => {
      if (timer) clearTimeout(timer);

      let responseBody = '';
      res.on('data', (chunk) => {
        responseBody += chunk;
      });

      res.on('end', () => {
        let parsedData = {};
        try {
          if (responseBody) parsedData = JSON.parse(responseBody);
        } catch (e) {
          parsedData = { raw: responseBody };
        }

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: parsedData
        });
      });
    });

    timer = setTimeout(() => {
      isTimeout = true;
      req.destroy(new Error('REQUEST_TIMEOUT'));
    }, timeoutMs);

    req.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (isTimeout) {
        const timeoutErr = new Error(`Bank request timed out after ${timeoutMs}ms`);
        timeoutErr.code = 'REQUEST_TIMEOUT';
        return reject(timeoutErr);
      }
      return reject(err);
    });

    req.write(postData);
    req.end();
  });
}

async function callBankCharge({ bankUrl, reference, amount, idempotencyKey }) {
  const startTime = Date.now();
  let attempt = 0;
  let lastError = null;

  while (attempt <= MAX_RETRIES) {
    attempt++;
    const elapsed = Date.now() - startTime;
    const remainingTime = TOTAL_DEADLINE_MS - elapsed;

    if (remainingTime <= 500) {
      console.warn(`[BankClient] Deadline approaching (${elapsed}ms elapsed), aborting retries.`);
      return {
        httpStatus: 504,
        paymentStatus: 'PENDING',
        error: 'Payment pending - total processing deadline exceeded'
      };
    }

    const currentTimeout = Math.min(REQUEST_TIMEOUT_MS, remainingTime);

    try {
      console.log(`[BankClient] Attempt #${attempt} calling ${bankUrl}/charges for ref=${reference}, idempKey=${idempotencyKey}`);
      const res = await sendSingleBankRequest(
        bankUrl,
        { reference, amount },
        idempotencyKey,
        currentTimeout
      );

      if (res.statusCode === 201) {
        return {
          httpStatus: 201,
          paymentStatus: 'PAID',
          data: res.data
        };
      }

      if (res.statusCode >= 400 && res.statusCode < 500) {
        console.log(`[BankClient] Bank rejected with ${res.statusCode}: ${JSON.stringify(res.data)}`);
        return {
          httpStatus: res.statusCode,
          paymentStatus: 'FAILED',
          error: res.data.error || 'Bank rejected payment',
          data: res.data
        };
      }

      if (res.statusCode >= 500) {
        console.warn(`[BankClient] Bank returned ${res.statusCode} on attempt #${attempt}.`);
        if (attempt <= MAX_RETRIES) {
          const waitTime = Math.min(RETRY_DELAY_MS, TOTAL_DEADLINE_MS - (Date.now() - startTime));
          if (waitTime > 0) await new Promise((r) => setTimeout(r, waitTime));
          continue;
        }
        return {
          httpStatus: 504,
          paymentStatus: 'PENDING',
          error: res.data.error || 'Bank internal error after retries',
          data: res.data
        };
      }
    } catch (err) {
      lastError = err;
      const errorDuration = Date.now() - startTime;
      console.warn(`[BankClient] Attempt #${attempt} failed after ${errorDuration}ms: ${err.code || err.message}`);

      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH') {
        console.log('[BankClient] Bank is offline/unreachable (ECONNREFUSED). Definitively not charged.');
        return {
          httpStatus: 503,
          paymentStatus: 'FAILED',
          error: 'Bank unavailable (connection refused)'
        };
      }

      if (err.code === 'REQUEST_TIMEOUT') {
        console.log('[BankClient] Bank request timed out. Status ambiguous -> 504 PENDING.');
        return {
          httpStatus: 504,
          paymentStatus: 'PENDING',
          error: 'Bank request timed out'
        };
      }

      const isConnectionDrop =
        err.code === 'ECONNRESET' ||
        err.code === 'EPIPE' ||
        (err.message && err.message.includes('socket hang up'));

      if (isConnectionDrop && attempt <= MAX_RETRIES) {
        console.log(`[BankClient] Connection dropped (possible DROP_RATE). Retrying with Idempotency-Key...`);
        const waitTime = Math.min(RETRY_DELAY_MS, TOTAL_DEADLINE_MS - (Date.now() - startTime));
        if (waitTime > 0) await new Promise((r) => setTimeout(r, waitTime));
        continue;
      }

      return {
        httpStatus: 504,
        paymentStatus: 'PENDING',
        error: `Connection lost while awaiting bank response (${err.message})`
      };
    }
  }

  return {
    httpStatus: 504,
    paymentStatus: 'PENDING',
    error: lastError ? lastError.message : 'Unknown payment status'
  };
}

module.exports = {
  callBankCharge,
  bankAgent
};
