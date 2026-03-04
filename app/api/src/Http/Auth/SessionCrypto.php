<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Auth;

use Paith\Notes\Shared\Env;
use RuntimeException;

final class SessionCrypto
{
    private string $key;

    public function __construct(string $key)
    {
        $this->key = $key;
    }

    public static function fromEnv(): self
    {
        $secret = Env::require('SESSION_SECRET');
        $key = hash('sha256', $secret, true);
        if (strlen($key) !== 32) {
            throw new RuntimeException('failed to derive SESSION_SECRET key');
        }
        return new self($key);
    }

    public function encrypt(string $plaintext): string
    {
        $iv = random_bytes(12);
        $tag = '';
        $ciphertext = openssl_encrypt($plaintext, 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA, $iv, $tag);
        if ($ciphertext === false || $ciphertext === '') {
            throw new RuntimeException('failed to encrypt session payload');
        }
        if (strlen($tag) !== 16) {
            throw new RuntimeException('failed to encrypt session payload (tag)');
        }

        return base64_encode($iv . $tag . $ciphertext);
    }

    public function decrypt(string $encoded): string
    {
        $raw = base64_decode($encoded, true);
        if ($raw === false || $raw === '') {
            throw new RuntimeException('invalid encrypted payload');
        }
        if (strlen($raw) < 12 + 16 + 1) {
            throw new RuntimeException('invalid encrypted payload');
        }

        $iv = substr($raw, 0, 12);
        $tag = substr($raw, 12, 16);
        $ciphertext = substr($raw, 28);

        $plaintext = openssl_decrypt($ciphertext, 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA, $iv, $tag);
        if (!is_string($plaintext)) {
            throw new RuntimeException('failed to decrypt session payload');
        }
        return $plaintext;
    }
}
