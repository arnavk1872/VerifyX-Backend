import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

const jwtSecret: string = JWT_SECRET;

export interface UploadTokenPayload {
  verificationId: string;
  organizationId: string;
  type: 'upload';
}

export function verifyUploadToken(token: string): UploadTokenPayload | null {
  try {
    const decoded = jwt.verify(token, jwtSecret) as any;
    
    if (decoded && decoded.verificationId && decoded.organizationId && decoded.type === 'upload') {
      return {
        verificationId: decoded.verificationId,
        organizationId: decoded.organizationId,
        type: 'upload',
      };
    }
    return null;
  } catch (error) {
    return null;
  }
}

