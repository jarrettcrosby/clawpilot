<?php
declare(strict_types=1);
// ClawPilot managed native Email audience proof v1. Read-only; never grants access.

require_once 'custom/include/ClawPilot/EmailAudience.php';

// Loaded inside SuiteCRM v8.10.1's OAuth ResourceServerMiddleware /V8/custom group.
$app->post('/clawpilot-email-audience', function ($request, $response) {
    try {
        $clientId = (string) $request->getAttribute('oauth_client_id');
        $expectedClientId = trim((string) getenv('SUITECRM_CLIENT_ID'));
        $callerId = clawpilot_email_audience_id($request->getAttribute('oauth_user_id'));
        if ($expectedClientId === '' || !hash_equals($expectedClientId, $clientId)) {
            return $response->withJson(['ok' => false, 'code' => 'EMAIL_AUDIENCE_UNAUTHORIZED'], 403);
        }
        $db = DBManagerFactory::getInstance();
        $clients = clawpilot_email_audience_rows("SELECT assigned_user_id FROM oauth2clients WHERE deleted = 0 AND id = '"
            . $db->quote($clientId) . "'");
        $caller = BeanFactory::getBean('Users', $callerId);
        if (count($clients) !== 1 || (string) $clients[0]['assigned_user_id'] !== $callerId
            || !$caller || $caller->status !== 'Active' || !$caller->isAdmin()) {
            return $response->withJson(['ok' => false, 'code' => 'EMAIL_AUDIENCE_UNAUTHORIZED'], 403);
        }
        $body = (string) $request->getBody();
        if (strlen($body) > 32768 || stripos($request->getHeaderLine('Content-Type'), 'application/vnd.api+json') !== 0) {
            clawpilot_email_audience_refuse();
        }
        $command = json_decode($body, true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($command) || array_is_list($command)) {
            clawpilot_email_audience_refuse();
        }
        return $response->withHeader('Cache-Control', 'private, no-store')
            ->withJson(clawpilot_email_audience_proof($command, $callerId));
    } catch (Throwable $error) {
        // Do not return database details, roles, addresses, endpoint strings or credentials.
        return $response->withHeader('Cache-Control', 'private, no-store')->withJson([
            'ok' => false, 'code' => 'SUITECRM_EMAIL_PROJECTION_HELD',
            'error' => 'Native Email audience proof is unavailable',
        ], 409);
    }
});
