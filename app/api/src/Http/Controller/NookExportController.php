<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\Controller\Export\AttributeMarkdownRenderer;
use Paith\Notes\Api\Http\Controller\Export\DashboardRenderer;
use Paith\Notes\Api\Http\Controller\Export\ExportHelpers;
use Paith\Notes\Api\Http\Controller\Export\NoteLinker;
use Paith\Notes\Api\Http\Controller\Export\NoteMarkdownWriter;
use Paith\Notes\Api\Http\FileResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use PDO;
use ZipArchive;

/**
 * Export a nook as a ZIP archive and store the backup as a note.
 *
 * GET /nooks/{nookId}/export  — owner only
 */
final class NookExportController
{
    /** Bump when export structure changes. */
    private const EXPORT_SCHEMA_VERSION = 1;

    private const BACKUP_TYPE_KEY = 'nook-backup';
    private const BACKUP_TYPE_LABEL = 'Nook Backup';
    private const BACKUP_ATTR_KEY = 'backup-file';

    // ── Route handler ───────────────────────────────────────────

    public function export(Request $request, Context $context): Response
    {
        $pdo = $context->pdo();
        $user = $context->user();
        $nookId = $request->routeParam('nookId');
        $userId = is_scalar($user['id'] ?? null) ? (string) $user['id'] : '';

        NookAccess::requireOwner($pdo, $user, $nookId);

        // Derive app base URL for cross-nook links
        $host = $request->header('Host') ?? $request->header('X-Forwarded-Host') ?? '';
        $proto = ($request->header('X-Forwarded-Proto') ?? 'https');
        $appBaseUrl = $host !== '' ? "{$proto}://{$host}" : '';

        $result = self::exportAndStore($pdo, $nookId, $userId, $appBaseUrl);

        return new FileResponse($result['zip_path'], 200, [
            'Content-Type' => 'application/zip',
            'Content-Disposition' => "attachment; filename=\"{$result['filename']}\"",
            'Content-Length' => (string) filesize($result['zip_path']),
        ]);
    }

    // ── Public API ──────────────────────────────────────────────

    /**
     * Export a nook, store the backup as a note, return info.
     *
     * @return array{zip_path: string, filename: string, note_id: string}
     */
    public static function exportAndStore(PDO $pdo, string $nookId, string $userId, string $appBaseUrl = ''): array
    {
        $backupTypeId = self::ensureBackupType($pdo, $nookId);
        $stats = ['notes' => 0, 'types' => 0, 'attributes' => 0, 'links' => 0, 'predicates' => 0, 'files' => 0];
        $zipPath = self::exportNookZip($pdo, $nookId, $backupTypeId, $stats, $appBaseUrl);

        $nook = $pdo->prepare('select name from global.nooks where id = :id');
        $nook->execute([':id' => $nookId]);
        $nookName = (string) ($nook->fetchColumn() ?: 'export');
        $safeName = preg_replace('/[^a-zA-Z0-9_-]/', '-', $nookName);
        $date = date('Y-m-d_His');
        $filename = "{$safeName}_{$date}.zip";

        $noteId = self::createBackupNote($pdo, $nookId, $userId, $backupTypeId, $zipPath, $filename, $stats);

        return ['zip_path' => $zipPath, 'filename' => $filename, 'note_id' => $noteId];
    }

    // ── ZIP builder ─────────────────────────────────────────────

    /**
     * Build the export ZIP. Excludes backup-type notes.
     *
     * @param array<string, int> $stats  Populated with counts
     */
    public static function exportNookZip(PDO $pdo, string $nookId, ?string $excludeTypeId, array &$stats, string $appBaseUrl = ''): string
    {
        $tmpFile = tempnam(sys_get_temp_dir(), 'nook-export-') . '.zip';
        $zip = new ZipArchive();
        if ($zip->open($tmpFile, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            throw new \RuntimeException('Failed to create ZIP archive');
        }

        // ── Nook metadata ───────────────────────────────────────
        $nook = $pdo->prepare('select id, name, purpose from global.nooks where id = :id');
        $nook->execute([':id' => $nookId]);
        $nookRow = $nook->fetch(PDO::FETCH_ASSOC);
        if (!is_array($nookRow)) throw new \RuntimeException('Nook not found');

        // ── Query all metadata ──────────────────────────────────
        $typeList = self::queryTypes($pdo, $nookId, $excludeTypeId);
        $typeIds = array_column($typeList, 'id');
        $typeIdSet = array_flip($typeIds);

        $attrList = self::queryAttributes($pdo, $nookId, $typeIdSet);
        [$predList, $ruleList] = self::queryPredicates($pdo, $nookId);
        $linkList = self::queryLinks($pdo, $nookId);

        $stats['types'] = count($typeList);
        $stats['attributes'] = count($attrList);
        $stats['predicates'] = count($predList);
        $stats['links'] = count($linkList);

        // Write meta JSONs
        $zip->addFromString('meta/types.json', ExportHelpers::jsonEncode($typeList));
        $zip->addFromString('meta/attributes.json', ExportHelpers::jsonEncode($attrList));
        $zip->addFromString('meta/predicates.json', ExportHelpers::jsonEncode(['predicates' => $predList, 'rules' => $ruleList]));
        $zip->addFromString('meta/links.json', ExportHelpers::jsonEncode($linkList));

        // File metadata
        $fileMetaList = self::queryFileMetadata($pdo, $nookId);
        $zip->addFromString('meta/files.json', ExportHelpers::jsonEncode($fileMetaList));

        // ── Build lookup tables ─────────────────────────────────
        $typeById = [];
        foreach ($typeList as $t) $typeById[$t['id']] = $t;
        $typeFolders = ExportHelpers::buildTypeFolders($typeById);

        $attrById = [];
        foreach ($attrList as $a) $attrById[$a['id']] = $a;

        $predLabelById = [];
        foreach ($predList as $p) $predLabelById[$p['id']] = $p['forward_label'];

        // Users + last updaters
        $userNames = self::queryUserNames($pdo);
        $lastUpdaters = self::queryLastUpdaters($pdo, $nookId);

        // ── Note file metadata ──────────────────────────────────
        $noteFiles = [];
        foreach ($fileMetaList as $f) {
            $noteFiles[$f['note_id']][] = $f;
        }

        // ── First pass: assign paths ────────────────────────────
        $notesSql = self::buildNotesWhere($excludeTypeId);
        $notesParams = [':nook_id' => $nookId];
        if ($excludeTypeId) $notesParams[':exclude_type'] = $excludeTypeId;

        $notes = $pdo->prepare("select id, title, type_id from global.notes where {$notesSql} order by created_at");
        $notes->execute($notesParams);

        $noteMap = [];
        $noteTitles = [];
        $pathCounts = [];

        while ($n = $notes->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($n)) continue;
            $id = (string) $n['id'];
            $title = (string) ($n['title'] ?: 'Untitled');
            $noteTitles[$id] = $title;

            $folder = isset($n['type_id'], $typeFolders[$n['type_id']]) ? $typeFolders[$n['type_id']] : '';
            $safeTitle = ExportHelpers::safeFilename($title);
            $basePath = $folder !== '' ? "{$folder}/{$safeTitle}" : $safeTitle;

            if (isset($pathCounts[$basePath])) {
                $pathCounts[$basePath]++;
                $basePath .= " ({$pathCounts[$basePath]})";
            } else {
                $pathCounts[$basePath] = 1;
            }
            $noteMap[$id] = "{$basePath}.md";
        }

        // ── Links & mentions by source ──────────────────────────
        $linksBySource = [];
        foreach ($linkList as $l) {
            $linksBySource[$l['source_note_id']][] = [
                'predicate' => $predLabelById[$l['predicate_id']] ?? 'links to',
                'target_id' => $l['target_note_id'],
            ];
        }

        $mentionsBySource = [];
        $mentionsStmt = $pdo->prepare(
            'select source_note_id, target_note_id from global.note_mentions where source_note_id in (select id from global.notes where nook_id = :nook_id) order by position'
        );
        $mentionsStmt->execute([':nook_id' => $nookId]);
        while ($m = $mentionsStmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($m)) continue;
            $mentionsBySource[$m['source_note_id']][] = $m['target_note_id'];
        }

        // ── Shared lookups for note rendering ───────────────────
        $lookups = compact('typeById', 'attrById', 'attrList', 'noteMap', 'noteTitles',
            'noteFiles', 'linksBySource', 'mentionsBySource', 'userNames', 'lastUpdaters', 'typeFolders', 'appBaseUrl');

        // ── Second pass: write .md files + zip files ────────────
        $dataPath = ExportHelpers::dataPath();
        $notes2 = $pdo->prepare("select id, title, type_id, created_by, created_at, updated_at, version, content, attributes from global.notes where {$notesSql} order by created_at");
        $notes2->execute($notesParams);

        $noteCount = 0;
        while ($n = $notes2->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($n)) continue;
            $noteCount++;
            $id = (string) $n['id'];

            // Write .md
            $md = NoteMarkdownWriter::render($n, $lookups);
            $zip->addFromString("notes/{$noteMap[$id]}", $md);

            // Add files to zip directly from disk
            foreach ($noteFiles[$id] ?? [] as $f) {
                $objectKey = (string) ($f['object_key'] ?? '');
                $diskPath = "{$dataPath}/{$objectKey}";
                if ($objectKey === '' || !file_exists($diskPath)) continue;

                $filename = (string) ($f['filename'] ?? 'file');
                $ext = (string) ($f['extension'] ?? '');
                $fullFilename = $ext !== '' ? "{$filename}.{$ext}" : $filename;
                $attrName = isset($f['attribute_id'], $attrById[$f['attribute_id']])
                    ? ExportHelpers::safeFilename($attrById[$f['attribute_id']]['name'])
                    : null;
                $fileZipPath = $attrName
                    ? "files/{$id}/{$attrName}/{$fullFilename}"
                    : "files/{$id}/{$fullFilename}";

                $zip->addFile($diskPath, $fileZipPath);
                $stats['files']++;
            }
        }
        $stats['notes'] = $noteCount;

        // ── Dashboard pages ─────────────────────────────────────
        $notesByFolder = [];
        foreach ($noteMap as $id => $path) {
            $folder = dirname($path);
            if ($folder === '.') $folder = '';
            $notesByFolder[$folder][] = ['id' => $id, 'path' => $path, 'title' => $noteTitles[$id] ?? $id];
        }

        // Type _index.md pages
        foreach ($typeList as $type) {
            $folder = $typeFolders[$type['id']] ?? null;
            if ($folder === null) continue;
            $folderNotes = $notesByFolder[$folder] ?? [];
            $zip->addFromString("notes/{$folder}/_index.md", DashboardRenderer::buildTypeIndex($type, $typeById, $folderNotes));
        }

        // Dashboard + unlinked
        $zip->addFromString('notes/index.md', DashboardRenderer::buildDashboard(
            (string) $nookRow['name'], $typeList, $typeFolders, $notesByFolder, $noteMap, $noteTitles, $linkList, $stats,
        ));

        $linkedIds = [];
        foreach ($linkList as $l) {
            $linkedIds[$l['source_note_id']] = true;
            $linkedIds[$l['target_note_id']] = true;
        }
        $unlinked = [];
        foreach ($noteMap as $nid => $npath) {
            if (!isset($linkedIds[$nid])) {
                $unlinked[] = ['id' => $nid, 'path' => $npath, 'title' => $noteTitles[$nid] ?? $nid];
            }
        }
        $zip->addFromString('notes/unlinked.md', DashboardRenderer::buildUnlinkedPage($unlinked));

        // ── Manifest + README + map ─────────────────────────────
        $zip->addFromString('notes/map.json', ExportHelpers::jsonEncode($noteMap));

        $exportedAt = date('c');
        $nookName = (string) $nookRow['name'];
        $zip->addFromString('manifest.json', ExportHelpers::jsonEncode([
            'schema_version' => self::EXPORT_SCHEMA_VERSION,
            'version' => 1,
            'exported_at' => $exportedAt,
            'nook' => ['id' => $nookRow['id'], 'name' => $nookName, 'purpose' => (string) ($nookRow['purpose'] ?? 'general')],
            'stats' => $stats,
        ]));
        $zip->addFromString('README.md', DashboardRenderer::buildReadme($nookName, $exportedAt, $stats));

        if ($stats['files'] === 0) $zip->addEmptyDir('files');

        $zip->close();
        return $tmpFile;
    }

    // ── Backup note ─────────────────────────────────────────────

    private static function ensureBackupType(PDO $pdo, string $nookId): string
    {
        $check = $pdo->prepare('select id from global.note_types where nook_id = :nook_id and key = :key');
        $check->execute([':nook_id' => $nookId, ':key' => self::BACKUP_TYPE_KEY]);
        $typeId = $check->fetchColumn();
        if ($typeId) return (string) $typeId;

        $baseCheck = $pdo->prepare("select id from global.note_types where nook_id = :nook_id and key = 'base'");
        $baseCheck->execute([':nook_id' => $nookId]);
        $baseTypeId = $baseCheck->fetchColumn() ?: null;

        $create = $pdo->prepare(
            'insert into global.note_types (nook_id, key, label, description, parent_id) '
            . 'values (:nook_id, :key, :label, :description, :parent_id) returning id'
        );
        $create->execute([
            ':nook_id' => $nookId, ':key' => self::BACKUP_TYPE_KEY,
            ':label' => self::BACKUP_TYPE_LABEL, ':description' => 'Automatic nook backup snapshots',
            ':parent_id' => $baseTypeId,
        ]);
        $typeId = (string) $create->fetchColumn();

        $pdo->prepare(
            "insert into global.type_attributes (nook_id, type_id, key, name, kind, config) "
            . "values (:nook_id, :type_id, :key, 'Backup File', 'file', '{\"display\": \"download\"}'::jsonb) on conflict do nothing"
        )->execute([':nook_id' => $nookId, ':type_id' => $typeId, ':key' => self::BACKUP_ATTR_KEY]);

        return $typeId;
    }

    private static function createBackupNote(PDO $pdo, string $nookId, string $userId, string $backupTypeId, string $zipPath, string $filename, array $stats): string
    {
        $filesize = filesize($zipPath);
        $checksum = md5_file($zipPath);
        $date = date('Y-m-d H:i:s');
        $sizeHuman = ExportHelpers::humanFilesize((int) $filesize);

        $content = "## Backup — {$date}\n\n"
            . "| Stat | Count |\n|---|---|\n"
            . "| Notes | {$stats['notes']} |\n"
            . "| Types | {$stats['types']} |\n"
            . "| Attributes | {$stats['attributes']} |\n"
            . "| Link predicates | {$stats['predicates']} |\n"
            . "| Note links | {$stats['links']} |\n"
            . "| Files | {$stats['files']} |\n"
            . "| Archive size | {$sizeHuman} |\n";

        $pdo->beginTransaction();
        try {
            $noteStmt = $pdo->prepare(
                "insert into global.notes (nook_id, created_by, title, content, type_id) "
                . "values (:nook_id, :created_by, :title, :content, :type_id) returning id"
            );
            $noteStmt->execute([
                ':nook_id' => $nookId, ':created_by' => $userId,
                ':title' => "Backup {$date}", ':content' => $content, ':type_id' => $backupTypeId,
            ]);
            $noteId = (string) $noteStmt->fetchColumn();

            $attrStmt = $pdo->prepare('select id from global.type_attributes where type_id = :type_id and key = :key');
            $attrStmt->execute([':type_id' => $backupTypeId, ':key' => self::BACKUP_ATTR_KEY]);
            $attributeId = (string) $attrStmt->fetchColumn();

            $objectKey = sprintf('notes/%s/files/%s/%s/v1', $nookId, $noteId, $attributeId);
            $dataPath = ExportHelpers::dataPath();
            $destPath = "{$dataPath}/{$objectKey}";
            $destDir = dirname($destPath);
            if (!is_dir($destDir)) mkdir($destDir, 0755, true);
            $tmpDest = $destPath . '.tmp';
            copy($zipPath, $tmpDest);
            rename($tmpDest, $destPath);

            $pdo->prepare(
                "insert into global.note_files (note_id, object_key, filename, extension, filesize, mime_type, checksum, nook_id, uploaded_by, attribute_id, file_version) "
                . "values (:note_id, :object_key, :filename, 'zip', :filesize, 'application/zip', :checksum, :nook_id, :uploaded_by, :attribute_id, 1)"
            )->execute([
                ':note_id' => $noteId, ':object_key' => $objectKey, ':filename' => $filename,
                ':filesize' => $filesize, ':checksum' => $checksum, ':nook_id' => $nookId,
                ':uploaded_by' => $userId, ':attribute_id' => $attributeId,
            ]);

            $pdo->prepare("update global.notes set attributes = attributes || :attr where id = :id")
                ->execute([':attr' => json_encode([$attributeId => 1]), ':id' => $noteId]);

            $pdo->commit();
            return $noteId;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    // ── Query helpers ───────────────────────────────────────────

    private static function buildNotesWhere(?string $excludeTypeId): string
    {
        $where = 'nook_id = :nook_id';
        if ($excludeTypeId) $where .= ' and (type_id is null or type_id != :exclude_type)';
        return $where;
    }

    private static function queryTypes(PDO $pdo, string $nookId, ?string $excludeTypeId): array
    {
        $sql = 'select id, key, label, description, parent_id, attribute_layout, config_overrides, created_at from global.note_types where nook_id = :nook_id';
        $params = [':nook_id' => $nookId];
        if ($excludeTypeId) { $sql .= ' and id != :exclude_type'; $params[':exclude_type'] = $excludeTypeId; }
        $sql .= ' order by created_at';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);

        $list = [];
        while ($t = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($t)) continue;
            $entry = ['id' => $t['id'], 'key' => $t['key'], 'label' => $t['label'], 'description' => $t['description'] ?? '', 'parent_id' => $t['parent_id'], 'created_at' => $t['created_at'] ?? null];
            if (!empty($t['attribute_layout'])) {
                $d = is_string($t['attribute_layout']) ? json_decode($t['attribute_layout'], true) : $t['attribute_layout'];
                if ($d) $entry['attribute_layout'] = $d;
            }
            if (!empty($t['config_overrides']) && $t['config_overrides'] !== '{}') {
                $d = is_string($t['config_overrides']) ? json_decode($t['config_overrides'], true) : $t['config_overrides'];
                if ($d) $entry['config_overrides'] = $d;
            }
            $list[] = $entry;
        }
        return $list;
    }

    private static function queryAttributes(PDO $pdo, string $nookId, array $typeIdSet): array
    {
        $stmt = $pdo->prepare('select id, type_id, key, name, kind, config, indexed from global.type_attributes where nook_id = :nook_id order by created_at');
        $stmt->execute([':nook_id' => $nookId]);
        $list = [];
        while ($a = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($a) || !isset($typeIdSet[$a['type_id']])) continue;
            $config = is_string($a['config'] ?? null) ? json_decode($a['config'], true) : ($a['config'] ?? []);
            $list[] = ['id' => $a['id'], 'type_id' => $a['type_id'], 'key' => $a['key'], 'name' => $a['name'], 'kind' => $a['kind'], 'config' => $config ?: new \stdClass(), 'indexed' => (bool) ($a['indexed'] ?? false)];
        }
        return $list;
    }

    private static function queryPredicates(PDO $pdo, string $nookId): array
    {
        $stmt = $pdo->prepare('select id, key, forward_label, reverse_label, supports_start_date, supports_end_date from global.link_predicates where nook_id = :nook_id order by created_at');
        $stmt->execute([':nook_id' => $nookId]);
        $predList = [];
        $predIds = [];
        while ($p = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($p)) continue;
            $predIds[] = $p['id'];
            $predList[] = ['id' => $p['id'], 'key' => $p['key'], 'forward_label' => $p['forward_label'], 'reverse_label' => $p['reverse_label'], 'supports_start_date' => (bool) ($p['supports_start_date'] ?? false), 'supports_end_date' => (bool) ($p['supports_end_date'] ?? false)];
        }

        $ruleList = [];
        if ($predIds) {
            $ph = implode(',', array_fill(0, count($predIds), '?'));
            $rules = $pdo->prepare("select predicate_id, source_type_id, target_type_id, include_source_subtypes, include_target_subtypes from global.link_predicate_rules where predicate_id in ({$ph})");
            $rules->execute($predIds);
            while ($r = $rules->fetch(PDO::FETCH_ASSOC)) {
                if (!is_array($r)) continue;
                $ruleList[] = ['predicate_id' => $r['predicate_id'], 'source_type_id' => $r['source_type_id'], 'target_type_id' => $r['target_type_id'], 'include_source_subtypes' => (bool) ($r['include_source_subtypes'] ?? true), 'include_target_subtypes' => (bool) ($r['include_target_subtypes'] ?? true)];
            }
        }
        return [$predList, $ruleList];
    }

    private static function queryLinks(PDO $pdo, string $nookId): array
    {
        $stmt = $pdo->prepare('select id, predicate_id, source_note_id, target_note_id, start_date, end_date from global.note_links where nook_id = :nook_id order by created_at');
        $stmt->execute([':nook_id' => $nookId]);
        $list = [];
        while ($l = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($l)) continue;
            $entry = ['id' => $l['id'], 'predicate_id' => $l['predicate_id'], 'source_note_id' => $l['source_note_id'], 'target_note_id' => $l['target_note_id']];
            if ($l['start_date'] ?? null) $entry['start_date'] = $l['start_date'];
            if ($l['end_date'] ?? null) $entry['end_date'] = $l['end_date'];
            $list[] = $entry;
        }
        return $list;
    }

    private static function queryFileMetadata(PDO $pdo, string $nookId): array
    {
        $stmt = $pdo->prepare('select nf.note_id, nf.object_key, nf.filename, nf.extension, nf.mime_type, nf.filesize, nf.checksum, nf.attribute_id, nf.file_version from global.note_files nf join global.notes n on n.id = nf.note_id where n.nook_id = :nook_id');
        $stmt->execute([':nook_id' => $nookId]);
        $list = [];
        while ($f = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($f)) continue;
            $list[] = ['note_id' => $f['note_id'], 'object_key' => $f['object_key'], 'filename' => $f['filename'], 'extension' => $f['extension'], 'mime_type' => $f['mime_type'], 'filesize' => (int) ($f['filesize'] ?? 0), 'checksum' => $f['checksum'] ?? '', 'attribute_id' => $f['attribute_id'], 'file_version' => (int) ($f['file_version'] ?? 1)];
        }
        return $list;
    }

    private static function queryUserNames(PDO $pdo): array
    {
        $names = [];
        $stmt = $pdo->query('select id, first_name, last_name, username from global.users');
        while ($u = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($u)) continue;
            $name = trim(($u['first_name'] ?? '') . ' ' . ($u['last_name'] ?? ''));
            if ($name === '') $name = (string) ($u['username'] ?? $u['id']);
            $names[$u['id']] = $name;
        }
        return $names;
    }

    private static function queryLastUpdaters(PDO $pdo, string $nookId): array
    {
        $stmt = $pdo->prepare("select distinct on (entity_id) entity_id, user_id from global.audit_meta where table_name = 'notes' and nook_id = :nook_id and action in ('UPDATE', 'INSERT') order by entity_id, created_at desc");
        $stmt->execute([':nook_id' => $nookId]);
        $map = [];
        while ($a = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($a)) continue;
            $map[$a['entity_id']] = $a['user_id'];
        }
        return $map;
    }
}
