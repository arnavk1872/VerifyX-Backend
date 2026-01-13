export type UserRole = 'KYC_ADMIN' | 'SUPER_ADMIN' | 'AUDITOR';

export interface JWTPayload {
  userId: string;
  organizationId: string;
  email: string;
  role: UserRole;
}

export interface AuthUser {
  userId: string;
  organizationId: string;
  email: string;
  role: UserRole;
}

export interface SignupBody {
  organization_name: string;
  email: string;
  password: string;
}

export interface LoginBody {
  email: string;
  password: string;
}

