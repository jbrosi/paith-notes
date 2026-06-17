<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

/**
 * The role a user has within a particular nook.
 *
 * `Owner`     — full control (create, edit, delete, share, export)
 * `Readwrite` — can edit own notes, but cannot revoke / re-share / delete the nook
 * `Readonly`  — view-only
 */
enum NookRole: string
{
    case Owner = 'owner';
    case Readwrite = 'readwrite';
    case Readonly = 'readonly';
}
