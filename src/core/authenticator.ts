import { importSPKI, jwtVerify } from 'jose';
import type { Authenticator, AuthResult, GetHeader } from './types';

export interface JwtAuthenticatorOptions {
  publicKey: string;
  issuer: string;
  audience: string;
}

export class JwtAuthenticator implements Authenticator {
  private publicKeyPem: string;
  private issuer: string;
  private audience: string;

  constructor(opts: JwtAuthenticatorOptions) {
    this.publicKeyPem = opts.publicKey;
    this.issuer = opts.issuer;
    this.audience = opts.audience;
  }

  async authenticate(getHeader: GetHeader): Promise<AuthResult> {
    const authHeader = getHeader('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return { authenticated: false, error: 'Token Bearer no encontrado' };
    }

    const token = authHeader.slice(7);

    try {
      const publicKey = await importSPKI(this.publicKeyPem, 'RS256');
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: this.issuer,
        audience: this.audience,
      });

      return {
        authenticated: true,
        claims: payload as Record<string, unknown>,
      };
    } catch (err) {
      return {
        authenticated: false,
        error: err instanceof Error ? err.message : 'Error al verificar el token',
      };
    }
  }
}
