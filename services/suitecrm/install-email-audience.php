<?php
declare(strict_types=1);

/** Install only our owned OAuth route/helper. Refuse unmanaged routes or symlinks. */
function install_clawpilot_email_audience(string $sourceRoot, string $legacyRoot): void
{
    $legacyRoot = realpath($legacyRoot);
    if ($legacyRoot === false || !is_dir($legacyRoot)) {
        throw new RuntimeException('SuiteCRM legacy root is unavailable');
    }
    $files = [
        'EmailAudience.php' => 'custom/include/ClawPilot/EmailAudience.php',
        'routes.php' => 'custom/application/Ext/Api/V8/Config/routes.php',
    ];
    $marker = 'ClawPilot managed native Email audience proof v1.';
    $pending = [];
    foreach ($files as $source => $target) {
        $contents = file_get_contents($sourceRoot . '/' . $source);
        if (!is_string($contents) || strpos($contents, $marker) === false) {
            throw new RuntimeException('Invalid managed Email audience source');
        }
        $path = $legacyRoot . '/' . $target;
        for ($parent = dirname($path); $parent !== $legacyRoot; $parent = dirname($parent)) {
            if (is_link($parent)) {
                throw new RuntimeException('Refusing symlinked Email audience directory');
            }
        }
        if (is_link($path) || (file_exists($path) && strpos((string) file_get_contents($path), $marker) === false)) {
            throw new RuntimeException('Unmanaged native API route/helper requires review');
        }
        if (!file_exists($path) || !hash_equals($contents, (string) file_get_contents($path))) {
            $pending[$path] = $contents;
        }
    }
    foreach ($pending as $path => $contents) {
        $directory = dirname($path);
        if (!is_dir($directory) && !mkdir($directory, 0755, true) && !is_dir($directory)) {
            throw new RuntimeException('Cannot create Email audience directory');
        }
        $temporary = tempnam($directory, '.clawpilot-email-audience-');
        if ($temporary === false) {
            throw new RuntimeException('Cannot stage Email audience source');
        }
        try {
            if (file_put_contents($temporary, $contents, LOCK_EX) !== strlen($contents)
                || !chmod($temporary, 0644) || !rename($temporary, $path)) {
                throw new RuntimeException('Cannot install Email audience source');
            }
        } finally {
            if (is_file($temporary)) {
                unlink($temporary);
            }
        }
    }
}

if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    install_clawpilot_email_audience(__DIR__ . '/email-audience', getcwd());
    fwrite(STDOUT, "Native Email audience proof route source is installed; no permissions changed\n");
}
