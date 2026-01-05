<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

interface Response
{
    public function statusCode(): int;

    public function headers(): array;

    public function body(): string;
}
