<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Middleware;

use Paith\Notes\Api\Http\Auth\KeycloakJwt;
use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\Middleware;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use PDO;
use RuntimeException;

final class RequireUser implements Middleware
{
    public function handle(Request $request, Context $context, callable $next): Response
    {
        if ((string)getenv('KEYCLOAK_ENABLED') === '1') {
            $auth = trim($request->header('Authorization'));
            if (!str_starts_with($auth, 'Bearer ')) {
                throw new HttpError('Authorization bearer token is required', 401);
            }

            $jwt = trim(substr($auth, strlen('Bearer ')));
            if ($jwt === '') {
                throw new HttpError('Authorization bearer token is required', 401);
            }

            try {
                $claims = KeycloakJwt::fromEnv()->verifyAndDecode($jwt);
            } catch (RuntimeException $e) {
                throw new HttpError($e->getMessage(), 401);
            }

            $pdo = $context->pdo();
            $user = $this->findOrCreateUserFromKeycloak($pdo, $claims);
            $context->setUser($user);
        } else {
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

    private function findOrCreateUserFromKeycloak(PDO $pdo, array $claims): array
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
        $rawGroups = $claims['groups'] ?? [];
        if (is_array($rawGroups)) {
            foreach ($rawGroups as $g) {
                if (is_string($g) && $g !== '') {
                    $groups[] = $g;
                }
            }
        }

        $stmt = $pdo->prepare('select id, first_name, last_name, username, email, email_verified from global.users where keycloak_sub = :sub');
        $stmt->execute([':sub' => $sub]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!is_array($existing)) {
            if ($firstName === '' || $lastName === '') {
                [$randFirst, $randLast] = self::randomName();
                if ($firstName === '') {
                    $firstName = $randFirst;
                }
                if ($lastName === '') {
                    $lastName = $randLast;
                }
            }

            $ins = $pdo->prepare(
                'insert into global.users (id, first_name, last_name, keycloak_sub, username, email, email_verified, nickname) ' .
                'values (gen_random_uuid(), :first_name, :last_name, :sub, :username, :email, :email_verified, :nickname) ' .
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
            if (!is_array($created)) {
                throw new HttpError('failed to create user', 500);
            }

            return [
                'id' => is_scalar($created['id'] ?? null) ? (string)$created['id'] : '',
                'first_name' => is_scalar($created['first_name'] ?? null) ? (string)$created['first_name'] : '',
                'last_name' => is_scalar($created['last_name'] ?? null) ? (string)$created['last_name'] : '',
                'username' => is_scalar($created['username'] ?? null) ? (string)$created['username'] : '',
                'email' => is_scalar($created['email'] ?? null) ? (string)$created['email'] : '',
                'email_verified' => (bool)($created['email_verified'] ?? false),
                'keycloak_sub' => $sub,
                'groups' => $groups,
            ];
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

        $ins = $pdo->prepare('insert into global.users (id, first_name, last_name) values (:id, :first_name, :last_name)');
        $ins->execute([
            ':id' => $id,
            ':first_name' => $first,
            ':last_name' => $last,
        ]);

        return [
            'id' => $id,
            'first_name' => $first,
            'last_name' => $last,
        ];
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
}
