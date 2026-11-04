<?php
declare(strict_types=1);
// Prepared opt-in routes. Not included by the current route installer. The exact
// read-scope/runtime/schema/binding and durable app admission must ship together.
require_once 'custom/include/ClawPilot/NativeEmailPublisher.php';

foreach (['prepare','publish','resolve'] as $operation) {
    $app->post('/clawpilot-email-publication/'.$operation, function ($request,$response) use ($operation) {
        $response=$response->withHeader('Cache-Control','private, no-store');
        try {
            if (getenv('CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED') !== '1')
                return $response->withJson(['ok'=>false,'code'=>'NATIVE_EMAIL_PUBLICATION_DISABLED'],409);
            $clientId=(string)$request->getAttribute('oauth_client_id');
            $expected=(string)getenv('SUITECRM_CLIENT_ID');
            $subject=(string)$request->getAttribute('oauth_user_id');
            $tokenId=(string)$request->getAttribute('oauth_access_token_id');
            if ($expected==='' || !hash_equals($expected,$clientId) || preg_match('/^[a-f0-9]{80}$/D',$tokenId)!==1)
                return $response->withJson(['ok'=>false,'code'=>'NATIVE_EMAIL_PUBLICATION_UNAUTHORIZED'],403);
            $db=DBManagerFactory::getInstance();
            // ResourceServerMiddleware authenticates jti/aud/sub. In SuiteCRM
            // client_credentials has an empty sub; the persisted OAuth token,
            // not a request-supplied user or the client's new owner, identifies
            // the principal. Require exact original token/client assignment.
            $stmt=$db->database->prepare('SELECT t.assigned_user_id,t.client,t.deleted,t.token_is_revoked,
                t.access_token_expires>UTC_TIMESTAMP() AS unexpired,c.assigned_user_id AS client_user_id,
                c.allowed_grant_type,c.deleted AS client_deleted FROM oauth2tokens t
                JOIN oauth2clients c ON c.id=t.client WHERE t.access_token=? ORDER BY t.id LIMIT 2');
            try {$stmt->bind_param('s',$tokenId);$stmt->execute();$tokens=$stmt->get_result()->fetch_all(MYSQLI_ASSOC);}
            finally {$stmt->close();}
            if(count($tokens)!==1 || $tokens[0]['client']!==$clientId || (int)$tokens[0]['deleted']!==0
                || (int)$tokens[0]['client_deleted']!==0 || !in_array($tokens[0]['token_is_revoked'],[0,'0'],true)
                || (int)$tokens[0]['unexpired']!==1 || $tokens[0]['assigned_user_id']!==$tokens[0]['client_user_id']
                || ($subject==='' ? $tokens[0]['allowed_grant_type']!=='client_credentials' : $subject!==$tokens[0]['assigned_user_id']))
                return $response->withJson(['ok'=>false,'code'=>'NATIVE_EMAIL_PUBLICATION_UNAUTHORIZED'],403);
            $callerId=$tokens[0]['assigned_user_id'];
            $caller=BeanFactory::newBean('Users');
            if(!preg_match('/^[a-z0-9][a-z0-9-]{0,63}$/iD',$callerId) || !$caller->retrieve($callerId,false)
                || !$caller->isAdmin() || $caller->status!=='Active')
                return $response->withJson(['ok'=>false,'code'=>'NATIVE_EMAIL_PUBLICATION_UNAUTHORIZED'],403);
            $stream=$request->getBody();
            if($stream->isSeekable())$stream->rewind();
            elseif($stream->tell()!==0)throw new ClawPilotNativeEmailTransactionRefused('invalid_http_stream');
            $body='';
            while(!$stream->eof() && strlen($body)<=600000) {
                $chunk=$stream->read(600001-strlen($body));
                if($chunk==='' && !$stream->eof())throw new ClawPilotNativeEmailTransactionRefused('invalid_http_stream');
                $body.=$chunk;
            }
            if(strlen($body)>600000 || strtolower(trim(explode(';',$request->getHeaderLine('Content-Type'))[0]))!=='application/vnd.api+json')
                throw new ClawPilotNativeEmailTransactionRefused('invalid_http_command');
            $command=json_decode($body,true,48,JSON_THROW_ON_ERROR);
            if(!is_array($command) || array_is_list($command))throw new ClawPilotNativeEmailTransactionRefused('invalid_http_command');
            $GLOBALS['current_user']=$caller;
            $publisher=new ClawPilotNativeEmailPublisher($db->database,[
                'profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>(string)($GLOBALS['sugar_config']['dbconfig']['db_name']??''),
            ],$callerId,$clientId,$tokenId);
            $result=match($operation){'prepare'=>$publisher->prepare($command),'publish'=>$publisher->publish($command),'resolve'=>$publisher->resolveOrCancel($command)};
            return $response->withJson($result);
        } catch(Throwable $error) {
            // Generic failure is NOT a definitive cancellation or noncommit.
            // Caller must retain its durable admission and call resolve.
            return $response->withJson(['ok'=>false,'code'=>'NATIVE_EMAIL_PUBLICATION_HELD'],409);
        }
    });
}
