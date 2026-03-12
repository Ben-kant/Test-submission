import crypto from 'node:crypto';
import express from 'express';
import pkg from 'pg';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const { Pool } = pkg;

const app = express();
app.use(express.json());

const port = Number(process.env.PORT ?? 8080);
const queueUrl = process.env.QUEUE_URL;
const region = process.env.AWS_REGION;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 5,
  ssl: false,
});

const sqs = new SQSClient({ region });
let workerStarted = false;

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(100) PRIMARY KEY,
      customer_id VARCHAR(100) NOT NULL,
      status VARCHAR(30) NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function processMessage(message) {
  if (!message.Body || !message.ReceiptHandle) {
    return;
  }

  const payload = JSON.parse(message.Body);
  const orderId = String(payload.orderId ?? payload.id ?? crypto.randomUUID());
  const customerId = String(payload.customerId ?? 'unknown');
  const status = String(payload.status ?? 'RECEIVED');

  await pool.query(
    `
      INSERT INTO orders (id, customer_id, status, payload)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (id)
      DO UPDATE SET
        customer_id = EXCLUDED.customer_id,
        status = EXCLUDED.status,
        payload = EXCLUDED.payload
    `,
    [orderId, customerId, status, JSON.stringify(payload)],
  );

  await sqs.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: message.ReceiptHandle,
    }),
  );
}

async function pollQueue() {
  if (!queueUrl) {
    throw new Error('QUEUE_URL environment variable is required');
  }

  while (true) {
    try {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 60,
        }),
      );

      for (const message of response.Messages ?? []) {
        await processMessage(message);
      }
    } catch (error) {
      console.error('Queue polling error', error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/orders', async (_req, res) => {
  const result = await pool.query(
    'SELECT id, customer_id, status, created_at FROM orders ORDER BY created_at DESC LIMIT 50',
  );
  res.json(result.rows);
});

app.post('/orders', async (req, res) => {
  const payload = req.body;
  const orderId = String(payload.orderId ?? payload.id ?? crypto.randomUUID());
  const customerId = String(payload.customerId ?? 'manual');
  const status = String(payload.status ?? 'RECEIVED');

  await pool.query(
    `
      INSERT INTO orders (id, customer_id, status, payload)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (id)
      DO UPDATE SET
        customer_id = EXCLUDED.customer_id,
        status = EXCLUDED.status,
        payload = EXCLUDED.payload
    `,
    [orderId, customerId, status, JSON.stringify(payload)],
  );

  res.status(202).json({ message: 'accepted', orderId });
});

async function bootstrap() {
  await ensureSchema();

  app.listen(port, () => {
    console.log(`Order service listening on port ${port}`);
  });

  if (!workerStarted) {
    workerStarted = true;
    void pollQueue();
  }
}

bootstrap().catch((error) => {
  console.error('Fatal startup error', error);
  process.exit(1);
});
