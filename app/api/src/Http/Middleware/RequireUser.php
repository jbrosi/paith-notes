<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Middleware;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\Middleware;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use PDO;

final class RequireUser implements Middleware
{
    public function handle(Request $request, Context $context, callable $next): Response
    {
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

        return $next($request, $context);
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
