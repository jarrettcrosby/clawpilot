<?php
declare(strict_types=1);

/** Install only owned overrides. Never replace an operator's custom action/bean. */
function install_clawpilot_email_search(string $sourceRoot, string $legacyRoot): void
{
    $resolvedRoot = realpath($legacyRoot);
    if ($resolvedRoot === false || !is_dir($resolvedRoot)) {
        throw new RuntimeException('SuiteCRM legacy root is unavailable');
    }
    $legacyRoot = $resolvedRoot;
    $meetingBean = $GLOBALS['beanList']['Meetings'] ?? 'Meeting';
    $customMeetingBean = $GLOBALS['customBeanList']['Meetings'] ?? 'ClawPilotMeeting';
    $customMeetingObject = $GLOBALS['customObjectList']['Meetings'] ?? 'Meeting';
    $customMeetingFile = $GLOBALS['customBeanFiles']['ClawPilotMeeting'] ?? 'custom/include/ClawPilot/MeetingList.php';
    if ($meetingBean !== 'Meeting' || $customMeetingBean !== 'ClawPilotMeeting' || $customMeetingObject !== 'Meeting'
        || isset($GLOBALS['customBeanFiles']['Meeting']) || $customMeetingFile !== 'custom/include/ClawPilot/MeetingList.php') {
        throw new RuntimeException('Unmanaged Meeting bean override requires review');
    }
    $files = [
        // Install dependencies before publishing either entry point.
        'EmailSearch.php' => 'custom/include/ClawPilot/EmailSearch.php',
        'search.results.tpl' => 'custom/include/ClawPilot/search.results.tpl',
        'MeetingList.php' => 'custom/include/ClawPilot/MeetingList.php',
        'MeetingListRegistration.php' => 'custom/Extension/application/Ext/Include/zz_clawpilot_meeting_list.php',
        'Search.php' => 'custom/modules/Home/Search.php',
        'UnifiedSearch.php' => 'custom/modules/Home/UnifiedSearch.php',
    ];
    $marker = 'ClawPilot managed email search presentation v1.';
    $pending = [];
    // Preflight the entire set before writing any file.
    foreach ($files as $source => $target) {
        $contents = file_get_contents($sourceRoot . '/' . $source);
        if (!is_string($contents) || strpos($contents, $marker) === false) {
            throw new RuntimeException('Invalid managed Email search source: ' . $source);
        }
        $path = $legacyRoot . '/' . $target;
        $ancestor = dirname($path);
        while ($ancestor !== $legacyRoot) {
            if (is_link($ancestor)) {
                throw new RuntimeException('Refusing symlinked Email search directory: ' . $target);
            }
            $ancestor = dirname($ancestor);
        }
        if (is_link($path)) {
            throw new RuntimeException('Refusing symlinked Email search override: ' . $target);
        }
        if (file_exists($path)) {
            $current = file_get_contents($path);
            if (!is_string($current) || strpos($current, $marker) === false) {
                throw new RuntimeException('Unmanaged Email search override requires review: ' . $target);
            }
            if (hash_equals($contents, $current)) {
                continue;
            }
        }
        $pending[$path] = $contents;
    }
    foreach ($pending as $path => $contents) {
        $directory = dirname($path);
        if (!is_dir($directory) && !mkdir($directory, 0755, true) && !is_dir($directory)) {
            throw new RuntimeException('Cannot create managed Email search directory');
        }
        $temporary = tempnam($directory, '.clawpilot-email-search-');
        if ($temporary === false) {
            throw new RuntimeException('Cannot stage managed Email search override');
        }
        try {
            if (file_put_contents($temporary, $contents, LOCK_EX) !== strlen($contents)
                || !chmod($temporary, 0644) || !rename($temporary, $path)) {
                throw new RuntimeException('Cannot install managed Email search override');
            }
        } finally {
            if (is_file($temporary)) {
                unlink($temporary);
            }
        }
    }
}
