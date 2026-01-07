<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Auth;

use RuntimeException;

final class KeycloakJwt
{
    private string $issuer;

    private string $jwksUrl;

    private string $clientId;

    private int $jwksCacheTtlSeconds;

    private int $httpTimeoutSeconds;

    private static ?array $jwksCache = null;

    private static int $jwksCacheFetchedAt = 0;

    public function __construct(string $issuer, string $jwksUrl, string $clientId, int $jwksCacheTtlSeconds = 300, int $httpTimeoutSeconds = 2)
    {
        $this->issuer = $issuer;
        $this->jwksUrl = $jwksUrl;
        $this->clientId = $clientId;
        $this->jwksCacheTtlSeconds = $jwksCacheTtlSeconds;
        $this->httpTimeoutSeconds = $httpTimeoutSeconds;
    }

    public static function fromEnv(): self
    {
        $baseUrl = (string)getenv('KEYCLOAK_BASE_URL');
        $realm = (string)getenv('KEYCLOAK_REALM');
        $clientId = (string)getenv('KEYCLOAK_CLIENT_ID');

        if ($baseUrl === '' || $realm === '' || $clientId === '') {
            throw new RuntimeException('KEYCLOAK_BASE_URL, KEYCLOAK_REALM, and KEYCLOAK_CLIENT_ID must be set');
        }

        $baseUrl = rtrim($baseUrl, '/');
        $issuer = $baseUrl . '/realms/' . rawurlencode($realm);

        $jwksUrl = (string)getenv('KEYCLOAK_JWKS_URL');
        if ($jwksUrl === '') {
            $jwksUrl = $issuer . '/protocol/openid-connect/certs';
        }

        return new self($issuer, $jwksUrl, $clientId);
    }

    public function verifyAndDecode(string $jwt): array
    {
        /** @var array{0: array<array-key, mixed>, 1: array<array-key, mixed>, 2: string, 3: string} $parsed */
        $parsed = $this->parseJwt($jwt);
        [$header, $payload, $signature, $signedData] = $parsed;

        $alg = $header['alg'] ?? '';
        if (!is_string($alg) || $alg !== 'RS256') {
            throw new RuntimeException('unsupported JWT alg');
        }

        $kid = $header['kid'] ?? '';
        if (!is_string($kid) || $kid === '') {
            throw new RuntimeException('missing JWT kid');
        }

        $pubKey = $this->getPublicKeyPemForKid($kid);
        $ok = openssl_verify($signedData, $signature, $pubKey, OPENSSL_ALGO_SHA256);
        if ($ok !== 1) {
            throw new RuntimeException('invalid JWT signature');
        }

        $iss = $payload['iss'] ?? '';
        if (!is_string($iss) || $iss !== $this->issuer) {
            throw new RuntimeException('invalid JWT issuer');
        }

        $exp = $payload['exp'] ?? 0;
        $expInt = is_int($exp) ? $exp : (is_numeric($exp) ? (int)$exp : 0);
        if ($expInt <= time()) {
            throw new RuntimeException('JWT is expired');
        }

        $audOk = $this->audContainsClientId($payload['aud'] ?? null);
        if (!$audOk) {
            throw new RuntimeException('invalid JWT audience');
        }

        /** @var array<array-key, mixed> $payload */
        return $payload;
    }

    private function audContainsClientId(mixed $aud): bool
    {
        if (is_string($aud)) {
            return $aud === $this->clientId;
        }

        if (is_array($aud)) {
            foreach ($aud as $a) {
                if (is_string($a) && $a === $this->clientId) {
                    return true;
                }
            }
            return false;
        }

        return false;
    }

    /** @return array{0: array<array-key, mixed>, 1: array<array-key, mixed>, 2: string, 3: string} */
    private function parseJwt(string $jwt): array
    {
        $parts = explode('.', $jwt);
        if (count($parts) !== 3) {
            throw new RuntimeException('invalid JWT format');
        }

        [$h64, $p64, $s64] = $parts;
        $headerJson = $this->base64UrlDecode($h64);
        $payloadJson = $this->base64UrlDecode($p64);
        $signature = $this->base64UrlDecodeBinary($s64);

        $header = json_decode($headerJson, true);
        $payload = json_decode($payloadJson, true);

        if (!is_array($header) || !is_array($payload)) {
            throw new RuntimeException('invalid JWT JSON');
        }

        return [$header, $payload, $signature, $h64 . '.' . $p64];
    }

    private function base64UrlDecode(string $value): string
    {
        $decoded = $this->base64UrlDecodeBinary($value);
        if ($decoded === '') {
            return '';
        }
        return $decoded;
    }

    private function base64UrlDecodeBinary(string $value): string
    {
        $value = str_replace(['-', '_'], ['+', '/'], $value);
        $padLen = (4 - (strlen($value) % 4)) % 4;
        if ($padLen > 0) {
            $value .= str_repeat('=', $padLen);
        }

        $decoded = base64_decode($value, true);
        if (!is_string($decoded)) {
            return '';
        }
        return $decoded;
    }

    private function getPublicKeyPemForKid(string $kid): string
    {
        $jwks = $this->getJwks();
        $keys = $jwks['keys'] ?? [];
        if (!is_array($keys)) {
            throw new RuntimeException('invalid JWKS');
        }

        foreach ($keys as $jwk) {
            if (!is_array($jwk)) {
                continue;
            }

            $jwkKid = $jwk['kid'] ?? '';
            if (!is_string($jwkKid) || $jwkKid !== $kid) {
                continue;
            }

            $x5c = $jwk['x5c'] ?? null;
            if (is_array($x5c) && isset($x5c[0]) && is_string($x5c[0]) && $x5c[0] !== '') {
                $pem = "-----BEGIN CERTIFICATE-----\n" . chunk_split($x5c[0], 64, "\n") . "-----END CERTIFICATE-----\n";
                $pub = openssl_pkey_get_public($pem);
                if ($pub === false) {
                    throw new RuntimeException('invalid x5c certificate');
                }

                $details = openssl_pkey_get_details($pub);
                if (!is_array($details)) {
                    throw new RuntimeException('could not read public key');
                }

                $key = $details['key'] ?? '';
                if (!is_string($key) || $key === '') {
                    throw new RuntimeException('public key not found');
                }

                return $key;
            }

            throw new RuntimeException('unsupported JWKS key format (missing x5c)');
        }

        throw new RuntimeException('kid not found in JWKS');
    }

    private function getJwks(): array
    {
        $now = time();
        if (self::$jwksCache !== null && ($now - self::$jwksCacheFetchedAt) < $this->jwksCacheTtlSeconds) {
            return self::$jwksCache;
        }

        $context = stream_context_create([
            'http' => [
                'timeout' => $this->httpTimeoutSeconds,
            ],
        ]);

        $raw = @file_get_contents($this->jwksUrl, false, $context);
        if (!is_string($raw) || $raw === '') {
            throw new RuntimeException('could not fetch JWKS');
        }

        $jwks = json_decode($raw, true);
        if (!is_array($jwks)) {
            throw new RuntimeException('invalid JWKS JSON');
        }

        self::$jwksCache = $jwks;
        self::$jwksCacheFetchedAt = $now;

        return $jwks;
    }
}
