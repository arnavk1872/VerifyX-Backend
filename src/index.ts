import dotenv from 'dotenv';
dotenv.config();

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { pool } from './db/pool';
import { setupAuth } from './plugins/auth';
import { authRoutes } from './routes/auth';
import { dashboardRoutes } from './routes/dashboard';
import { apiKeyRoutes } from './routes/api-keys';
import { sdkRoutes } from './sdk/routes';
import { jobQueue } from './services/queue/job-queue';
import { processVerification } from './services/ai/processor';

const server = Fastify({
  logger: true,
});

async function start() {
  try {
    jobQueue.register('process_verification', async (data: { verificationId: string }) => {
      await processVerification(data.verificationId);
    });

    await server.register(cors);
    await server.register(helmet);
    setupAuth(server);
    await server.register(authRoutes);
    await server.register(dashboardRoutes);
    await server.register(apiKeyRoutes);
    await server.register(sdkRoutes);

    server.get('/health', async () => {
      return { status: 'ok', timestamp: new Date().toISOString() };
    });

    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    console.log('Connected to PostgreSQL database');

    await server.listen({
      port: parseInt(process.env.PORT || '8000', 10),
      host: process.env.HOST || '0.0.0.0',
    });

    console.log(`Server listening on port ${process.env.PORT || '8000'}`);
  } catch (err) {
    server.log.error(err);
    await pool.end();
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  await pool.end();
  await server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await pool.end();
  await server.close();
  process.exit(0);
});

start();

