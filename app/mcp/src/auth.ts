import type express from 'express';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';

export interface AuthContext {
  token: string;
  scopes: Set<string>;
}

let JWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let issuerCache: string | null = null;

export function initAuth(keycloakBaseUrl: string, realm: string): void {
  issuerCache = `${keycloakBaseUrl}/realms/${realm}`;
  JWKS = createRemoteJWKSet(new URL(`${issuerCache}/protocol/openid-connect/certs`));
}

export function getIssuer(): string {
  if (!issuerCache) throw new Error('auth not initialised');
  return issuerCache;
}

export async function extractToken(authHeader: string | undefined): Promise<AuthContext | null> {
  if (!JWKS || !issuerCache) throw new Error('auth not initialised');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    await jwtVerify(token, JWKS, { issuer: issuerCache });
    const payload = decodeJwt(token);
    const scopes = new Set(
      (typeof payload.scope === 'string' ? payload.scope : '').split(' ').filter(Boolean),
    );
    return { token, scopes };
  } catch {
    return null;
  }
}

export function unauthorized(res: express.Response, mcpServerUrl: string): void {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="${issuerCache}", resource_metadata="${mcpServerUrl}/.well-known/oauth-protected-resource"`,
  );
  res.status(401).json({ error: 'Unauthorized' });
}
