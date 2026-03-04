<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Auth\Cookies;
use Paith\Notes\Api\Http\Auth\KeycloakOAuth;
use Paith\Notes\Api\Http\Auth\SessionCrypto;
use Paith\Notes\Api\Http\Auth\SessionStore;
use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\RedirectResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Api\Http\Middleware\RequireUser;
use Paith\Notes\Api\Http\Auth\KeycloakJwt;
use RuntimeException;

final class AuthController
{
    public function check(Request $request, Context $context): Response
    {
        if ((string)getenv('KEYCLOAK_ENABLED') !== '1') {
            return JsonResponse::ok(['ok' => true]);
        }

        try {
            $sessionId = $this->sessionIdFromRequest($request);
            if ($sessionId === '') {
                return JsonResponse::error('not authenticated', 401);
            }

            $pdo = $context->pdo();
            $session = SessionStore::getSession($pdo, $sessionId);
            $crypto = SessionCrypto::fromEnv();
            $payloadJson = $crypto->decrypt($session['token_encrypted']);
            $payload = json_decode($payloadJson, true);
            if (!is_array($payload)) {
                return JsonResponse::error('invalid session', 401);
            }

            $access = $payload['access_token'] ?? '';
            if (!is_string($access) || trim($access) === '') {
                return JsonResponse::error('invalid session', 401);
            }

            $claims = KeycloakJwt::fromEnv()->verifyAndDecode($access);
            $mw = new RequireUser();
            $user = $mw->findOrCreateUserFromKeycloak($pdo, $claims);
            $context->setUser($user);
            SessionStore::touchSession($pdo, $sessionId);

            return JsonResponse::ok(['ok' => true]);
        } catch (HttpError $e) {
            return JsonResponse::error($e->getMessage(), $e->statusCode);
        } catch (RuntimeException $e) {
            return JsonResponse::error($e->getMessage(), 401);
        }
    }

    public function login(Request $request, Context $context): Response
    {
        if ((string)getenv('KEYCLOAK_ENABLED') !== '1') {
            return new RedirectResponse('/');
        }

        $redirectTo = $this->validateRedirect($request->queryParam('redirect'));

        $state = bin2hex(random_bytes(16));
        $codeVerifier = bin2hex(random_bytes(32));

        $pdo = $context->pdo();
        SessionStore::createAuthState($pdo, $state, $redirectTo, $codeVerifier, 600);

        $callbackUrl = $this->callbackUrlForRequest($request);
        $oauth = KeycloakOAuth::fromEnv();
        $codeChallenge = KeycloakOAuth::pkceCodeChallengeS256($codeVerifier);
        $authUrl = $oauth->authUrl($callbackUrl, $state, $codeChallenge);

        return new RedirectResponse($authUrl);
    }

    public function callback(Request $request, Context $context): Response
    {
        if ((string)getenv('KEYCLOAK_ENABLED') !== '1') {
            return new RedirectResponse('/');
        }

        $kcError = trim($request->queryParam('error'));
        if ($kcError !== '') {
            $desc = trim($request->queryParam('error_description'));
            $msg = $desc !== '' ? $desc : $kcError;
            return JsonResponse::error($msg, 400);
        }

        $code = trim($request->queryParam('code'));
        $state = trim($request->queryParam('state'));
        if ($code === '' || $state === '') {
            return JsonResponse::error('invalid callback', 400);
        }

        $pdo = $context->pdo();
        $stateData = SessionStore::consumeAuthState($pdo, $state);

        $callbackUrl = $this->callbackUrlForRequest($request);
        $oauth = KeycloakOAuth::fromEnv();
        $tokenPayload = $oauth->exchangeCode($code, $callbackUrl, $stateData['code_verifier']);

        $access = $tokenPayload['access_token'] ?? '';
        if (!is_string($access) || trim($access) === '') {
            return JsonResponse::error('missing access token', 400);
        }

        $claims = KeycloakJwt::fromEnv()->verifyAndDecode($access);
        $mw = new RequireUser();
        $user = $mw->findOrCreateUserFromKeycloak($pdo, $claims);
        $context->setUser($user);

        $ttl = 60 * 60 * 24 * 7;
        $crypto = SessionCrypto::fromEnv();
        $tokenEncrypted = $crypto->encrypt((string)json_encode($tokenPayload));
        $userId = is_scalar($user['id'] ?? null) ? (string)$user['id'] : '';
        if ($userId === '') {
            return JsonResponse::error('invalid user', 500);
        }
        $sessionId = SessionStore::createSession($pdo, $userId, $tokenEncrypted, $ttl);

        $secure = $this->isSecureRequest($request);
        $setCookie = Cookies::buildSetCookie(SessionStore::cookieName(), $sessionId, $ttl, $secure);

        return new RedirectResponse($stateData['redirect_to'], 302, [
            'Set-Cookie' => $setCookie,
        ]);
    }

    public function logout(Request $request, Context $context): Response
    {
        $sessionId = $this->sessionIdFromRequest($request);
        if ($sessionId !== '') {
            $pdo = $context->pdo();
            SessionStore::deleteSession($pdo, $sessionId);
        }

        $secure = $this->isSecureRequest($request);
        $clearCookie = Cookies::buildSetCookie(SessionStore::cookieName(), '', 0, $secure);

        return JsonResponse::ok(['ok' => true], 200)->withHeader('Set-Cookie', $clearCookie);
    }

    public function logoutRedirect(Request $request, Context $context): Response
    {
        $sessionId = $this->sessionIdFromRequest($request);
        if ($sessionId !== '') {
            $pdo = $context->pdo();
            SessionStore::deleteSession($pdo, $sessionId);
        }

        $secure = $this->isSecureRequest($request);
        $clearCookie = Cookies::buildSetCookie(SessionStore::cookieName(), '', 0, $secure);

        return new RedirectResponse('/', 302, [
            'Set-Cookie' => $clearCookie,
        ]);
    }

    public function logoutSsoRedirect(Request $request, Context $context): Response
    {
        $secure = $this->isSecureRequest($request);
        $clearCookie = Cookies::buildSetCookie(SessionStore::cookieName(), '', 0, $secure);

        if ((string)getenv('KEYCLOAK_ENABLED') !== '1') {
            return new RedirectResponse('/', 302, [
                'Set-Cookie' => $clearCookie,
            ]);
        }

        $sessionId = $this->sessionIdFromRequest($request);
        $idTokenHint = '';

        if ($sessionId !== '') {
            try {
                $pdo = $context->pdo();
                $session = SessionStore::getSession($pdo, $sessionId);
                $crypto = SessionCrypto::fromEnv();
                $payloadJson = $crypto->decrypt($session['token_encrypted']);
                $payload = json_decode($payloadJson, true);
                if (is_array($payload)) {
                    $id = $payload['id_token'] ?? '';
                    if (is_string($id)) {
                        $idTokenHint = trim($id);
                    }
                }
                SessionStore::deleteSession($pdo, $sessionId);
            } catch (RuntimeException) {
                // fall through
            }
        }

        $baseUrl = rtrim((string)getenv('KEYCLOAK_BASE_URL'), '/');
        $realm = (string)getenv('KEYCLOAK_REALM');

        if ($baseUrl === '' || $realm === '') {
            return new RedirectResponse('/', 302, [
                'Set-Cookie' => $clearCookie,
            ]);
        }

        $postLogout = $this->publicBaseUrlForRequest($request) . '/';
        $endSession = $baseUrl . '/realms/' . rawurlencode($realm) . '/protocol/openid-connect/logout';

        $params = [
            'post_logout_redirect_uri' => $postLogout,
        ];
        if ($idTokenHint !== '') {
            $params['id_token_hint'] = $idTokenHint;
        }

        $url = $endSession . '?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986);

        return new RedirectResponse($url, 302, [
            'Set-Cookie' => $clearCookie,
        ]);
    }

    private function callbackUrlForRequest(Request $request): string
    {
        return $this->publicBaseUrlForRequest($request) . '/api/auth/callback';
    }

    private function publicBaseUrlForRequest(Request $request): string
    {
        $envBase = trim((string)getenv('PUBLIC_BASE_URL'));
        if ($envBase !== '') {
            return rtrim($envBase, '/');
        }

        $host = trim($request->header('X-Forwarded-Host'));
        if ($host === '') {
            $host = trim($request->header('Host'));
        }
        if ($host === '') {
            $host = 'localhost:8000';
        }

        $proto = trim($request->header('X-Forwarded-Proto'));
        if ($proto === '') {
            $proto = 'http';
        }

        return $proto . '://' . $host;
    }

    private function isSecureRequest(Request $request): bool
    {
        $proto = strtolower(trim($request->header('X-Forwarded-Proto')));
        return $proto === 'https';
    }

    private function sessionIdFromRequest(Request $request): string
    {
        $cookieHeader = $request->header('Cookie');
        if ($cookieHeader === '') {
            return '';
        }
        $cookies = Cookies::parseCookieHeader($cookieHeader);
        $sid = $cookies[SessionStore::cookieName()] ?? '';
        return trim($sid);
    }

    private function validateRedirect(string $raw): string
    {
        $raw = trim($raw);
        if ($raw === '') {
            return '/';
        }
        if (!str_starts_with($raw, '/')) {
            return '/';
        }
        if (str_starts_with($raw, '//')) {
            return '/';
        }
        if (str_contains($raw, '\\')) {
            return '/';
        }
        return $raw;
    }
}
