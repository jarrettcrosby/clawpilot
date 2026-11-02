<?php
declare(strict_types=1);
// ClawPilot managed native record lifecycle installer v1. Offline files only.
// Default CLI is read-only. Explicit apply does not enable the runtime flag.
// Run before serving traffic. If an Email route installer is present, run this
// afterwards; Email support is not a prerequisite for record lifecycle support.
// php /opt/clawpilot/install-record-lifecycle.php --check /app/public/legacy
// php /opt/clawpilot/install-record-lifecycle.php --apply /app/public/legacy

const CLAWPILOT_RECORD_LIFECYCLE_MARKER = 'ClawPilot managed native record lifecycle inspection v1.';
const CLAWPILOT_RECORD_LIFECYCLE_ROUTER = "<?php\n// ClawPilot managed standalone record lifecycle router v1.\n";
const CLAWPILOT_RECORD_LIFECYCLE_ROUTE_BLOCK = "\n// BEGIN ClawPilot record lifecycle route v1\nrequire_once 'custom/include/ClawPilot/record-lifecycle-routes.php';\n// END ClawPilot record lifecycle route v1\n";

function clawpilot_record_lifecycle_install_need(bool $condition): void
{
    if (!$condition) throw new RuntimeException('Record lifecycle installation requires review');
}

function clawpilot_record_lifecycle_install_path(string $legacyRoot, string $relative): string
{
    clawpilot_record_lifecycle_install_need(!str_contains($relative, "\0") && !str_starts_with($relative, '/')
        && preg_match('~(?:^|/)(?:\.|\.\.)(?:/|$)~', $relative) !== 1);
    $path = $legacyRoot;
    foreach (explode('/', $relative) as $part) {
        clawpilot_record_lifecycle_install_need($part !== '');
        $path .= '/'.$part;
        clawpilot_record_lifecycle_install_need(!is_link($path));
    }
    return $path;
}

function clawpilot_record_lifecycle_install_read(string $path): ?string
{
    if (!file_exists($path)) return null;
    $stat = lstat($path);
    clawpilot_record_lifecycle_install_need(is_array($stat) && ($stat['mode'] & 0170000) === 0100000
        && $stat['nlink'] === 1 && $stat['size'] <= 1048576 && !is_link($path));
    $contents = file_get_contents($path);
    clawpilot_record_lifecycle_install_need(is_string($contents) && strlen($contents) === $stat['size']);
    return $contents;
}

function install_clawpilot_record_lifecycle(string $sourceRoot, string $legacyRoot, bool $apply = false): array
{
    clawpilot_record_lifecycle_install_need(realpath($legacyRoot) === $legacyRoot && is_dir($legacyRoot)
        && !is_link($legacyRoot) && realpath($sourceRoot) === $sourceRoot && is_dir($sourceRoot));
    $routeRelative = 'custom/application/Ext/Api/V8/Config/routes.php';
    $routePath = clawpilot_record_lifecycle_install_path($legacyRoot, $routeRelative);
    $route = clawpilot_record_lifecycle_install_read($routePath);
    // Do not replace somebody else's router. Preserve all pre-existing managed
    // routes byte-for-byte; the only aggregate change is our one trailing include.
    clawpilot_record_lifecycle_install_need($route === null || (str_starts_with($route, '<?php')
        && (str_contains($route, 'ClawPilot managed native Email audience proof v1.')
            || str_starts_with($route, CLAWPILOT_RECORD_LIFECYCLE_ROUTER)) && !str_contains($route, '?>')));
    $baseRoute = $route ?? CLAWPILOT_RECORD_LIFECYCLE_ROUTER;
    if ($route !== null && str_contains($route, 'ClawPilot record lifecycle route v1')) {
        clawpilot_record_lifecycle_install_need(str_ends_with($route, CLAWPILOT_RECORD_LIFECYCLE_ROUTE_BLOCK)
            && substr_count($route, CLAWPILOT_RECORD_LIFECYCLE_ROUTE_BLOCK) === 1);
        $baseRoute = substr($route, 0, -strlen(CLAWPILOT_RECORD_LIFECYCLE_ROUTE_BLOCK));
        clawpilot_record_lifecycle_install_need(!str_contains($baseRoute, 'ClawPilot record lifecycle route v1'));
    }
    $pending = []; $before = [];
    foreach (['RecordLifecycle.php'=>'custom/include/ClawPilot/RecordLifecycle.php',
        'routes.php'=>'custom/include/ClawPilot/record-lifecycle-routes.php'] as $source => $relative) {
        $sourcePath = clawpilot_record_lifecycle_install_path($sourceRoot, $source);
        $contents = clawpilot_record_lifecycle_install_read($sourcePath);
        clawpilot_record_lifecycle_install_need(is_string($contents) && str_contains($contents, CLAWPILOT_RECORD_LIFECYCLE_MARKER));
        token_get_all($contents, TOKEN_PARSE);
        $path = clawpilot_record_lifecycle_install_path($legacyRoot, $relative);
        $current = clawpilot_record_lifecycle_install_read($path);
        clawpilot_record_lifecycle_install_need($current === null || str_contains($current, CLAWPILOT_RECORD_LIFECYCLE_MARKER));
        $before[$path] = $current; $pending[$path] = $contents;
    }
    // Publish the router LAST: a partial installation cannot expose a missing helper.
    $before[$routePath] = $route; $pending[$routePath] = $baseRoute.CLAWPILOT_RECORD_LIFECYCLE_ROUTE_BLOCK;
    foreach ($pending as $contents) token_get_all($contents, TOKEN_PARSE);
    $changed = array_keys(array_filter($pending, static fn($contents, $path) => $before[$path] !== $contents, ARRAY_FILTER_USE_BOTH));
    if (!$apply || !$changed) return ['version'=>1,'status'=>$changed ? 'ready' : 'installed','changedFiles'=>count($changed)];
    $routeDirectory = dirname($routePath);
    clawpilot_record_lifecycle_install_need(is_dir($routeDirectory) || mkdir($routeDirectory, 0755, true));
    clawpilot_record_lifecycle_install_path($legacyRoot, $routeRelative);
    $lockPath = clawpilot_record_lifecycle_install_path($legacyRoot, 'custom/application/Ext/Api/V8/Config/.clawpilot-record-lifecycle.lock');
    $lock = fopen($lockPath, 'c+b');
    clawpilot_record_lifecycle_install_need(is_resource($lock));
    try {
        clawpilot_record_lifecycle_install_need(flock($lock, LOCK_EX | LOCK_NB));
        foreach ($pending as $path => $contents) {
            clawpilot_record_lifecycle_install_need(clawpilot_record_lifecycle_install_read($path) === $before[$path]);
        }
        foreach ($pending as $path => $contents) {
            if ($before[$path] === $contents) continue;
            $directory = dirname($path);
            clawpilot_record_lifecycle_install_need(is_dir($directory) || mkdir($directory, 0755, true));
            clawpilot_record_lifecycle_install_path($legacyRoot, substr($path, strlen($legacyRoot) + 1));
            $temporary = tempnam($directory, '.clawpilot-record-lifecycle-');
            clawpilot_record_lifecycle_install_need(is_string($temporary));
            try {
                clawpilot_record_lifecycle_install_need(file_put_contents($temporary, $contents, LOCK_EX) === strlen($contents)
                    && chmod($temporary, 0644)
                    && clawpilot_record_lifecycle_install_read($path) === $before[$path]
                    && rename($temporary, $path));
            } finally { if (is_file($temporary)) unlink($temporary); }
        }
        return ['version'=>1,'status'=>'installed','changedFiles'=>count($changed)];
    } finally { flock($lock, LOCK_UN); fclose($lock); }
}

if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    $mode = $argv[1] ?? '--check';
    clawpilot_record_lifecycle_install_need(in_array($mode, ['--check','--apply'], true) && count($argv) === 3);
    $result = install_clawpilot_record_lifecycle(__DIR__.'/record-lifecycle', $argv[2], $mode === '--apply');
    fwrite(STDOUT, json_encode($result, JSON_THROW_ON_ERROR)."\n");
}
