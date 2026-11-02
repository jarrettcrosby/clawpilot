<?php
declare(strict_types=1);
// ClawPilot managed native record lifecycle inspection v1. Read-only; no Email or user writes.
require_once 'custom/include/ClawPilot/RecordLifecycle.php';

// This file is included ONLY inside SuiteCRM's authenticated /V8/custom group.
$app->post('/clawpilot-record-lifecycle/inspect', function ($request, $response) {
    $response = $response->withHeader('Cache-Control', 'private, no-store');
    try {
        if (getenv('CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED') !== '1') {
            return $response->withJson(['ok'=>false,'code'=>'NATIVE_RECORD_LIFECYCLE_DISABLED'], 409);
        }
        if (strtolower(trim(explode(';', $request->getHeaderLine('Content-Type'))[0])) !== 'application/vnd.api+json') {
            throw new ClawPilotRecordLifecycleRefused('invalid_http_command');
        }
        $stream = $request->getBody();
        if ($stream->isSeekable()) $stream->rewind();
        elseif ($stream->tell() !== 0) throw new ClawPilotRecordLifecycleRefused('invalid_http_stream');
        $body = '';
        while (!$stream->eof() && strlen($body) <= 32768) {
            $chunk = $stream->read(32769 - strlen($body));
            if ($chunk === '' && !$stream->eof()) throw new ClawPilotRecordLifecycleRefused('invalid_http_stream');
            $body .= $chunk;
        }
        if (strlen($body) > 32768) throw new ClawPilotRecordLifecycleRefused('invalid_http_command');
        $command = json_decode($body, true, 12, JSON_THROW_ON_ERROR);
        return $response->withJson(ClawPilotRecordLifecycle::inspect(DBManagerFactory::getInstance()->database,
            $command, (string)$request->getAttribute('oauth_client_id'),
            (string)$request->getAttribute('oauth_user_id'), (string)$request->getAttribute('oauth_access_token_id')));
    } catch (Throwable $error) {
        // No database diagnostics, provider contents, credentials or partial evidence.
        return $response->withJson(['ok'=>false,'code'=>'NATIVE_RECORD_LIFECYCLE_UNAVAILABLE'], 409);
    }
});
