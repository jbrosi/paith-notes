<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Auth;

/**
 * The authenticated user attached to a Context.
 *
 * Replaces the prior `array<string, mixed>` shape that was passed
 * around as `$user`. Keycloak-only fields (keycloakSub, groups,
 * email, emailVerified) are populated only on the keycloak path —
 * in dev/test mode they default to empty / false / [].
 */
final readonly class User
{
    /**
     * @param list<string> $groups
     */
    public function __construct(
        public string $id,
        public string $firstName,
        public string $lastName,
        public string $username = '',
        public string $email = '',
        public bool $emailVerified = false,
        public string $keycloakSub = '',
        public array $groups = [],
    ) {
    }
}
