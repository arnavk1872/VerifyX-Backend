import jwt from 'jsonwebtoken';
import { JWTPayload } from '../types/auth';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '604800';

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

const secret: string = JWT_SECRET;

export function generateToken(payload: JWTPayload): string {
  const expiresInValue = /^\d+$/.test(JWT_EXPIRES_IN) 
    ? parseInt(JWT_EXPIRES_IN, 10) 
    : (JWT_EXPIRES_IN as string);
  
  return jwt.sign(payload, secret, {
    expiresIn: expiresInValue,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    console.log('[JWT] Verifying token, secret exists:', !!secret);
    const decoded = jwt.verify(token, secret);
    console.log('[JWT] Token decoded successfully');
    
    if (typeof decoded === 'object' && decoded !== null && 'userId' in decoded) {
      const payload = decoded as any;
      console.log('[JWT] Payload has userId:', payload.userId);
      return {
        userId: payload.userId,
        organizationId: payload.organizationId,
        email: payload.email,
        role: payload.role || 'KYC_ADMIN',
      };
    }
    console.log('[JWT] Decoded token missing userId');
    return null;
  } catch (error: any) {
    console.error('[JWT] Verification error:', error.message, error.name);
    return null;
  }
}

