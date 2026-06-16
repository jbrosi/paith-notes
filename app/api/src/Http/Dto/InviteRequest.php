<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Dto;

use Paith\Notes\Api\Http\HttpError;

/**
 * Validated payload for POST /nooks/{nookId}/invitations.
 *
 * `email` is required, lowercased, and must pass PHP's FILTER_VALIDATE_EMAIL.
 * `role` is one of `readonly` | `readwrite`, defaulting to `readonly`.
 */
final readonly class InviteRequest
{
    private const VALID_ROLES = ['readonly', 'readwrite'];

    public function __construct(
        public string $email,
        public string $role,
    ) {
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromJson(array $data): self
    {
        $emailRaw = $data['email'] ?? null;
        $email = is_string($emailRaw) ? trim(strtolower($emailRaw)) : '';
        if ($email === '' || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            throw new HttpError('a valid email is required', 400);
        }

        $role = JsonReader::optionalTrimmedString($data, 'role', 'readonly');
        if (!in_array($role, self::VALID_ROLES, true)) {
            throw new HttpError('role must be readonly or readwrite', 400);
        }

        return new self($email, $role);
    }
}
