<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Middleware;

use Paith\Notes\Api\Http\Auth\Cookies;
use Paith\Notes\Api\Http\Auth\KeycloakOAuth;
use Paith\Notes\Api\Http\Auth\KeycloakJwt;
use Paith\Notes\Api\Http\Auth\SessionCrypto;
use Paith\Notes\Api\Http\Auth\SessionStore;
use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\Middleware;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use PDO;
use RuntimeException;
use Throwable;

final class RequireUser implements Middleware
{
    private static function debugEnabled(): bool
    {
        return (string)getenv('DEBUG_AUTH') === '1';
    }

    private static function debugLog(string $message, array $data = []): void
    {
        if (!self::debugEnabled()) {
            return;
        }

        $suffix = $data === [] ? '' : ' ' . (json_encode($data) ?: '');
        @file_put_contents('php://stderr', '[auth] ' . $message . $suffix . "\n");
    }

    public function handle(Request $request, Context $context, callable $next): Response
    {
        if ((string)getenv('KEYCLOAK_ENABLED') === '1') {
            self::debugLog('RequireUser keycloak enabled');
            $jwt = '';
            $sid = '';
            $sessionPayload = null;

            $cookieHeader = $request->header('Cookie');
            if ($cookieHeader !== '') {
                $cookies = Cookies::parseCookieHeader($cookieHeader);
                $sid = $cookies[SessionStore::cookieName()] ?? '';
                $sid = trim($sid);
                if ($sid !== '') {
                    try {
                        $pdo = $context->pdo();
                        $session = SessionStore::getSession($pdo, $sid);
                        $crypto = SessionCrypto::fromEnv();
                        $payloadJson = $crypto->decrypt($session['token_encrypted']);
                        $payload = json_decode($payloadJson, true);
                        if (is_array($payload)) {
                            $sessionPayload = $payload;
                            $access = $payload['access_token'] ?? '';
                            if (is_string($access) && trim($access) !== '') {
                                $jwt = trim($access);
                                SessionStore::touchSession($pdo, $sid);
                            }
                        }
                    } catch (RuntimeException) {
                        $jwt = '';
                    }
                }
            }

            if ($jwt === '') {
                $auth = trim($request->header('Authorization'));
                if (!str_starts_with($auth, 'Bearer ')) {
                    throw new HttpError('not authenticated', 401);
                }

                $jwt = trim(substr($auth, strlen('Bearer ')));
                if ($jwt === '') {
                    throw new HttpError('not authenticated', 401);
                }
            }

            try {
                $claims = KeycloakJwt::fromEnv()->verifyAndDecode($jwt);
            } catch (RuntimeException $e) {
                $msg = $e->getMessage();
                $canRefresh = $sid !== '' && is_array($sessionPayload);
                if ($canRefresh && $msg === 'JWT is expired') {
                    $refresh = $sessionPayload['refresh_token'] ?? '';
                    if (is_string($refresh) && trim($refresh) !== '') {
                        $didRecover = false;
                        $pdo = $context->pdo();
                        $crypto = SessionCrypto::fromEnv();
                        $oauth = KeycloakOAuth::fromEnv();

                        $pdo->beginTransaction();
                        try {
                            $locked = SessionStore::getSessionForUpdate($pdo, $sid);
                            $payloadJson2 = $crypto->decrypt($locked['token_encrypted']);
                            $payload2 = json_decode($payloadJson2, true);
                            $payloadArr = is_array($payload2) ? $payload2 : [];

                            $access2 = $payloadArr['access_token'] ?? '';
                            $access2 = is_string($access2) ? trim($access2) : '';

                            if ($access2 !== '') {
                                try {
                                    $claims = KeycloakJwt::fromEnv()->verifyAndDecode($access2);
                                    SessionStore::touchSession($pdo, $sid);
                                    $pdo->commit();
                                    $didRecover = true;
                                } catch (RuntimeException $e2) {
                                    if ($e2->getMessage() !== 'JWT is expired') {
                                        throw $e2;
                                    }
                                }
                            }

                            if ($didRecover) {
                                // Another request refreshed already while we waited on the row lock.
                                // Continue with the recovered claims.
                            } else {
                                $refresh2 = $payloadArr['refresh_token'] ?? '';
                                $refresh2 = is_string($refresh2) ? trim($refresh2) : '';
                                if ($refresh2 === '') {
                                    throw new RuntimeException('missing refresh token');
                                }

                                $newPayload = $oauth->refreshToken($refresh2);
                                if (!array_key_exists('refresh_token', $newPayload) && array_key_exists('refresh_token', $payloadArr)) {
                                    $newPayload['refresh_token'] = $payloadArr['refresh_token'];
                                }

                                $tokenEncrypted = $crypto->encrypt((string)json_encode($newPayload));
                                SessionStore::updateSessionTokenEncrypted($pdo, $sid, $tokenEncrypted);
                                SessionStore::touchSession($pdo, $sid);

                                $pdo->commit();

                                $accessNew = $newPayload['access_token'] ?? '';
                                $accessNew = is_string($accessNew) ? trim($accessNew) : '';
                                if ($accessNew === '') {
                                    throw new RuntimeException('missing access token');
                                }

                                $claims = KeycloakJwt::fromEnv()->verifyAndDecode($accessNew);
                                $didRecover = true;
                            }
                        } catch (Throwable $t) {
                            if ($pdo->inTransaction()) {
                                $pdo->rollBack();
                            }
                            throw new HttpError($t->getMessage(), 401);
                        }

                        // Continue with recovered $claims.
                    }
                }

                throw new HttpError($msg, 401);
            }

            $rawGroups = $claims['groups'] ?? null;
            $groupsClaim = is_array($rawGroups) ? $rawGroups : [];

            $realmRoles = [];
            $realmAccess = $claims['realm_access'] ?? null;
            if (is_array($realmAccess)) {
                $rr = $realmAccess['roles'] ?? null;
                if (is_array($rr)) {
                    $realmRoles = $rr;
                }
            }

            $clientId = trim((string)getenv('KEYCLOAK_CLIENT_ID'));
            $clientRoles = [];
            $resourceAccess = $claims['resource_access'] ?? null;
            if ($clientId !== '' && is_array($resourceAccess)) {
                $client = $resourceAccess[$clientId] ?? null;
                if (is_array($client)) {
                    $cr = $client['roles'] ?? null;
                    if (is_array($cr)) {
                        $clientRoles = $cr;
                    }
                }
            }

            $combined = [];
            foreach ([$groupsClaim, $realmRoles, $clientRoles] as $src) {
                foreach ($src as $v) {
                    if (is_string($v) && $v !== '') {
                        $combined[] = $v;
                    }
                }
            }
            $combined = array_values(array_unique($combined));

            self::debugLog('RequireUser token claims (summary)', [
                'iss' => is_string($claims['iss'] ?? null) ? (string)$claims['iss'] : null,
                'aud' => $claims['aud'] ?? null,
                'azp' => $claims['azp'] ?? null,
                'sub' => is_string($claims['sub'] ?? null) ? (string)$claims['sub'] : null,
                'preferred_username' => $claims['preferred_username'] ?? null,
                'client_id_env' => $clientId !== '' ? $clientId : null,
                'groups_claim_type' => gettype($rawGroups),
                'groups_claim_count' => count($groupsClaim),
                'groups_claim_sample' => array_slice($groupsClaim, 0, 10),
                'realm_roles_count' => count($realmRoles),
                'realm_roles_sample' => array_slice($realmRoles, 0, 10),
                'client_roles_count' => count($clientRoles),
                'client_roles_sample' => array_slice($clientRoles, 0, 10),
                'combined_membership_count' => count($combined),
                'combined_membership_sample' => array_slice($combined, 0, 10),
                'claim_keys' => array_slice(array_keys($claims), 0, 30),
            ]);

            $pdo = $context->pdo();
            $user = $this->findOrCreateUserFromKeycloak($pdo, $claims);
            $context->setUser($user);
        } else {
            self::debugLog('RequireUser keycloak disabled');
            $id = trim($request->header('X-Nook-User'));
            if ($id === '') {
                throw new HttpError('X-Nook-User header is required', 401);
            }

            if (!self::isUuid($id)) {
                throw new HttpError('X-Nook-User must be a UUID', 400);
            }

            $pdo = $context->pdo();
            $user = $this->findOrCreateUser($pdo, $id);
            $context->setUser($user);
        }

        return $next($request, $context);
    }

    public function findOrCreateUserFromKeycloak(PDO $pdo, array $claims): array
    {
        $sub = $claims['sub'] ?? '';
        if (!is_string($sub) || $sub === '') {
            throw new HttpError('missing token subject', 401);
        }

        $preferredUsername = $claims['preferred_username'] ?? '';
        $username = is_string($preferredUsername) ? trim($preferredUsername) : '';

        $givenName = $claims['given_name'] ?? '';
        $familyName = $claims['family_name'] ?? '';
        $firstName = is_string($givenName) ? trim($givenName) : '';
        $lastName = is_string($familyName) ? trim($familyName) : '';

        $nicknameRaw = $claims['nickname'] ?? '';
        $nickname = is_string($nicknameRaw) ? trim($nicknameRaw) : '';

        $emailRaw = $claims['email'] ?? '';
        $email = is_string($emailRaw) ? trim($emailRaw) : '';

        $emailVerifiedRaw = $claims['email_verified'] ?? false;
        $emailVerified = is_bool($emailVerifiedRaw) ? $emailVerifiedRaw : false;

        $groups = [];

        $rawGroups = $claims['groups'] ?? null;
        if (is_array($rawGroups)) {
            foreach ($rawGroups as $g) {
                if (is_string($g) && $g !== '') {
                    $groups[] = $g;
                }
            }
        }

        $realmAccess = $claims['realm_access'] ?? null;
        $realmRoles = null;
        if (is_array($realmAccess)) {
            $realmRoles = $realmAccess['roles'] ?? null;
            if (is_array($realmRoles)) {
                foreach ($realmRoles as $r) {
                    if (is_string($r) && $r !== '') {
                        $groups[] = $r;
                    }
                }
            }
        }

        $clientId = trim((string)getenv('KEYCLOAK_CLIENT_ID'));
        $resourceAccess = $claims['resource_access'] ?? null;
        $clientRoles = null;
        if ($clientId !== '' && is_array($resourceAccess)) {
            $client = $resourceAccess[$clientId] ?? null;
            if (is_array($client)) {
                $clientRoles = $client['roles'] ?? null;
                if (is_array($clientRoles)) {
                    foreach ($clientRoles as $r) {
                        if (is_string($r) && $r !== '') {
                            $groups[] = $r;
                        }
                    }
                }
            }
        }

        $groups = array_values(array_unique($groups));

        $stmt = $pdo->prepare('select id, first_name, last_name, username, email, email_verified from global.users where keycloak_sub = :sub');
        $stmt->execute([':sub' => $sub]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!is_array($existing)) {
            if ($pdo->inTransaction()) {
                throw new HttpError('unexpected nested transaction during user creation', 500);
            }

            $pdo->beginTransaction();

            if ($firstName === '' || $lastName === '') {
                [$randFirst, $randLast] = self::randomName();
                if ($firstName === '') {
                    $firstName = $randFirst;
                }
                if ($lastName === '') {
                    $lastName = $randLast;
                }
            }

            try {
                $ins = $pdo->prepare(
                    'insert into global.users (id, first_name, last_name, keycloak_sub, username, email, email_verified, nickname) ' .
                    'values (gen_random_uuid(), :first_name, :last_name, :sub, :username, :email, :email_verified, :nickname) ' .
                    'on conflict (keycloak_sub) do nothing ' .
                    'returning id, first_name, last_name, username, email, email_verified'
                );

                $ins->execute([
                    ':first_name' => $firstName,
                    ':last_name' => $lastName,
                    ':sub' => $sub,
                    ':username' => $username !== '' ? $username : null,
                    ':email' => ($emailVerified && $email !== '') ? $email : null,
                    ':email_verified' => $emailVerified,
                    ':nickname' => $nickname !== '' ? $nickname : null,
                ]);

                $created = $ins->fetch(PDO::FETCH_ASSOC);
                $didCreate = is_array($created);
                if (!is_array($created)) {
                    $stmt2 = $pdo->prepare('select id, first_name, last_name, username, email, email_verified from global.users where keycloak_sub = :sub');
                    $stmt2->execute([':sub' => $sub]);
                    $existing = $stmt2->fetch(PDO::FETCH_ASSOC);
                    if (!is_array($existing)) {
                        throw new HttpError('failed to create user', 500);
                    }
                } else {
                    $existing = $created;
                }

                if ($didCreate && is_array($created)) {
                    $createdUserId = is_scalar($created['id'] ?? null) ? (string)$created['id'] : '';
                    if ($createdUserId !== '') {
                        $this->ensurePersonalNook($pdo, $createdUserId);
                    }
                }

                $pdo->commit();
            } catch (Throwable $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $e;
            }
        }

        $dbId = is_scalar($existing['id'] ?? null) ? (string)$existing['id'] : '';
        $dbFirst = is_scalar($existing['first_name'] ?? null) ? (string)$existing['first_name'] : '';
        $dbLast = is_scalar($existing['last_name'] ?? null) ? (string)$existing['last_name'] : '';
        $dbUsername = is_scalar($existing['username'] ?? null) ? (string)$existing['username'] : '';
        $dbEmail = is_scalar($existing['email'] ?? null) ? (string)$existing['email'] : '';
        $dbEmailVerified = (bool)($existing['email_verified'] ?? false);

        $newFirst = $firstName !== '' ? $firstName : $dbFirst;
        $newLast = $lastName !== '' ? $lastName : $dbLast;
        $newUsername = $username !== '' ? $username : $dbUsername;

        $newEmail = $dbEmail;
        $newEmailVerified = $dbEmailVerified;
        if ($emailVerified && $email !== '') {
            $newEmail = $email;
            $newEmailVerified = true;
        }

        $upd = $pdo->prepare(
            'update global.users set first_name = :first_name, last_name = :last_name, username = :username, email = :email, email_verified = :email_verified, nickname = coalesce(:nickname, nickname) where keycloak_sub = :sub'
        );
        $upd->execute([
            ':first_name' => $newFirst !== '' ? $newFirst : 'User',
            ':last_name' => $newLast !== '' ? $newLast : 'User',
            ':username' => $newUsername !== '' ? $newUsername : null,
            ':email' => $newEmail !== '' ? $newEmail : null,
            ':email_verified' => $newEmailVerified,
            ':nickname' => $nickname !== '' ? $nickname : null,
            ':sub' => $sub,
        ]);

        return [
            'id' => $dbId,
            'first_name' => $newFirst,
            'last_name' => $newLast,
            'username' => $newUsername,
            'email' => $newEmail,
            'email_verified' => $newEmailVerified,
            'keycloak_sub' => $sub,
            'groups' => $groups,
        ];
    }

    private function findOrCreateUser(PDO $pdo, string $id): array
    {
        $stmt = $pdo->prepare('select id, first_name, last_name from global.users where id = :id');
        $stmt->execute([':id' => $id]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (is_array($user)) {
            $dbId = $user['id'] ?? '';
            $dbFirst = $user['first_name'] ?? '';
            $dbLast = $user['last_name'] ?? '';

            return [
                'id' => is_scalar($dbId) ? (string)$dbId : '',
                'first_name' => is_scalar($dbFirst) ? (string)$dbFirst : '',
                'last_name' => is_scalar($dbLast) ? (string)$dbLast : '',
            ];
        }

        [$first, $last] = self::randomName();

        if ($pdo->inTransaction()) {
            throw new HttpError('unexpected nested transaction during user creation', 500);
        }

        $pdo->beginTransaction();

        try {
            $ins = $pdo->prepare(
                'insert into global.users (id, first_name, last_name) ' .
                'values (:id, :first_name, :last_name) ' .
                'on conflict (id) do nothing ' .
                'returning id, first_name, last_name'
            );
            $ins->execute([
                ':id' => $id,
                ':first_name' => $first,
                ':last_name' => $last,
            ]);

            $created = $ins->fetch(PDO::FETCH_ASSOC);
            $didCreate = is_array($created);
            if (!is_array($created)) {
                $stmt2 = $pdo->prepare('select id, first_name, last_name from global.users where id = :id');
                $stmt2->execute([':id' => $id]);
                $created = $stmt2->fetch(PDO::FETCH_ASSOC);
                if (!is_array($created)) {
                    throw new HttpError('failed to create user', 500);
                }
            }

            if ($didCreate) {
                $this->ensurePersonalNook($pdo, $id);
            }

            $pdo->commit();

            return [
                'id' => $id,
                'first_name' => is_scalar($created['first_name'] ?? null) ? (string)$created['first_name'] : '',
                'last_name' => is_scalar($created['last_name'] ?? null) ? (string)$created['last_name'] : '',
            ];
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    private static function isUuid(string $value): bool
    {
        return (bool)preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i',
            $value
        );
    }

    private static function randomName(): array
    {
        $first = [
            'Ava', 'Mia', 'Luna', 'Nova', 'Ivy', 'Ada', 'Zoe', 'Maya', 'Noah', 'Leo',
            'Eli', 'Theo', 'Owen', 'Finn', 'Milo', 'Aria', 'Nina', 'Sage', 'Skye', 'Remy',
        ];
        $last = [
            'Moss', 'River', 'Stone', 'Ember', 'Cedar', 'Wren', 'Fox', 'Reed', 'Bloom', 'Hearth',
            'Frost', 'Rowan', 'Pine', 'Vale', 'Brook', 'Ash', 'Sunny', 'Cloud', 'Thorn', 'Leaf',
        ];

        $f = $first[random_int(0, count($first) - 1)];
        $l = $last[random_int(0, count($last) - 1)];

        return [$f, $l];
    }

    private function ensurePersonalNook(PDO $pdo, string $userId): void
    {
        if (!$pdo->inTransaction()) {
            throw new HttpError('ensurePersonalNook must run inside a transaction', 500);
        }

        try {
            $create = $pdo->prepare(
                "insert into global.nooks (name, created_by, is_personal, owner_id) 
                 values (:name, :created_by, true, :owner_id) 
                 on conflict (owner_id) where is_personal = true do nothing 
                 returning id"
            );
            $create->execute([
                ':name' => 'Personal',
                ':created_by' => $userId,
                ':owner_id' => $userId,
            ]);
            $nookId = $create->fetchColumn();

            if (!$nookId) {
                $existing = $pdo->prepare('select id from global.nooks where owner_id = :user_id and is_personal = true');
                $existing->execute([':user_id' => $userId]);
                $nookId = $existing->fetchColumn();
            }

            if ($nookId) {
                $member = $pdo->prepare(
                    "insert into global.nook_members (nook_id, user_id, role) values (:nook_id, :user_id, 'owner') on conflict (nook_id, user_id) do update set role = excluded.role"
                );
                $member->execute([
                    ':nook_id' => (string)$nookId,
                    ':user_id' => $userId,
                ]);
            }
        } catch (Throwable $e) {
            throw $e;
        }
    }
}
