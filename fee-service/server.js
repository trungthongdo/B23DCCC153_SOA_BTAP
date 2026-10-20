const express = require('express');
const http = require('http');
const { callBankCharge } = require('./bankClient');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.FEE_PORT || process.env.PORT || '4001', 10);
const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';

const initialStudents = () => ({
  '1': { id: '1', name: 'Sinh viên 1', debt: 50000000 },
  '2': { id: '2', name: 'Sinh viên 2', debt: 0 },
  '3': { id: '3', name: 'Sinh viên 3', debt: 3200000 }
});

let students = initialStudents();
let paymentSeq = 0;
const payments = new Map();

console.log('='.repeat(60));
console.log(`[FEE SERVICE] Initializing on port ${PORT}...`);
console.log(`[FEE SERVICE] BANK_URL configured as: ${BANK_URL}`);
console.log('='.repeat(60));

app.get('/students/:id/fees', (req, res) => {
  const student = students[req.params.id];
  if (!student) {
    return res.status(404).json({
      error: 'Student not found',
      studentId: req.params.id
    });
  }

  return res.status(200).json({
    studentId: student.id,
    name: student.name,
    debt: student.debt
  });
});

app.post('/students/:id/payments', async (req, res) => {
  const student = students[req.params.id];
  if (!student) {
    return res.status(404).json({
      error: 'Student not found',
      paymentId: null,
      status: 'FAILED',
      studentId: req.params.id
    });
  }

  const amount = Number(req.body.amount);
  if (!req.body.amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({
      error: 'Invalid payment amount',
      paymentId: null,
      status: 'FAILED',
      amount: req.body.amount
    });
  }

  if (amount > student.debt) {
    return res.status(400).json({
      error: 'Payment amount exceeds current debt',
      paymentId: null,
      status: 'FAILED',
      debt: student.debt,
      amount
    });
  }

  paymentSeq++;
  const paymentId = `P${paymentSeq}`;

  const paymentRecord = {
    paymentId,
    studentId: student.id,
    amount,
    status: 'INITIALIZED',
    createdAt: new Date().toISOString()
  };
  payments.set(paymentId, paymentRecord);

  console.log(`[FEE SERVICE] Processing payment ${paymentId} for student ${student.id}, amount=${amount}`);

  const result = await callBankCharge({
    bankUrl: process.env.BANK_URL || BANK_URL,
    reference: paymentId,
    amount,
    idempotencyKey: paymentId
  });

  paymentRecord.status = result.paymentStatus;
  paymentRecord.updatedAt = new Date().toISOString();

  if (result.paymentStatus === 'PAID') {
    student.debt -= amount;
    paymentRecord.chargeId = result.data.chargeId;

    console.log(`[FEE SERVICE] Payment ${paymentId} SUCCESS! Debt reduced to ${student.debt} VND`);
    return res.status(201).json({
      paymentId,
      status: 'PAID',
      amount,
      chargeId: result.data.chargeId,
      remainingDebt: student.debt
    });
  }

  console.log(`[FEE SERVICE] Payment ${paymentId} ended with HTTP ${result.httpStatus}, status=${result.paymentStatus}`);
  return res.status(result.httpStatus).json({
    error: result.error || 'Payment failed',
    paymentId,
    status: result.paymentStatus
  });
});

app.post('/students/reset', (req, res) => {
  students = initialStudents();
  paymentSeq = 0;
  payments.clear();
  res.json({ message: 'Fee service data reset successfully', students });
});

app.get('/payments/:id', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) {
    return res.status(404).json({ error: 'Payment not found' });
  }
  res.json(payment);
});

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`[FEE SERVICE] Running on http://localhost:${PORT}`);
});

module.exports = { app, server, students };
