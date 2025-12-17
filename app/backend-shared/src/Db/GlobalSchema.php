<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db;

use PDO;

final class GlobalSchema
{
    public static function ensure(PDO $pdo): void
    {
        $pdo->exec('create extension if not exists pgcrypto');
        $pdo->exec('create schema if not exists global');

        $pdo->exec("
            create table if not exists global.users (
                id uuid primary key,
                first_name text not null,
                last_name text not null,
                created_at timestamptz not null default now()
            );
        ");

        $pdo->exec("
            create table if not exists global.nooks (
                id uuid primary key default gen_random_uuid(),
                name text not null,
                created_by uuid not null references global.users(id) on delete restrict,
                created_at timestamptz not null default now()
            );
        ");

        $pdo->exec("do $$ begin
            create type global.nook_role as enum ('owner', 'member');
        exception
            when duplicate_object then null;
        end $$;");

        $pdo->exec("
            create table if not exists global.nook_members (
                nook_id uuid not null references global.nooks(id) on delete cascade,
                user_id uuid not null references global.users(id) on delete cascade,
                role global.nook_role not null default 'member',
                created_at timestamptz not null default now(),
                primary key (nook_id, user_id)
            );
        ");

        $pdo->exec('create index if not exists nooks_created_by_idx on global.nooks (created_by)');
        $pdo->exec('create index if not exists nook_members_user_id_idx on global.nook_members (user_id)');

        $pdo->exec("
            create table if not exists global.jobs (
                id bigserial primary key,
                queue text not null default 'default',
                payload jsonb not null default '{}'::jsonb,
                status text not null default 'queued',
                available_at timestamptz not null default now(),
                locked_at timestamptz null,
                locked_by text null,
                attempts int not null default 0,
                last_error text null,
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now()
            );
        ");

        $pdo->exec('create index if not exists jobs_status_available_idx on global.jobs (status, available_at)');
        $pdo->exec('create index if not exists jobs_locked_at_idx on global.jobs (locked_at)');
    }
}
