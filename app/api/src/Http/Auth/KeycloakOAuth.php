<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Auth;

use Paith\Notes\Shared\Env;
use RuntimeException;

final class KeycloakOAuth
{
    private string $baseUrl;
    private string $realm;
    private string $clientId;
    private string $clientSecret;

    public function __construct(string $baseUrl, string $realm, string $clientId, string $clientSecret)
    {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->realm = $realm;
        $this->clientId = $clientId;
        $this->clientSecret = $clientSecret;
    }

    public static function fromEnv(): self
    {
        return new self(
            Env::require('KEYCLOAK_BASE_URL'),
            Env::require('KEYCLOAK_REALM'),
            Env::require('KEYCLOAK_CLIENT_ID'),
            Env::get('KEYCLOAK_CLIENT_SECRET')
        );
    }

    public function issuer(): string
    {
        return $this->baseUrl . '/realms/' . rawurlencode($this->realm);
    }

    public static function pkceCodeChallengeS256(string $codeVerifier): string
    {
        $hash = hash('sha256', $codeVerifier, true);
        $b64 = base64_encode($hash);
        return rtrim(strtr($b64, '+/', '-_'), '=');
    }

    public function authUrl(
        string $redirectUri,
        string $state,
        string $codeChallenge,
        string $codeChallengeMethod = 'S256',
        string $scope = 'openid profile email'
    ): string {
        $endpoint = $this->issuer() . '/protocol/openid-connect/auth';
        $query = http_build_query([
            'client_id' => $this->clientId,
            'response_type' => 'code',
            'redirect_uri' => $redirectUri,
            'scope' => $scope,
            'state' => $state,
            'code_challenge' => $codeChallenge,
            'code_challenge_method' => $codeChallengeMethod,
        ], '', '&', PHP_QUERY_RFC3986);

        return $endpoint . '?' . $query;
    }

    /** @return array<string, mixed> */
    public function exchangeCode(string $code, string $redirectUri, string $codeVerifier): array
    {
        $tokenUrl = $this->issuer() . '/protocol/openid-connect/token';

        $params = [
            'grant_type' => 'authorization_code',
            'client_id' => $this->clientId,
            'code' => $code,
            'redirect_uri' => $redirectUri,
            'code_verifier' => $codeVerifier,
        ];
        if ($this->clientSecret !== '') {
            $params['client_secret'] = $this->clientSecret;
        }

        $body = http_build_query($params, '', '&', PHP_QUERY_RFC3986);

        $ctx = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/x-www-form-urlencoded\r\nAccept: application/json\r\n",
                'content' => $body,
                'timeout' => 5,
                'ignore_errors' => true,
            ],
        ]);

        $raw = @file_get_contents($tokenUrl, false, $ctx);
        if (!is_string($raw)) {
            throw new RuntimeException('failed to call token endpoint');
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            throw new RuntimeException('invalid token endpoint response');
        }

        if (!array_key_exists('access_token', $decoded)) {
            $err = is_string($decoded['error_description'] ?? null) ? (string)$decoded['error_description'] : 'token exchange failed';
            throw new RuntimeException($err);
        }

        /** @var array<string, mixed> $decoded */
        return $decoded;
    }

    /** @return array<string, mixed> */
    public function refreshToken(string $refreshToken): array
    {
        $tokenUrl = $this->issuer() . '/protocol/openid-connect/token';

        $params = [
            'grant_type' => 'refresh_token',
            'client_id' => $this->clientId,
            'refresh_token' => $refreshToken,
        ];
        if ($this->clientSecret !== '') {
            $params['client_secret'] = $this->clientSecret;
        }

        $body = http_build_query($params, '', '&', PHP_QUERY_RFC3986);

        $ctx = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/x-www-form-urlencoded\r\nAccept: application/json\r\n",
                'content' => $body,
                'timeout' => 5,
                'ignore_errors' => true,
            ],
        ]);

        $raw = @file_get_contents($tokenUrl, false, $ctx);
        if (!is_string($raw)) {
            throw new RuntimeException('failed to call token endpoint');
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            throw new RuntimeException('invalid token endpoint response');
        }

        if (!array_key_exists('access_token', $decoded)) {
            $err = is_string($decoded['error_description'] ?? null) ? (string)$decoded['error_description'] : 'token refresh failed';
            throw new RuntimeException($err);
        }

        /** @var array<string, mixed> $decoded */
        return $decoded;
    }
}
