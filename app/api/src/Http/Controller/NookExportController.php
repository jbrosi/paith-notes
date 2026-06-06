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
use Paith\Notes\Shared\Db\Row;
use PDO;
use ZipArchive;

/**
 * Export a nook as a ZIP archive and store the backup as a note.
 *
 * GET /nooks/{nookId}/export  — owner only
 *
 * @phpstan-import-type TypeRow from Export\ExportTypes
 * @phpstan-import-type AttrRow from Export\ExportTypes
 * @phpstan-import-type FileRow from Export\ExportTypes
 * @phpstan-import-type LinkRow from Export\ExportTypes
 * @phpstan-import-type PredRow from Export\ExportTypes
 * @phpstan-import-type Lookups from Export\ExportTypes
 * @phpstan-import-type NoteLinkSummary from Export\ExportTypes
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
        $host = $request->header('Host');
        if ($host === '') {
            $host = $request->header('X-Forwarded-Host');
        }
        $protoHeader = $request->header('X-Forwarded-Proto');
        $proto = $protoHeader !== '' ? $protoHeader : 'https';
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
        if (!is_array($nookRow)) {
            throw new \RuntimeException('Nook not found');
        }

        // ── Query all metadata ──────────────────────────────────
        $typeList = self::queryTypes($pdo, $nookId, $excludeTypeId);
        $typeIds = array_column($typeList, 'id');
        /** @var array<string, true> $typeIdSet */
        $typeIdSet = [];
        foreach ($typeIds as $tid) {
            $typeIdSet[$tid] = true;
        }

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
        foreach ($typeList as $t) {
            $typeById[$t['id']] = $t;
        }
        $typeFolders = ExportHelpers::buildTypeFolders($typeById);

        $attrById = [];
        foreach ($attrList as $a) {
            $attrById[$a['id']] = $a;
        }

        $predLabelById = [];
        foreach ($predList as $p) {
            $predLabelById[$p['id']] = $p['forward_label'];
        }

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
        if ($excludeTypeId) {
            $notesParams[':exclude_type'] = $excludeTypeId;
        }

        $notes = $pdo->prepare("select id, title, type_id from global.notes where {$notesSql} order by created_at");
        $notes->execute($notesParams);

        $noteMap = [];
        $noteTitles = [];
        $pathCounts = [];

        while ($n = $notes->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($n)) {
                continue;
            }
            $id = Row::requireStr($n, 'id');
            $titleRaw = Row::str($n, 'title');
            $title = $titleRaw !== '' ? $titleRaw : 'Untitled';
            $noteTitles[$id] = $title;

            $typeId = Row::nullStr($n, 'type_id');
            $folder = ($typeId !== null && isset($typeFolders[$typeId])) ? $typeFolders[$typeId] : '';
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
            if (!is_array($m)) {
                continue;
            }
            $src = Row::str($m, 'source_note_id');
            $tgt = Row::str($m, 'target_note_id');
            if ($src !== '' && $tgt !== '') {
                $mentionsBySource[$src][] = $tgt;
            }
        }

        // ── Shared lookups for note rendering ───────────────────
        $lookups = compact(
            'typeById',
            'attrById',
            'attrList',
            'noteMap',
            'noteTitles',
            'noteFiles',
            'linksBySource',
            'mentionsBySource',
            'userNames',
            'lastUpdaters',
            'typeFolders',
            'appBaseUrl'
        );

        // ── Second pass: write .md files + zip files ────────────
        $dataPath = ExportHelpers::dataPath();
        /** @var array<string, string> file zip path → note uuid */
        $fileMap = [];
        $notes2 = $pdo->prepare("select id, title, type_id, created_by, created_at, updated_at, version, content, attributes from global.notes where {$notesSql} order by created_at");
        $notes2->execute($notesParams);

        $noteCount = 0;
        while ($n = $notes2->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($n)) {
                continue;
            }
            $noteCount++;
            $id = Row::requireStr($n, 'id');

            // Write .md
            $md = NoteMarkdownWriter::render(self::stringKeyed($n), $lookups);
            $zip->addFromString("notes/{$noteMap[$id]}", $md);

            // Add files to zip directly from disk
            foreach ($noteFiles[$id] ?? [] as $f) {
                $objectKey = $f['object_key'];
                $diskPath = "{$dataPath}/{$objectKey}";
                if ($objectKey === '' || !file_exists($diskPath)) {
                    continue;
                }

                $fullFilename = ExportHelpers::buildFilename($f['filename'], $f['extension']);
                $attrName = null;
                if ($f['attribute_id'] !== null && isset($attrById[$f['attribute_id']])) {
                    $attrName = ExportHelpers::safeFilename($attrById[$f['attribute_id']]['name']);
                }
                $noteTitle = $noteTitles[$id] ?? 'Untitled';
                $fileZipPath = ExportHelpers::buildFileZipPath($noteTitle, $attrName, $fullFilename);

                $zip->addFile($diskPath, $fileZipPath);
                $fileMap[$fileZipPath] = $id;
                $stats['files']++;
            }
        }
        $stats['notes'] = $noteCount;

        // ── Dashboard pages ─────────────────────────────────────
        $notesByFolder = [];
        foreach ($noteMap as $id => $path) {
            $folder = dirname($path);
            if ($folder === '.') {
                $folder = '';
            }
            $notesByFolder[$folder][] = ['id' => $id, 'path' => $path, 'title' => $noteTitles[$id] ?? $id];
        }

        // Type _index.md pages
        foreach ($typeList as $type) {
            $folder = $typeFolders[$type['id']] ?? null;
            if ($folder === null) {
                continue;
            }
            $folderNotes = $notesByFolder[$folder] ?? [];
            $zip->addFromString("notes/{$folder}/_index.md", DashboardRenderer::buildTypeIndex($type, $typeById, $folderNotes));
        }

        // Dashboard + unlinked
        $zip->addFromString('notes/index.md', DashboardRenderer::buildDashboard(
            Row::str($nookRow, 'name'),
            $typeList,
            $typeFolders,
            $notesByFolder,
            $noteMap,
            $noteTitles,
            $linkList,
            $stats,
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

        // ── Manifest + README + maps ────────────────────────────
        $zip->addFromString('notes/map.json', ExportHelpers::jsonEncode($noteMap));
        if ($fileMap) {
            $zip->addFromString('files/map.json', ExportHelpers::jsonEncode($fileMap));
        }

        $exportedAt = date('c');
        $nookName = Row::str($nookRow, 'name');
        $nookIdStr = Row::str($nookRow, 'id');
        $nookPurpose = Row::str($nookRow, 'purpose', 'general');
        $zip->addFromString('manifest.json', ExportHelpers::jsonEncode([
            'schema_version' => self::EXPORT_SCHEMA_VERSION,
            'version' => 1,
            'exported_at' => $exportedAt,
            'nook' => ['id' => $nookIdStr, 'name' => $nookName, 'purpose' => $nookPurpose],
            'stats' => $stats,
        ]));
        $zip->addFromString('README.md', DashboardRenderer::buildReadme($nookName, $exportedAt, $stats));

        if ($stats['files'] === 0) {
            $zip->addEmptyDir('files');
        }

        $zip->close();
        return $tmpFile;
    }

    // ── Backup note ─────────────────────────────────────────────

    private static function ensureBackupType(PDO $pdo, string $nookId): string
    {
        $check = $pdo->prepare('select id from global.note_types where nook_id = :nook_id and key = :key');
        $check->execute([':nook_id' => $nookId, ':key' => self::BACKUP_TYPE_KEY]);
        $typeId = $check->fetchColumn();
        if ($typeId) {
            return (string) $typeId;
        }

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

    /**
     * @param array<string, int> $stats
     */
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
            if (!is_dir($destDir)) {
                mkdir($destDir, 0755, true);
            }
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
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    // ── Query helpers ───────────────────────────────────────────

    private static function buildNotesWhere(?string $excludeTypeId): string
    {
        $where = 'nook_id = :nook_id';
        if ($excludeTypeId) {
            $where .= ' and (type_id is null or type_id != :exclude_type)';
        }
        return $where;
    }

    /**
     * @return list<TypeRow>
     */
    private static function queryTypes(PDO $pdo, string $nookId, ?string $excludeTypeId): array
    {
        $sql = 'select id, key, label, description, parent_id, attribute_layout, config_overrides, created_at from global.note_types where nook_id = :nook_id';
        $params = [':nook_id' => $nookId];
        if ($excludeTypeId !== null && $excludeTypeId !== '') {
            $sql .= ' and id != :exclude_type';
            $params[':exclude_type'] = $excludeTypeId;
        }
        $sql .= ' order by created_at';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);

        $list = [];
        while ($t = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($t)) {
                continue;
            }
            $entry = [
                'id' => Row::requireStr($t, 'id'),
                'key' => Row::str($t, 'key'),
                'label' => Row::str($t, 'label'),
                'description' => Row::str($t, 'description'),
                'parent_id' => Row::nullStr($t, 'parent_id'),
                'created_at' => Row::nullStr($t, 'created_at'),
            ];
            $layout = $t['attribute_layout'] ?? null;
            if ($layout !== null && $layout !== '' && $layout !== '{}') {
                $d = is_string($layout) ? json_decode($layout, true) : $layout;
                if (is_array($d)) {
                    $entry['attribute_layout'] = self::stringKeyed($d);
                }
            }
            $overrides = $t['config_overrides'] ?? null;
            if ($overrides !== null && $overrides !== '' && $overrides !== '{}') {
                $d = is_string($overrides) ? json_decode($overrides, true) : $overrides;
                if (is_array($d)) {
                    $entry['config_overrides'] = self::stringKeyed($d);
                }
            }
            $list[] = $entry;
        }
        return $list;
    }

    /**
     * @param array<string, true> $typeIdSet
     * @return list<AttrRow>
     */
    private static function queryAttributes(PDO $pdo, string $nookId, array $typeIdSet): array
    {
        $stmt = $pdo->prepare('select id, type_id, key, name, kind, config, indexed from global.type_attributes where nook_id = :nook_id order by created_at');
        $stmt->execute([':nook_id' => $nookId]);
        $list = [];
        while ($a = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($a)) {
                continue;
            }
            $typeId = Row::str($a, 'type_id');
            if ($typeId === '' || !isset($typeIdSet[$typeId])) {
                continue;
            }
            $configRaw = $a['config'] ?? null;
            $configDecoded = is_string($configRaw) ? json_decode($configRaw, true) : $configRaw;
            $config = is_array($configDecoded) && $configDecoded !== []
                ? self::stringKeyed($configDecoded)
                : new \stdClass();
            $list[] = [
                'id' => Row::requireStr($a, 'id'),
                'type_id' => $typeId,
                'key' => Row::str($a, 'key'),
                'name' => Row::str($a, 'name'),
                'kind' => Row::str($a, 'kind'),
                'config' => $config,
                'indexed' => Row::bool($a, 'indexed'),
            ];
        }
        return $list;
    }

    /**
     * @return array{0: list<PredRow>, 1: list<array{predicate_id: string, source_type_id: string|null, target_type_id: string|null, include_source_subtypes: bool, include_target_subtypes: bool}>}
     */
    private static function queryPredicates(PDO $pdo, string $nookId): array
    {
        $stmt = $pdo->prepare('select id, key, forward_label, reverse_label, supports_start_date, supports_end_date from global.link_predicates where nook_id = :nook_id order by created_at');
        $stmt->execute([':nook_id' => $nookId]);
        $predList = [];
        $predIds = [];
        while ($p = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($p)) {
                continue;
            }
            $id = Row::requireStr($p, 'id');
            $predIds[] = $id;
            $predList[] = [
                'id' => $id,
                'key' => Row::str($p, 'key'),
                'forward_label' => Row::str($p, 'forward_label'),
                'reverse_label' => Row::str($p, 'reverse_label'),
                'supports_start_date' => Row::bool($p, 'supports_start_date'),
                'supports_end_date' => Row::bool($p, 'supports_end_date'),
            ];
        }

        $ruleList = [];
        if ($predIds !== []) {
            $ph = implode(',', array_fill(0, count($predIds), '?'));
            $rules = $pdo->prepare("select predicate_id, source_type_id, target_type_id, include_source_subtypes, include_target_subtypes from global.link_predicate_rules where predicate_id in ({$ph})");
            $rules->execute($predIds);
            while ($r = $rules->fetch(PDO::FETCH_ASSOC)) {
                if (!is_array($r)) {
                    continue;
                }
                $ruleList[] = [
                    'predicate_id' => Row::requireStr($r, 'predicate_id'),
                    'source_type_id' => Row::nullStr($r, 'source_type_id'),
                    'target_type_id' => Row::nullStr($r, 'target_type_id'),
                    'include_source_subtypes' => Row::bool($r, 'include_source_subtypes', true),
                    'include_target_subtypes' => Row::bool($r, 'include_target_subtypes', true),
                ];
            }
        }
        return [$predList, $ruleList];
    }

    /**
     * @return list<LinkRow>
     */
    private static function queryLinks(PDO $pdo, string $nookId): array
    {
        $stmt = $pdo->prepare('select id, predicate_id, source_note_id, target_note_id, start_date, end_date from global.note_links where nook_id = :nook_id order by created_at');
        $stmt->execute([':nook_id' => $nookId]);
        $list = [];
        while ($l = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($l)) {
                continue;
            }
            $entry = [
                'id' => Row::requireStr($l, 'id'),
                'predicate_id' => Row::requireStr($l, 'predicate_id'),
                'source_note_id' => Row::requireStr($l, 'source_note_id'),
                'target_note_id' => Row::requireStr($l, 'target_note_id'),
            ];
            $start = Row::nullStr($l, 'start_date');
            if ($start !== null && $start !== '') {
                $entry['start_date'] = $start;
            }
            $end = Row::nullStr($l, 'end_date');
            if ($end !== null && $end !== '') {
                $entry['end_date'] = $end;
            }
            $list[] = $entry;
        }
        return $list;
    }

    /**
     * @return list<FileRow>
     */
    private static function queryFileMetadata(PDO $pdo, string $nookId): array
    {
        $stmt = $pdo->prepare('select nf.note_id, nf.object_key, nf.filename, nf.extension, nf.mime_type, nf.filesize, nf.checksum, nf.attribute_id, nf.file_version from global.note_files nf join global.notes n on n.id = nf.note_id where n.nook_id = :nook_id');
        $stmt->execute([':nook_id' => $nookId]);
        $list = [];
        while ($f = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($f)) {
                continue;
            }
            $list[] = [
                'note_id' => Row::requireStr($f, 'note_id'),
                'object_key' => Row::str($f, 'object_key'),
                'filename' => Row::str($f, 'filename'),
                'extension' => Row::str($f, 'extension'),
                'mime_type' => Row::str($f, 'mime_type'),
                'filesize' => Row::int($f, 'filesize'),
                'checksum' => Row::str($f, 'checksum'),
                'attribute_id' => Row::nullStr($f, 'attribute_id'),
                'file_version' => Row::int($f, 'file_version', 1),
            ];
        }
        return $list;
    }

    /**
     * @return array<string, string>
     */
    private static function queryUserNames(PDO $pdo): array
    {
        $names = [];
        $stmt = $pdo->query('select id, first_name, last_name, username from global.users');
        if ($stmt === false) {
            return $names;
        }
        while ($u = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($u)) {
                continue;
            }
            $id = Row::str($u, 'id');
            if ($id === '') {
                continue;
            }
            $name = trim(Row::str($u, 'first_name') . ' ' . Row::str($u, 'last_name'));
            if ($name === '') {
                $username = Row::str($u, 'username');
                $name = $username !== '' ? $username : $id;
            }
            $names[$id] = $name;
        }
        return $names;
    }

    /**
     * @return array<string, string>
     */
    private static function queryLastUpdaters(PDO $pdo, string $nookId): array
    {
        $stmt = $pdo->prepare("select distinct on (entity_id) entity_id, user_id from global.audit_meta where table_name = 'notes' and nook_id = :nook_id and action in ('UPDATE', 'INSERT') order by entity_id, created_at desc");
        $stmt->execute([':nook_id' => $nookId]);
        $map = [];
        while ($a = $stmt->fetch(PDO::FETCH_ASSOC)) {
            if (!is_array($a)) {
                continue;
            }
            $entity = Row::str($a, 'entity_id');
            if ($entity !== '') {
                $map[$entity] = Row::str($a, 'user_id');
            }
        }
        return $map;
    }

    /**
     * @param array<array-key, mixed> $arr
     * @return array<string, mixed>
     */
    private static function stringKeyed(array $arr): array
    {
        $out = [];
        foreach ($arr as $k => $v) {
            if (is_string($k)) {
                $out[$k] = $v;
            }
        }
        return $out;
    }
}
