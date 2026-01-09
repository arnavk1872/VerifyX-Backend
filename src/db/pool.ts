import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.DB_CONNECTION_STRING) {
  throw new Error('DB_CONNECTION_STRING environment variable is required');
}

const poolConfig: PoolConfig = {
  connectionString: process.env.DB_CONNECTION_STRING,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT || '2000', 10),
};

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

