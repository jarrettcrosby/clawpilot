<?php
declare(strict_types=1);
// ClawPilot shared stock Email worker route v1. Mounted under the V8 OAuth group.

require_once '/opt/clawpilot/email-audience/SharedBpoEmailWorker.php';

$app->post('/clawpilot-email-shared', function ($request, $response) {
    $response=$response->withHeader('Cache-Control','private, no-store');
    $enabled=getenv('CLAWPILOT_SHARED_BPO_EMAIL_ENABLED')==='1';
    $templates=getenv('CLAWPILOT_SHARED_BPO_EMAIL_TEMPLATES');
    if(!$enabled || !in_array($templates,['0','1'],true)) {
        return $response->withJson(['ok'=>false,'code'=>'SHARED_EMAIL_UNAVAILABLE'],409);
    }
    $id=static fn($value)=>is_string($value)&&preg_match('/\A[A-Za-z0-9][A-Za-z0-9_-]{0,127}\z/',$value)===1;
    $expectedClient=getenv('SUITECRM_CLIENT_ID');
    $client=$request->getAttribute('oauth_client_id');
    $subject=$request->getAttribute('oauth_user_id');
    $token=$request->getAttribute('oauth_access_token_id');
    if(!$id($expectedClient)||!$id($client)||($subject!==null&&$subject!==''&&!$id($subject))
        ||!is_string($token)||preg_match('/\A[a-f0-9]{80}\z/',$token)!==1||!hash_equals($expectedClient,$client)){
        return $response->withJson(['ok'=>false,'code'=>'SHARED_EMAIL_UNAUTHORIZED'],403);
    }
    $previousUser=$GLOBALS['current_user']??null;$hadUser=array_key_exists('current_user',$GLOBALS);
    $previousRequest=$_REQUEST;
    try {
        if(!preg_match('~\Aapplication/vnd\.api\+json(?:\s*;[^\r\n]*)?\z~i',$request->getHeaderLine('Content-Type'))){
            return $response->withJson(['ok'=>false,'code'=>'SHARED_EMAIL_REQUEST'],415);
        }
        $stream=$request->getBody();
        if(!$stream->isReadable()||!$stream->isSeekable())throw new RuntimeException('body');
        $stream->rewind();$body=$stream->read(600001);
        if(strlen($body)>600000||!$stream->eof())return $response->withJson(['ok'=>false,'code'=>'SHARED_EMAIL_REQUEST'],413);
        $command=json_decode($body,true,32,JSON_THROW_ON_ERROR);
        if(!is_array($command)||array_is_list($command))throw new RuntimeException('body');
        $manager=DBManagerFactory::getInstance();
        $database=$GLOBALS['sugar_config']['dbconfig']['db_name']??null;
        if(!($manager instanceof MysqliManager)||!($manager->database instanceof mysqli)||!is_string($database))throw new RuntimeException('native');
        // Stock client-credentials tokens have no human subject. Derive the
        // actor from the configured client; the worker rechecks under its TX.
        $statement=$manager->database->prepare('SELECT assigned_user_id FROM oauth2clients WHERE id=? AND deleted=0 AND allowed_grant_type=\'client_credentials\'');
        try {
            $statement->bind_param('s',$client);$statement->execute();$clients=$statement->get_result()->fetch_all(MYSQLI_ASSOC);
        } finally {$statement->close();}
        $caller=count($clients)===1?$clients[0]['assigned_user_id']:null;
        $user=BeanFactory::newBean('Users');
        if(!$id($caller)||($subject!==null&&$subject!==''&&$subject!==$caller)
            ||!($user instanceof User)||get_class($user)!=='User'||!$user->retrieve($caller,false)||$user->id!==$caller
            ||$user->status!=='Active'||!$user->isAdmin()) {
            return $response->withJson(['ok'=>false,'code'=>'SHARED_EMAIL_UNAUTHORIZED'],403);
        }
        $GLOBALS['current_user']=$user;$_REQUEST=[];
        $worker=new ClawPilotSharedBpoEmailWorker($manager->database,
            ['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>$database],$caller,$client,$token,$templates==='1',(string)$subject);
        return $response->withJson($worker->publish($command));
    } catch(Throwable $error) {
        // Native content, request shape details and credentials never go to logs or HTTP errors.
        return $response->withJson(['ok'=>false,'code'=>'SUITECRM_EMAIL_PROJECTION_HELD'],409);
    } finally {
        $_REQUEST=$previousRequest;
        if($hadUser)$GLOBALS['current_user']=$previousUser;else unset($GLOBALS['current_user']);
    }
});
