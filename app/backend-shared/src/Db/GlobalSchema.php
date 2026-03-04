<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db;

use PDO;

final class GlobalSchema
{
    public static function ensure(PDO $pdo): void
    {
        $pdo->exec('create extension if not exists pgcrypto');
        $pdo->exec('create extension if not exists pg_trgm');
        $pdo->exec('create schema if not exists global');
        $pdo->exec("set search_path = pg_catalog, public, global");

        $pdo->exec("
            create table if not exists global.users (
                id uuid primary key,
                first_name text not null,
                last_name text not null,
                created_at timestamptz not null default now()
            );
        ");

        $pdo->exec('alter table global.users add column if not exists keycloak_sub text');
        $pdo->exec('alter table global.users add column if not exists username text');
        $pdo->exec('alter table global.users add column if not exists email text');
        $pdo->exec('alter table global.users add column if not exists email_verified boolean not null default false');
        $pdo->exec('alter table global.users add column if not exists nickname text');

        $pdo->exec('create unique index if not exists users_keycloak_sub_uidx on global.users (keycloak_sub)');

        $pdo->exec("
            create table if not exists global.nooks (
                id uuid primary key default gen_random_uuid(),
                name text not null,
                created_by uuid not null references global.users(id) on delete restrict,
                owner_id uuid not null references global.users(id) on delete restrict,
                is_personal boolean not null default false,
                created_at timestamptz not null default now()
            );
        ");

        $pdo->exec("do $$ begin
            create type global.nook_role as enum ('owner', 'member');
        exception
            when duplicate_object then null;
        end $$;");

        $pdo->exec('create index if not exists nooks_owner_id_idx on global.nooks (owner_id)');
        $pdo->exec("create unique index if not exists nooks_personal_owner_uidx on global.nooks (owner_id) where is_personal = true");

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
            create table if not exists global.notes (
                id uuid primary key default gen_random_uuid(),
                nook_id uuid not null references global.nooks(id) on delete cascade,
                created_by uuid not null references global.users(id) on delete restrict,
                title text not null,
                content text not null default '',
                created_at timestamptz not null default now()
            );
        ");

        $pdo->exec('create index if not exists notes_nook_id_idx on global.notes (nook_id)');
        $pdo->exec('create index if not exists notes_created_by_idx on global.notes (created_by)');
        $pdo->exec('create index if not exists notes_title_trgm_idx on global.notes using gin (title gin_trgm_ops)');

        $pdo->exec(" 
            create table if not exists global.note_types (
                id uuid primary key default gen_random_uuid(),
                nook_id uuid not null references global.nooks(id) on delete cascade,
                key text not null,
                label text not null,
                parent_id uuid null references global.note_types(id) on delete set null,
                applies_to_files boolean not null default true,
                applies_to_notes boolean not null default true,
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now()
            );
        ");

        $pdo->exec("alter table global.note_types add column if not exists description text not null default ''");

        // Remove former soft-delete column (we prefer hard deletes; history can be added later).
        $pdo->exec('alter table global.note_types drop column if exists archived_at');

        $pdo->exec('drop index if exists global.note_types_nook_key_uidx');
        $pdo->exec('drop index if exists note_types_nook_key_uidx');
        $pdo->exec('create unique index if not exists note_types_nook_key_uidx on global.note_types (nook_id, key)');
        $pdo->exec('create index if not exists note_types_nook_id_idx on global.note_types (nook_id)');
        $pdo->exec('create index if not exists note_types_parent_id_idx on global.note_types (parent_id)');

        $pdo->exec(" 
			create table if not exists global.note_mentions (
				id bigserial primary key,
				source_note_id uuid not null references global.notes(id) on delete cascade,
				target_note_id uuid not null references global.notes(id) on delete cascade,
				position int not null,
				link_title text not null default '',
				created_at timestamptz not null default now()
			);
		");

        $pdo->exec("alter table global.notes add column if not exists type text not null default 'anything'");
        $pdo->exec("alter table global.notes add column if not exists properties jsonb not null default '{}'::jsonb");
        $pdo->exec("alter table global.notes add column if not exists former_properties jsonb not null default '{}'::jsonb");

        $pdo->exec('alter table global.notes add column if not exists type_id uuid null references global.note_types(id) on delete set null');
        $pdo->exec('create index if not exists notes_type_id_idx on global.notes (type_id)');


        $pdo->exec(" 
            create table if not exists global.note_files (
                note_id uuid primary key references global.notes(id) on delete cascade,
                object_key text not null,
                filename text not null default '',
                extension text not null default '',
                filesize bigint not null default 0,
                mime_type text not null default '',
                checksum text not null default '',
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now()
            );
        ");

        $pdo->exec('create index if not exists note_files_object_key_idx on global.note_files (object_key)');

        $pdo->exec(" 
            create table if not exists global.file_uploads (
                id uuid primary key,
                note_id uuid not null references global.notes(id) on delete cascade,
                created_by uuid not null references global.users(id) on delete cascade,
                temp_object_key text not null,
                final_object_key text not null,
                created_at timestamptz not null default now(),
                finalized_at timestamptz null
            );
        ");

        // Option B compatibility: uploads may exist without an associated note until finalize.
        $pdo->exec('alter table global.file_uploads alter column note_id drop not null');
        $pdo->exec('alter table global.file_uploads alter column final_object_key drop not null');
        $pdo->exec('alter table global.file_uploads add column if not exists nook_id uuid null references global.nooks(id) on delete cascade');
        $pdo->exec('alter table global.file_uploads add column if not exists filename text not null default \'\'');
        $pdo->exec('alter table global.file_uploads add column if not exists extension text not null default \'\'');
        $pdo->exec('alter table global.file_uploads add column if not exists mime_type text not null default \'\'');
        $pdo->exec('alter table global.file_uploads add column if not exists expected_filesize bigint not null default 0');
        $pdo->exec('alter table global.file_uploads add column if not exists expected_checksum text not null default \'\'');
        $pdo->exec('alter table global.file_uploads add column if not exists finalized_note_id uuid null references global.notes(id) on delete set null');

        $pdo->exec('alter table global.file_uploads add column if not exists session_id uuid null');
        $pdo->exec("alter table global.file_uploads add column if not exists expires_at timestamptz not null default (now() + interval '15 minutes')");

        $pdo->exec('alter table global.file_uploads add column if not exists put_claimed_at timestamptz null');

        $pdo->exec('create index if not exists file_uploads_note_id_idx on global.file_uploads (note_id)');
        $pdo->exec('create index if not exists file_uploads_nook_id_idx on global.file_uploads (nook_id)');
        $pdo->exec('create index if not exists file_uploads_temp_object_key_idx on global.file_uploads (temp_object_key)');
        $pdo->exec('create index if not exists file_uploads_finalized_at_idx on global.file_uploads (finalized_at)');
        $pdo->exec('create index if not exists file_uploads_expires_at_idx on global.file_uploads (expires_at)');
        $pdo->exec('create index if not exists file_uploads_session_id_idx on global.file_uploads (session_id)');
        $pdo->exec('create index if not exists file_uploads_put_claimed_at_idx on global.file_uploads (put_claimed_at)');

        $pdo->exec(" 
            create table if not exists global.link_predicates (
                id uuid primary key default gen_random_uuid(),
                nook_id uuid not null references global.nooks(id) on delete cascade,
                key text not null,
                forward_label text not null,
                reverse_label text not null,
                supports_start_date boolean not null default false,
                supports_end_date boolean not null default false,
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now()
            );
        ");

        // Remove former soft-delete column (we prefer hard deletes; history can be added later).
        $pdo->exec('alter table global.link_predicates drop column if exists archived_at');

        $pdo->exec('create index if not exists link_predicates_nook_id_idx on global.link_predicates (nook_id)');
        $pdo->exec('drop index if exists global.link_predicates_nook_key_uidx');
        $pdo->exec('drop index if exists link_predicates_nook_key_uidx');
        $pdo->exec("create unique index if not exists link_predicates_nook_key_uidx on global.link_predicates (nook_id, key)");

        $pdo->exec(" 
            create table if not exists global.link_predicate_rules (
                id bigserial primary key,
                predicate_id uuid not null references global.link_predicates(id) on delete cascade,
                source_type_id uuid null references global.note_types(id) on delete cascade,
                target_type_id uuid null references global.note_types(id) on delete cascade,
                include_source_subtypes boolean not null default true,
                include_target_subtypes boolean not null default true,
                created_at timestamptz not null default now()
            );
        ");

        $pdo->exec('create index if not exists link_predicate_rules_predicate_id_idx on global.link_predicate_rules (predicate_id)');
        $pdo->exec('create index if not exists link_predicate_rules_source_type_id_idx on global.link_predicate_rules (source_type_id)');
        $pdo->exec('create index if not exists link_predicate_rules_target_type_id_idx on global.link_predicate_rules (target_type_id)');
        $pdo->exec('create unique index if not exists link_predicate_rules_unique_uidx on global.link_predicate_rules (predicate_id, source_type_id, target_type_id)');

        $pdo->exec(" 
            create table if not exists global.note_links (
                id uuid primary key default gen_random_uuid(),
                nook_id uuid not null references global.nooks(id) on delete cascade,
                predicate_id uuid not null references global.link_predicates(id) on delete restrict,
                source_note_id uuid not null references global.notes(id) on delete cascade,
                target_note_id uuid not null references global.notes(id) on delete cascade,
                start_date date null,
                end_date date null,
                former jsonb not null default '{}'::jsonb,
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now()
            );
        ");

        $pdo->exec('create index if not exists note_links_nook_id_idx on global.note_links (nook_id)');
        $pdo->exec('create index if not exists note_links_predicate_id_idx on global.note_links (predicate_id)');
        $pdo->exec('create index if not exists note_links_source_note_id_idx on global.note_links (source_note_id)');
        $pdo->exec('create index if not exists note_links_target_note_id_idx on global.note_links (target_note_id)');

        $pdo->exec(" 
            create table if not exists global.auth_states (
                state text primary key,
                redirect_to text not null default '/',
                code_verifier text not null default '',
                created_at timestamptz not null default now(),
                expires_at timestamptz not null
            );
        ");

        $pdo->exec('create index if not exists auth_states_expires_at_idx on global.auth_states (expires_at)');

        $pdo->exec(" 
            create table if not exists global.sessions (
                id uuid primary key,
                user_id uuid not null references global.users(id) on delete cascade,
                token_encrypted text not null,
                created_at timestamptz not null default now(),
                last_seen_at timestamptz not null default now(),
                expires_at timestamptz not null
            );
        ");

        $pdo->exec('create index if not exists sessions_user_id_idx on global.sessions (user_id)');
        $pdo->exec('create index if not exists sessions_expires_at_idx on global.sessions (expires_at)');

        $pdo->exec('create index if not exists note_mentions_source_note_id_idx on global.note_mentions (source_note_id)');
        $pdo->exec('create index if not exists note_mentions_target_note_id_idx on global.note_mentions (target_note_id)');
        $pdo->exec('create unique index if not exists note_mentions_source_position_uidx on global.note_mentions (source_note_id, position)');

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
