<?php
declare(strict_types=1);
// Prepared opt-in only; no current production route installer includes this.
// The V8 ResourceServerMiddleware must authenticate real JWT aud/sub/jti first.
require_once 'custom/include/ClawPilot/NativeEmailAuthorityTransition.php';
foreach(['inspect','project','approve','execute','resolve','cancel-expired'] as $operation) {
    $app->post('/clawpilot-email-authority/'.$operation,function($request,$response)use($operation){
        $response=$response->withHeader('Cache-Control','private, no-store');
        try {
            if(getenv('CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED')!=='1')
                return $response->withJson(['ok'=>false,'code'=>'NATIVE_EMAIL_AUTHORITY_DISABLED'],409);
            $clientId=(string)$request->getAttribute('oauth_client_id');$subject=(string)$request->getAttribute('oauth_user_id');
            $tokenId=(string)$request->getAttribute('oauth_access_token_id');$expected=(string)getenv('SUITECRM_NATIVE_AUTHORITY_CLIENT_ID');
            if($expected==='' || !hash_equals($expected,$clientId) || preg_match('/^[a-f0-9]{80}$/D',$tokenId)!==1)
                return $response->withJson(['ok'=>false,'code'=>'NATIVE_EMAIL_AUTHORITY_UNAUTHORIZED'],403);
            $manager=DBManagerFactory::getInstance();$nativeDb=$manager->database;
            $s=$nativeDb->prepare('SELECT t.assigned_user_id,t.client,t.deleted,t.token_is_revoked,
                t.access_token_expires>UTC_TIMESTAMP() AS unexpired,c.assigned_user_id AS client_user_id,
                c.allowed_grant_type,c.deleted AS client_deleted FROM oauth2tokens t JOIN oauth2clients c ON c.id=t.client
                WHERE t.access_token=? ORDER BY t.id LIMIT 2');
            try{$s->bind_param('s',$tokenId);$s->execute();$tokens=$s->get_result()->fetch_all(MYSQLI_ASSOC);}finally{$s->close();}
            if(count($tokens)!==1 || $tokens[0]['client']!==$clientId || (int)$tokens[0]['deleted']!==0
                || (int)$tokens[0]['client_deleted']!==0 || !in_array($tokens[0]['token_is_revoked'],[0,'0'],true)
                || (int)$tokens[0]['unexpired']!==1 || $tokens[0]['assigned_user_id']!==$tokens[0]['client_user_id']
                || ($subject==='' ? $tokens[0]['allowed_grant_type']!=='client_credentials' : $subject!==$tokens[0]['assigned_user_id']))
                return $response->withJson(['ok'=>false,'code'=>'NATIVE_EMAIL_AUTHORITY_UNAUTHORIZED'],403);
            $callerId=$tokens[0]['assigned_user_id'];$caller=BeanFactory::newBean('Users');
            if(!preg_match('/^[a-z0-9][a-z0-9-]{0,35}$/iD',$callerId) || !$caller->retrieve($callerId,false)
                || !$caller->isAdmin() || $caller->status!=='Active')
                return $response->withJson(['ok'=>false,'code'=>'NATIVE_EMAIL_AUTHORITY_UNAUTHORIZED'],403);
            $stream=$request->getBody();if($stream->isSeekable())$stream->rewind();
            elseif($stream->tell()!==0)throw new ClawPilotNativeEmailTransactionRefused('authority_http_stream');
            $body='';while(!$stream->eof() && strlen($body)<=820000){$chunk=$stream->read(820001-strlen($body));
                if($chunk==='' && !$stream->eof())throw new ClawPilotNativeEmailTransactionRefused('authority_http_stream');$body.=$chunk;}
            if(strlen($body)>820000 || strtolower(trim(explode(';',$request->getHeaderLine('Content-Type'))[0]))!=='application/vnd.api+json')
                throw new ClawPilotNativeEmailTransactionRefused('authority_http_payload');
            $input=json_decode($body,true,64,JSON_THROW_ON_ERROR);
            if(!is_array($input) || array_is_list($input))throw new ClawPilotNativeEmailTransactionRefused('authority_http_payload');
            $GLOBALS['current_user']=$caller;
            $service=new ClawPilotNativeEmailAuthorityTransition($nativeDb,[
                'profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>(string)($GLOBALS['sugar_config']['dbconfig']['db_name']??''),
            ],$callerId,$clientId,$tokenId,$subject);
            if($operation==='inspect')$result=$service->inspect($input);
            elseif($operation==='project')$result=$service->project($input);
            elseif($operation==='approve' || $operation==='cancel-expired') {
                ClawPilotNativeEmailAuthorityContract::keys($input,['command','authorization']);
                $result=$operation==='approve'?$service->approve($input['command'],$input['authorization'])
                    :$service->cancelExpired($input['command'],$input['authorization']);
            }else $result=$operation==='execute'?$service->execute($input):$service->resolveOrCancel($input);
            return $response->withJson($result);
        }catch(Throwable $error){
            // Operator observability only. Keep the public response generic and
            // never log command/proof/body/SQL/identity values or exception text.
            $holdCode=$error instanceof ClawPilotNativeEmailTransactionRefused
                && preg_match('/^[a-z0-9_]{1,100}$/D',$error->holdCode)===1?$error->holdCode:'unexpected_native_failure';
            error_log('CLAWPILOT_NATIVE_AUTHORITY_HELD='.$holdCode);
            // Never return signatures/proofs/body values, native IDs, SQL, or a
            // cancellation claim on an ambiguous error. Resolve retained work.
            return $response->withJson(['ok'=>false,'code'=>'NATIVE_EMAIL_AUTHORITY_HELD'],409);
        }
    });
}
