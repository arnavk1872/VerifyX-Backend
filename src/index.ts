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
import { supportRoutes } from './routes/support';
import { verifyxbotRoutes } from './routes/verifyxbot';
import { sdkRoutes } from './sdk/routes';
import { jobQueue } from './services/queue/job-queue';
import { processVerification } from './services/ai/processor';

const server = Fastify({
  logger: true,
  bodyLimit: 10485760,
});

server.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  try {
    const json = body === '' ? {} : JSON.parse(body as string);
    done(null, json);
  } catch (err) {
    done(err as Error, undefined);
  }
});

async function start() {
  try {
    jobQueue.register('process_verification', async (data: { verificationId: string }) => {
      await processVerification(data.verificationId);
    });

    await server.register(cors, {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });
    
    await server.register(helmet, {
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "https:"],
          frameSrc: ["'self'", "*"],
        },
      },
    });
    setupAuth(server);
    await server.register(authRoutes);
    await server.register(dashboardRoutes);
    await server.register(apiKeyRoutes);
    await server.register(supportRoutes);
    await server.register(verifyxbotRoutes);
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

