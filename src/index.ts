import dotenv from 'dotenv';
dotenv.config();

import { FastifyInstance } from 'fastify';
import { pool } from './db/pool';
import { buildApp } from './app';

let server: FastifyInstance | null = null;

async function start() {
  try {
    server = await buildApp();

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
    server?.log?.error(err);
    await pool.end();
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  await pool.end();
  if (server) await server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await pool.end();
  if (server) await server.close();
  process.exit(0);
});

start();

