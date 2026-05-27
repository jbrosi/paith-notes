<?php

declare(strict_types=1);

namespace Paith\Notes\Shared\Db;

use PDO;

final class GlobalSchema
{
    public static function ensure(PDO $pdo): void
    {
        // Schema setup is invoked at runtime and can be hit by multiple concurrent requests.
        // To avoid DDL races (eg. drop/create index), serialize via an advisory lock.
        $pdo->exec("select pg_advisory_lock(hashtext('paith_notes_global_schema_ensure'))");
        try {
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
                    created_at timestamptz not null default now()
                );
            ");

            $pdo->exec("do $$ begin
                create type global.nook_role as enum ('owner', 'member');
            exception
                when duplicate_object then null;
            end $$;");

            $pdo->exec('create index if not exists nooks_owner_id_idx on global.nooks (owner_id)');
            $pdo->exec('drop index if exists global.nooks_personal_owner_uidx');
            $pdo->exec('alter table global.nooks drop column if exists is_personal');
            $pdo->exec("alter table global.nooks add column if not exists purpose text not null default 'general'");

            // Ensure AI memory nooks have the correct name
            $pdo->exec("update global.nooks set name = 'AI Memory' where purpose = 'ai-memory' and name != 'AI Memory'");

            // Well-known AI system user
            $pdo->exec("
                insert into global.users (id, first_name, last_name)
                values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant')
                on conflict (id) do nothing
            ");

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
                create table if not exists global.user_nook_preferences (
                    user_id uuid not null references global.users(id) on delete cascade,
                    nook_id uuid not null references global.nooks(id) on delete cascade,
                    settings jsonb not null default '{}'::jsonb,
                    primary key (user_id, nook_id)
                );
            ");

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
            $pdo->exec('create index if not exists notes_title_trgm_idx on global.notes using gin (lower(title) gin_trgm_ops)');
            $pdo->exec('create index if not exists notes_content_trgm_idx on global.notes using gin (lower(content) gin_trgm_ops)');
            $pdo->exec("alter table global.notes add column if not exists updated_at timestamptz not null default now()");
            $pdo->exec("alter table global.notes add column if not exists actor text not null default 'user'");
            $pdo->exec('create index if not exists notes_updated_at_idx on global.notes (nook_id, updated_at desc)');

            $pdo->exec(" 
                create table if not exists global.note_types (
                    id uuid primary key default gen_random_uuid(),
                    nook_id uuid not null references global.nooks(id) on delete cascade,
                    key text not null,
                    label text not null,
                    parent_id uuid null references global.note_types(id) on delete set null,
                    applies_to text not null default 'notes' check (applies_to in ('notes', 'files')),
                    created_at timestamptz not null default now(),
                    updated_at timestamptz not null default now()
                );
            ");

            $pdo->exec("alter table global.note_types add column if not exists description text not null default ''");

            // Remove former soft-delete column (we prefer hard deletes; history can be added later).
            $pdo->exec('alter table global.note_types drop column if exists archived_at');

            // Migrate: replace applies_to_files + applies_to_notes booleans with applies_to enum.
            $pdo->exec("
                do \$\$ begin
                    if exists (
                        select 1 from information_schema.columns
                        where table_schema = 'global' and table_name = 'note_types' and column_name = 'applies_to_files'
                    ) then
                        alter table global.note_types add column if not exists applies_to text not null default 'notes';
                        update global.note_types set applies_to = case when applies_to_files then 'files' else 'notes' end;
                        alter table global.note_types drop column applies_to_files;
                        alter table global.note_types drop column applies_to_notes;
                    end if;
                end \$\$;
            ");
            $pdo->exec("
                do \$\$ begin
                    if not exists (
                        select 1 from pg_constraint
                        where conname = 'note_types_applies_to_check'
                        and conrelid = 'global.note_types'::regclass
                    ) then
                        alter table global.note_types add constraint note_types_applies_to_check
                            check (applies_to in ('notes', 'files'));
                    end if;
                end \$\$;
            ");

            $pdo->exec('drop index if exists global.note_types_nook_key_uidx');
            $pdo->exec('drop index if exists note_types_nook_key_uidx');
            $pdo->exec('create unique index if not exists note_types_nook_key_uidx on global.note_types (nook_id, key)');
            $pdo->exec('create index if not exists note_types_nook_id_idx on global.note_types (nook_id)');
            $pdo->exec('create index if not exists note_types_parent_id_idx on global.note_types (parent_id)');

            // Remove legacy ai-memory note type (replaced by dedicated AI memory nook)
            $pdo->exec("delete from global.note_types where key = 'ai-memory'");

            // Auto-create 'ai-instruction' note type in all nooks that don't have it
            $pdo->exec("
                insert into global.note_types (nook_id, key, label, description)
                select n.id, 'ai-instruction', 'AI Instruction', 'Notes of this type are read by the AI assistant as context/guidelines for this nook.'
                from global.nooks n
                where not exists (
                    select 1 from global.note_types t where t.nook_id = n.id and t.key = 'ai-instruction'
                )
                on conflict (nook_id, key) do nothing
            ");

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

            // Migrate "person" type to "anything" — person is no longer a built-in type
            $pdo->exec("update global.notes set type = 'anything' where type = 'person'");


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
            // Composite indexes for graph traversal query (nook_id + source/target)
            $pdo->exec('create index if not exists note_links_nook_source_idx on global.note_links (nook_id, source_note_id)');
            $pdo->exec('create index if not exists note_links_nook_target_idx on global.note_links (nook_id, target_note_id)');

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

            $pdo->exec("
                create table if not exists global.conversations (
                    id          uuid        primary key default gen_random_uuid(),
                    nook_id     uuid        not null references global.nooks(id) on delete cascade,
                    user_id     uuid        not null references global.users(id) on delete cascade,
                    title       text        not null default '',
                    model       text        not null,
                    created_at  timestamptz not null default now(),
                    updated_at  timestamptz not null default now()
                );
            ");

            $pdo->exec('create index if not exists conversations_nook_user_idx on global.conversations (nook_id, user_id)');

            // Wipe conversations from general nooks (chats now live in AI memory nook)
            $pdo->exec("
                delete from global.conversations
                where nook_id in (select id from global.nooks where purpose = 'general')
            ");

            // Drop legacy conversation_messages table (replaced by conversation_blocks)
            $pdo->exec('drop table if exists global.conversation_messages');

            // Block-level conversation storage: one row per content block, grouped by turn_id
            $pdo->exec("
                create table if not exists global.conversation_blocks (
                    id              uuid        primary key default gen_random_uuid(),
                    conversation_id uuid        not null references global.conversations(id) on delete cascade,
                    turn_id         uuid        not null,
                    role            text        not null,
                    block_index     int         not null default 0,
                    block_type      text        not null,
                    content         jsonb       not null,
                    model           text        null,
                    created_at      timestamptz not null default now()
                );
            ");

            $pdo->exec('create index if not exists conv_blocks_conv_idx on global.conversation_blocks (conversation_id, created_at, block_index)');
            $pdo->exec('create index if not exists conv_blocks_turn_idx on global.conversation_blocks (turn_id, block_index)');

            // Links between AI memory notes and the conversation block where they were written
            $pdo->exec("
                create table if not exists global.note_conversation_links (
                    note_id         uuid        not null references global.notes(id) on delete cascade,
                    conversation_id uuid        not null references global.conversations(id) on delete cascade,
                    block_id        uuid        null references global.conversation_blocks(id) on delete set null,
                    created_at      timestamptz not null default now(),
                    primary key (note_id, conversation_id)
                );
            ");

            $pdo->exec('create index if not exists note_conv_links_note_idx on global.note_conversation_links (note_id)');
            $pdo->exec('create index if not exists note_conv_links_conv_idx on global.note_conversation_links (conversation_id)');

            // Extend nook_role enum with sharing roles
            $pdo->exec("do $$ begin
                if not exists (select 1 from pg_enum where enumtypid = 'global.nook_role'::regtype and enumlabel = 'readonly') then
                    alter type global.nook_role add value 'readonly';
                end if;
            end $$;");
            $pdo->exec("do $$ begin
                if not exists (select 1 from pg_enum where enumtypid = 'global.nook_role'::regtype and enumlabel = 'readwrite') then
                    alter type global.nook_role add value 'readwrite';
                end if;
            end $$;");

            // Nook sharing invitations (by email, since invitee may not have an account yet)
            $pdo->exec("
                create table if not exists global.nook_invitations (
                    id uuid primary key default gen_random_uuid(),
                    nook_id uuid not null references global.nooks(id) on delete cascade,
                    invited_email text not null,
                    role global.nook_role not null default 'readonly',
                    invited_by uuid not null references global.users(id) on delete cascade,
                    accepted_at timestamptz null,
                    declined_at timestamptz null,
                    created_at timestamptz not null default now()
                );
            ");

            $pdo->exec('create index if not exists nook_invitations_email_idx on global.nook_invitations (lower(invited_email))');
            $pdo->exec('create index if not exists nook_invitations_nook_id_idx on global.nook_invitations (nook_id)');
            $pdo->exec("create unique index if not exists nook_invitations_nook_email_uidx on global.nook_invitations (nook_id, lower(invited_email)) where accepted_at is null and declined_at is null");

            // Access revocation notices (shown to user after owner removes their access)
            $pdo->exec("
                create table if not exists global.nook_access_revocations (
                    id uuid primary key default gen_random_uuid(),
                    nook_id uuid not null references global.nooks(id) on delete cascade,
                    user_id uuid not null references global.users(id) on delete cascade,
                    nook_name text not null,
                    revoked_by uuid not null references global.users(id) on delete cascade,
                    dismissed_at timestamptz null,
                    created_at timestamptz not null default now()
                );
            ");

            $pdo->exec('create index if not exists nook_access_revocations_user_id_idx on global.nook_access_revocations (user_id)');
            $pdo->exec('create index if not exists nook_access_revocations_nook_id_idx on global.nook_access_revocations (nook_id)');

            // ─── User Events ─────────────────────────────────────────────────────────────

            $pdo->exec("
                create table if not exists global.user_events (
                    id bigserial primary key,
                    user_id uuid not null,
                    event text not null,
                    meta jsonb not null default '{}'::jsonb,
                    created_at timestamptz not null default now()
                );
            ");

            $pdo->exec('create index if not exists user_events_user_id_idx on global.user_events (user_id, id desc)');
            $pdo->exec('create index if not exists user_events_created_at_idx on global.user_events (created_at desc)');

            // ─── Note Views (analytics/ranking) ─────────────────────────────────────────

            $pdo->exec("
                create table if not exists global.note_views (
                    note_id uuid not null,
                    nook_id uuid not null,
                    user_id uuid not null,
                    viewed_date date not null default current_date,
                    count int not null default 1,
                    primary key (note_id, user_id, viewed_date)
                );
            ");

            $pdo->exec('create index if not exists note_views_note_id_idx on global.note_views (note_id)');
            $pdo->exec('create index if not exists note_views_nook_user_idx on global.note_views (nook_id, user_id, note_id)');
            $pdo->exec('create index if not exists note_views_user_id_idx on global.note_views (user_id, viewed_date desc)');

            // ─── Note Stats (denormalized counts for search) ────────────────────────────

            $pdo->exec("
                create table if not exists global.note_stats (
                    note_id uuid primary key references global.notes(id) on delete cascade,
                    nook_id uuid not null,
                    outgoing_mentions int not null default 0,
                    incoming_mentions int not null default 0,
                    outgoing_links int not null default 0,
                    incoming_links int not null default 0,
                    view_count int not null default 0
                );
            ");

            $pdo->exec('create index if not exists note_stats_nook_id_idx on global.note_stats (nook_id)');

            // Trigger to maintain note_stats for mentions
            $pdo->exec("
                create or replace function global.note_stats_mentions_fn()
                    returns trigger language plpgsql as \$fn\$
                begin
                    if (TG_OP = 'INSERT' or TG_OP = 'UPDATE') then
                        insert into global.note_stats (note_id, nook_id, outgoing_mentions)
                            select NEW.source_note_id, n.nook_id, 0 from global.notes n where n.id = NEW.source_note_id
                            on conflict (note_id) do nothing;
                        update global.note_stats set outgoing_mentions = (
                            select count(*) from global.note_mentions where source_note_id = NEW.source_note_id
                        ) where note_id = NEW.source_note_id;

                        insert into global.note_stats (note_id, nook_id, incoming_mentions)
                            select NEW.target_note_id, n.nook_id, 0 from global.notes n where n.id = NEW.target_note_id
                            on conflict (note_id) do nothing;
                        update global.note_stats set incoming_mentions = (
                            select count(*) from global.note_mentions where target_note_id = NEW.target_note_id
                        ) where note_id = NEW.target_note_id;
                    end if;
                    if (TG_OP = 'DELETE') then
                        update global.note_stats set outgoing_mentions = (
                            select count(*) from global.note_mentions where source_note_id = OLD.source_note_id
                        ) where note_id = OLD.source_note_id;
                        update global.note_stats set incoming_mentions = (
                            select count(*) from global.note_mentions where target_note_id = OLD.target_note_id
                        ) where note_id = OLD.target_note_id;
                    end if;
                    return null;
                end;
                \$fn\$;
            ");

            $pdo->exec("
                do \$\$ begin
                    if not exists (select 1 from pg_trigger where tgname = 'note_stats_mentions_trg' and tgrelid = 'global.note_mentions'::regclass) then
                        create trigger note_stats_mentions_trg
                            after insert or update or delete on global.note_mentions
                            for each row execute function global.note_stats_mentions_fn();
                    end if;
                end \$\$;
            ");

            // Trigger to maintain note_stats for links
            $pdo->exec("
                create or replace function global.note_stats_links_fn()
                    returns trigger language plpgsql as \$fn\$
                begin
                    if (TG_OP = 'INSERT' or TG_OP = 'UPDATE') then
                        insert into global.note_stats (note_id, nook_id, outgoing_links)
                            select NEW.source_note_id, n.nook_id, 0 from global.notes n where n.id = NEW.source_note_id
                            on conflict (note_id) do nothing;
                        update global.note_stats set outgoing_links = (
                            select count(*) from global.note_links where source_note_id = NEW.source_note_id
                        ) where note_id = NEW.source_note_id;

                        insert into global.note_stats (note_id, nook_id, incoming_links)
                            select NEW.target_note_id, n.nook_id, 0 from global.notes n where n.id = NEW.target_note_id
                            on conflict (note_id) do nothing;
                        update global.note_stats set incoming_links = (
                            select count(*) from global.note_links where target_note_id = NEW.target_note_id
                        ) where note_id = NEW.target_note_id;
                    end if;
                    if (TG_OP = 'DELETE') then
                        update global.note_stats set outgoing_links = (
                            select count(*) from global.note_links where source_note_id = OLD.source_note_id
                        ) where note_id = OLD.source_note_id;
                        update global.note_stats set incoming_links = (
                            select count(*) from global.note_links where target_note_id = OLD.target_note_id
                        ) where note_id = OLD.target_note_id;
                    end if;
                    return null;
                end;
                \$fn\$;
            ");

            $pdo->exec("
                do \$\$ begin
                    if not exists (select 1 from pg_trigger where tgname = 'note_stats_links_trg' and tgrelid = 'global.note_links'::regclass) then
                        create trigger note_stats_links_trg
                            after insert or update or delete on global.note_links
                            for each row execute function global.note_stats_links_fn();
                    end if;
                end \$\$;
            ");

            // Trigger to maintain note_stats.view_count from note_views
            $pdo->exec("
                create or replace function global.note_stats_views_fn()
                    returns trigger language plpgsql as \$fn\$
                begin
                    insert into global.note_stats (note_id, nook_id, view_count)
                        values (NEW.note_id, NEW.nook_id, 1)
                        on conflict (note_id) do update set view_count = global.note_stats.view_count + 1;
                    return null;
                end;
                \$fn\$;
            ");

            $pdo->exec("
                do \$\$ begin
                    if not exists (select 1 from pg_trigger where tgname = 'note_stats_views_trg' and tgrelid = 'global.note_views'::regclass) then
                        create trigger note_stats_views_trg
                            after insert on global.note_views
                            for each row execute function global.note_stats_views_fn();
                    end if;
                end \$\$;
            ");

            // ─── Note Presence ───────────────────────────────────────────────────────────

            $pdo->exec("
                create table if not exists global.note_viewers (
                    note_id uuid not null,
                    nook_id uuid not null,
                    user_id uuid not null,
                    last_seen_at timestamptz not null default now(),
                    primary key (note_id, user_id)
                );
            ");

            $pdo->exec('create index if not exists note_viewers_note_id_idx on global.note_viewers (note_id, last_seen_at desc)');
            $pdo->exec('create index if not exists note_viewers_user_nook_idx on global.note_viewers (user_id, nook_id, last_seen_at desc)');
            $pdo->exec('create index if not exists note_viewers_last_seen_at_idx on global.note_viewers (last_seen_at)');

            // ─── Cross-Nook Links ────────────────────────────────────────────────────────

            $pdo->exec("
                create table if not exists global.note_cross_links (
                    id uuid primary key default gen_random_uuid(),
                    source_nook_id uuid not null references global.nooks(id) on delete cascade,
                    target_nook_id uuid not null references global.nooks(id) on delete cascade,
                    source_note_id uuid not null references global.notes(id) on delete cascade,
                    target_note_id uuid not null references global.notes(id) on delete cascade,
                    label text not null default '',
                    history_id bigint null,
                    version int not null default 0
                );
            ");

            $pdo->exec('create index if not exists note_cross_links_source_nook_idx on global.note_cross_links (source_nook_id)');
            $pdo->exec('create index if not exists note_cross_links_target_nook_idx on global.note_cross_links (target_nook_id)');
            $pdo->exec('create index if not exists note_cross_links_source_note_idx on global.note_cross_links (source_note_id)');
            $pdo->exec('create index if not exists note_cross_links_target_note_idx on global.note_cross_links (target_note_id)');

            // ─── Audit Log ───────────────────────────────────────────────────────────────

            $pdo->exec("do \$\$ begin
                create type global.audit_action as enum ('INSERT', 'UPDATE', 'DELETE');
            exception
                when duplicate_object then null;
            end \$\$;");

            // Meta table: lightweight, never pruned. Records who changed what, when.
            $pdo->exec("
                create table if not exists global.audit_meta (
                    id bigserial primary key,
                    prev_id bigint null,
                    nook_id uuid null,
                    table_name text not null,
                    table_id uuid not null,
                    action global.audit_action not null,
                    user_id uuid not null,
                    trx_id bigint not null default txid_current(),
                    created_at timestamptz not null default now()
                );
            ");

            $pdo->exec('alter table global.audit_meta add column if not exists nook_id uuid null');
            $pdo->exec("alter table global.audit_meta add column if not exists actor text not null default 'user'");

            $pdo->exec('alter table global.audit_meta add column if not exists version int not null default 1');

            $pdo->exec('create index if not exists audit_meta_table_id_idx on global.audit_meta (table_name, table_id, id desc)');
            $pdo->exec('create index if not exists audit_meta_user_id_idx on global.audit_meta (user_id, id desc)');
            $pdo->exec('create index if not exists audit_meta_created_at_idx on global.audit_meta (created_at desc)');
            $pdo->exec('create index if not exists audit_meta_nook_id_idx on global.audit_meta (nook_id, id desc)');

            // Data table: holds the full row snapshot. Can be pruned for older entries.
            $pdo->exec("
                create table if not exists global.audit_data (
                    meta_id bigint primary key references global.audit_meta(id) on delete cascade,
                    data jsonb,
                    diff jsonb
                );
            ");

            // Refs table: maps audit entries to related note IDs for efficient "history for note X" queries.
            $pdo->exec("
                create table if not exists global.audit_meta_refs (
                    meta_id bigint not null references global.audit_meta(id) on delete cascade,
                    note_id uuid not null,
                    primary key (meta_id, note_id)
                );
            ");

            $pdo->exec('create index if not exists audit_meta_refs_note_id_idx on global.audit_meta_refs (note_id, meta_id desc)');

            // Add history_id to all audited tables
            // Tables with uuid primary key that get full audit tracking.
            $auditedTables = ['notes', 'note_types', 'note_links', 'note_cross_links', 'link_predicates', 'nooks', 'note_files', 'nook_invitations', 'users'];

            // nook_members: add uuid id column so it can be audited
            $pdo->exec("alter table global.nook_members add column if not exists id uuid default gen_random_uuid()");
            $pdo->exec("do \$\$ begin
                if not exists (
                    select 1 from pg_constraint where conname = 'nook_members_id_unique'
                    and conrelid = 'global.nook_members'::regclass
                ) then
                    alter table global.nook_members add constraint nook_members_id_unique unique (id);
                end if;
            end \$\$;");

            // link_predicate_rules: add uuid id column so it can be audited
            $pdo->exec("alter table global.link_predicate_rules add column if not exists uuid_id uuid default gen_random_uuid()");
            $pdo->exec("do \$\$ begin
                if not exists (
                    select 1 from pg_constraint where conname = 'link_predicate_rules_uuid_id_unique'
                    and conrelid = 'global.link_predicate_rules'::regclass
                ) then
                    alter table global.link_predicate_rules add constraint link_predicate_rules_uuid_id_unique unique (uuid_id);
                end if;
            end \$\$;");

            // These tables also need history_id + triggers but use a different id column
            $pdo->exec("alter table global.nook_members add column if not exists history_id bigint null");
            $pdo->exec("alter table global.nook_members add column if not exists version int not null default 0");
            $pdo->exec("alter table global.link_predicate_rules add column if not exists history_id bigint null");
            $pdo->exec("alter table global.link_predicate_rules add column if not exists version int not null default 0");
            foreach ($auditedTables as $table) {
                $pdo->exec("alter table global.{$table} add column if not exists history_id bigint null");
                $pdo->exec("alter table global.{$table} add column if not exists version int not null default 0");
            }

            // Trigger function: records audit meta + data, sets history_id on the row
            $pdo->exec("
                create or replace function global.audit_trigger_fn()
                    returns trigger
                    language plpgsql as \$fn\$
                declare
                    v_user_id uuid;
                    v_actor text;
                    v_prev_id bigint;
                    v_meta_id bigint;
                    v_nook_id uuid;
                    v_table_id uuid;
                    v_version int;
                    v_row jsonb;
                begin
                    -- Require app.user_id to be set (allows nil UUID for system/anonymous)
                    begin
                        v_user_id := current_setting('app.user_id')::uuid;
                    exception when others then
                        raise exception 'app.user_id must be set for audit trigger (table: %)', TG_TABLE_NAME using errcode = '20808';
                    end;

                    -- Read actor (defaults to 'user' if not set)
                    begin
                        v_actor := coalesce(nullif(current_setting('app.actor', true), ''), 'user');
                    exception when others then
                        v_actor := 'user';
                    end;

                    if (TG_OP = 'UPDATE') then
                        if row(NEW.*) is not distinct from row(OLD.*) then
                            return NEW;
                        end if;
                        v_prev_id := OLD.history_id;
                    elsif (TG_OP = 'DELETE') then
                        v_prev_id := OLD.history_id;
                    else
                        v_prev_id := null;
                    end if;

                    v_row := case TG_OP when 'DELETE' then to_jsonb(OLD.*) else to_jsonb(NEW.*) end;

                    -- Extract table_id (the uuid identifying this row)
                    if TG_TABLE_NAME = 'note_files' then
                        v_table_id := (v_row ->> 'note_id')::uuid;
                    elsif TG_TABLE_NAME = 'link_predicate_rules' then
                        v_table_id := (v_row ->> 'uuid_id')::uuid;
                    else
                        v_table_id := (v_row ->> 'id')::uuid;
                    end if;

                    -- Extract nook_id
                    if TG_TABLE_NAME = 'nooks' then
                        v_nook_id := (v_row ->> 'id')::uuid;
                    elsif TG_TABLE_NAME = 'note_files' then
                        select nook_id into v_nook_id from global.notes where id = v_table_id;
                    elsif TG_TABLE_NAME = 'link_predicate_rules' then
                        select nook_id into v_nook_id from global.link_predicates where id = (v_row ->> 'predicate_id')::uuid;
                    elsif TG_TABLE_NAME = 'note_cross_links' then
                        v_nook_id := (v_row ->> 'source_nook_id')::uuid;
                    elsif TG_TABLE_NAME in ('users') then
                        v_nook_id := null;
                    else
                        v_nook_id := (v_row ->> 'nook_id')::uuid;
                    end if;

                    -- Version: increment from the row itself (no lookup needed)
                    if (TG_OP = 'INSERT') then
                        v_version := 1;
                    else
                        v_version := OLD.version + 1;
                    end if;

                    insert into global.audit_meta (prev_id, nook_id, table_name, table_id, action, user_id, actor, version)
                    values (
                        v_prev_id,
                        v_nook_id,
                        TG_TABLE_NAME,
                        v_table_id,
                        TG_OP::global.audit_action,
                        v_user_id,
                        v_actor,
                        v_version
                    )
                    returning id into v_meta_id;

                    insert into global.audit_data (meta_id, data)
                    values (
                        v_meta_id,
                        v_row - 'history_id'
                    );

                    -- Populate audit_meta_refs for note-related changes
                    if TG_TABLE_NAME = 'notes' then
                        insert into global.audit_meta_refs (meta_id, note_id) values (v_meta_id, v_table_id);
                    elsif TG_TABLE_NAME = 'note_links' then
                        insert into global.audit_meta_refs (meta_id, note_id)
                        values (v_meta_id, (v_row ->> 'source_note_id')::uuid);
                        insert into global.audit_meta_refs (meta_id, note_id)
                        values (v_meta_id, (v_row ->> 'target_note_id')::uuid)
                        on conflict do nothing;
                    elsif TG_TABLE_NAME = 'note_cross_links' then
                        insert into global.audit_meta_refs (meta_id, note_id)
                        values (v_meta_id, (v_row ->> 'source_note_id')::uuid);
                        insert into global.audit_meta_refs (meta_id, note_id)
                        values (v_meta_id, (v_row ->> 'target_note_id')::uuid)
                        on conflict do nothing;
                    elsif TG_TABLE_NAME = 'note_files' then
                        insert into global.audit_meta_refs (meta_id, note_id) values (v_meta_id, (v_row ->> 'note_id')::uuid);
                    end if;

                    if (TG_OP = 'DELETE') then
                        return OLD;
                    end if;

                    NEW.history_id := v_meta_id;
                    NEW.version := v_version;
                    return NEW;
                end;
                \$fn\$;
            ");

            // Attach triggers to all audited tables (including the ones with adapted PKs)
            $allAuditedTables = array_merge($auditedTables, ['nook_members', 'link_predicate_rules']);
            foreach ($allAuditedTables as $table) {
                $triggerName = "audit_{$table}_trg";
                $pdo->exec("
                    do \$\$ begin
                        if not exists (
                            select 1 from pg_trigger where tgname = '{$triggerName}'
                            and tgrelid = 'global.{$table}'::regclass
                        ) then
                            create trigger {$triggerName}
                                before insert or update or delete on global.{$table}
                                for each row execute function global.audit_trigger_fn();
                        end if;
                    end \$\$;
                ");
            }
        } finally {
            $pdo->exec("select pg_advisory_unlock(hashtext('paith_notes_global_schema_ensure'))");
        }
    }
}
