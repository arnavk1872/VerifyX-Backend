export interface JWTPayload {
  userId: string;
  organizationId: string;
  email: string;
}

export interface AuthUser {
  userId: string;
  organizationId: string;
  email: string;
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

