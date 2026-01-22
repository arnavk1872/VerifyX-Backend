import crypto from 'crypto';
import { hashPassword, verifyPassword } from './password';

const KEY_PREFIX_PUBLIC = 'pk_live_';
const KEY_PREFIX_SECRET = 'sk_live_';
const KEY_LENGTH = 32;

function generateRandomKey(): string {
  return crypto.randomBytes(KEY_LENGTH).toString('base64url').substring(0, KEY_LENGTH);
}

export function generateApiKeyPair(): { publicKey: string; secretKey: string } {
  const publicKey = KEY_PREFIX_PUBLIC + generateRandomKey();
  const secretKey = KEY_PREFIX_SECRET + generateRandomKey();
  return { publicKey, secretKey };
}

export async function hashSecretKey(secretKey: string): Promise<string> {
  return hashPassword(secretKey);
}

export async function verifySecretKey(secretKey: string, hash: string): Promise<boolean> {
  return verifyPassword(secretKey, hash);
}

export function isValidPublicKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX_PUBLIC) && key.length === KEY_PREFIX_PUBLIC.length + KEY_LENGTH;
}

export function isValidSecretKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX_SECRET) && key.length === KEY_PREFIX_SECRET.length + KEY_LENGTH;
}

