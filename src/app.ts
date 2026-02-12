import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { setupAuth } from './plugins/auth';
import { authRoutes } from './routes/auth';
import { dashboardRoutes } from './routes/dashboard';
import { apiKeyRoutes } from './routes/api-keys';
import { supportRoutes } from './routes/support';
import { verifyxbotRoutes } from './routes/verifyxbot';
import { sdkRoutes } from './sdk/routes';
import { jobQueue } from './services/queue/job-queue';
import { processVerification } from './services/ai/processor';

export interface BuildAppOptions {
  /** If true, register process_verification job handler. Default: true */
  registerJobHandler?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { registerJobHandler = true } = options;

  const server = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : true,
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

  if (registerJobHandler) {
    jobQueue.register('process_verification', async (data: { verificationId: string }) => {
      await processVerification(data.verificationId);
    });
  }

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

  return server;
}
