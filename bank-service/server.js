const express = require('express');
const http = require('http');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.BANK_PORT || process.env.PORT || '4002', 10);

const stats = {
  connections: 0,
  requests: 0,
  charges: 0,
  duplicates: 0
};

const chargesByRef = new Map();
const idempotencyStore = new Map();
let chargeSequence = 0;

const DELAY_MS = parseInt(process.env.DELAY_MS || '0', 10);
const FAIL_RATE = parseFloat(process.env.FAIL_RATE || '0');
const DROP_RATE = parseFloat(process.env.DROP_RATE || '0');

console.log('='.repeat(60));
console.log(`[BANK SERVICE] Initializing on port ${PORT}...`);
console.log(`[BANK CONFIG] DELAY_MS  : ${DELAY_MS} ms`);
console.log(`[BANK CONFIG] FAIL_RATE : ${FAIL_RATE}`);
console.log(`[BANK CONFIG] DROP_RATE : ${DROP_RATE}`);
console.log('='.repeat(60));

app.get('/stats', (req, res) => {
  res.json({
    connections: stats.connections,
    requests: stats.requests,
    charges: stats.charges,
    duplicates: stats.duplicates
  });
});

app.post('/stats/reset', (req, res) => {
  stats.connections = 0;
  stats.requests = 0;
  stats.charges = 0;
  stats.duplicates = 0;
  chargesByRef.clear();
  idempotencyStore.clear();
  chargeSequence = 0;
  res.json({ message: 'Stats and charges reset successfully', stats });
});

app.post('/charges', async (req, res) => {
  stats.requests++;
  const { reference, amount } = req.body;
  const idempotencyKey = req.headers['idempotency-key'] || reference;

  if (DELAY_MS > 0) {
    console.log(`[BANK] Applying DELAY_MS = ${DELAY_MS}ms for reference=${reference}`);
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  const numAmount = Number(amount);
  if (!amount || isNaN(numAmount) || numAmount <= 0) {
    console.log(`[BANK] 400 Bad Request: Invalid amount (${amount}) for reference=${reference}`);
    return res.status(400).json({
      error: 'Invalid amount',
      code: 'INVALID_AMOUNT'
    });
  }

  if (numAmount > 20000000) {
    console.log(`[BANK] 402 Payment Required: Amount ${numAmount} exceeds limit 20.000.000đ for reference=${reference}`);
    return res.status(402).json({
      error: 'Amount exceeds transaction limit of 20,000,000 VND',
      code: 'LIMIT_EXCEEDED'
    });
  }

  if (idempotencyKey && idempotencyStore.has(idempotencyKey)) {
    const cached = idempotencyStore.get(idempotencyKey);
    console.log(`[BANK] Idempotency hit: key=${idempotencyKey}, returning previous chargeId=${cached.body.chargeId}`);
    return res.status(cached.statusCode).json(cached.body);
  }

  if (reference && chargesByRef.has(reference)) {
    stats.duplicates++;
    console.warn(`[BANK ALARM] DUPLICATE CHARGE DETECTED for reference=${reference}! Total duplicates=${stats.duplicates}`);
  }

  if (FAIL_RATE > 0 && Math.random() < FAIL_RATE) {
    console.log(`[BANK] Simulated FAIL_RATE (500) triggered before charging reference=${reference}`);
    return res.status(500).json({
      error: 'Bank internal error (simulated temporary failure)',
      code: 'BANK_INTERNAL_ERROR'
    });
  }

  chargeSequence++;
  const chargeId = `CHG_${chargeSequence}_${Date.now()}`;
  stats.charges++;

  const chargeRecord = {
    chargeId,
    reference,
    amount: numAmount,
    createdAt: new Date().toISOString()
  };
  chargesByRef.set(reference, chargeRecord);

  const responseBody = {
    chargeId,
    reference,
    amount: numAmount,
    status: 'SUCCESS'
  };

  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, {
      statusCode: 201,
      body: responseBody
    });
  }

  if (DROP_RATE > 0 && Math.random() < DROP_RATE) {
    console.log(`[BANK] Simulated DROP_RATE: Charged ${chargeId} for reference=${reference}, destroying TCP socket now!`);
    req.socket.destroy();
    return;
  }

  console.log(`[BANK] Charge SUCCESS: ${chargeId} for reference=${reference}, amount=${numAmount}`);
  return res.status(201).json(responseBody);
});

const server = http.createServer(app);

server.keepAliveTimeout = 5000;
server.headersTimeout = 6000;

server.on('connection', (socket) => {
  stats.connections++;
  console.log(`[BANK TCP] New TCP connection #${stats.connections} from ${socket.remoteAddress}:${socket.remotePort}`);
});

server.listen(PORT, () => {
  console.log(`[BANK SERVICE] Running on http://localhost:${PORT}`);
});

module.exports = { app, server, stats };
