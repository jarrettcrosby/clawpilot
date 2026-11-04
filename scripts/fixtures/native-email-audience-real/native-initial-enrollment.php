<?php
declare(strict_types=1);
// Separate fresh installed fixture, NOT the steady-state bootstrap sequence.
// These stages never install files/DDL/config or issue approval themselves.
// Parent must run actual offline installers/config journal, then supply an
// independently signed authorization from its trusted app/PG issuer bridge.
if(PHP_SAPI!=='cli'||getenv('CLAWPILOT_NATIVE_INITIAL_FIXTURE')!=='1')throw new RuntimeException('Explicit isolated initial fixture required');
if(($GLOBALS['argv'][2]??null)==='--initial-volume-app')define('CLAWPILOT_NATIVE_INITIAL_APP_ROOT','/var/lib/suitecrm/app');
$initialStage=$GLOBALS['argv'][1]??'';
if($initialStage==='native-session-environment'){
    // Fixture-only metadata observation. Run the SAME production protected
    // source/bootstrap checks in a fresh process, without calling an installer
    // or changing the native DBManager session to fit an expected profile.
    if(!defined('CLAWPILOT_NATIVE_INITIAL_APP_ROOT')||count($GLOBALS['argv'])!==5)
        throw new RuntimeException('Named source artifact/session capture required');
    // Match the actual CLI entrypoint's JSON-only stdout behavior. Native PHP
    // warnings remain errors/log diagnostics, not a second wire protocol.
    ini_set('display_errors','0');
    require '/source/native-email-initial-cli.php';
    $options=cp_initial_cli_options(['inspect-source','--operation='.$GLOBALS['argv'][3],
        '--artifact-sha256='.$GLOBALS['argv'][4],'--quiescent']);
    cp_scope_quiescent(true);$artifact=cp_initial_cli_artifact($options);
    cp_initial_cli_identity($artifact);cp_initial_cli_pins($artifact);
    $lockPath=CP_INITIAL_CLI_STATE.'/cli.lock';cp_initial_cli_protected_file($lockPath,0);$lock=fopen($lockPath,'rb');
    cp_initial_cli_need(is_resource($lock)&&flock($lock,LOCK_EX|LOCK_NB),'operator_busy');
    try{
        cp_initial_cli_need(cp_initial_cli_canonical(cp_initial_cli_artifact($options))===cp_initial_cli_canonical($artifact),'artifact_changed_under_lock');
        cp_initial_cli_pins($artifact);$db=cp_initial_cli_cold_bootstrap($artifact);
        require_once '/source/install-native-email-initial-state.php';
        $manager='public/legacy/include/database/MysqliManager.php';$meta=cp_runtime_snapshot(CP_INITIAL_CLI_APP,$manager);
        cp_initial_cli_need($meta!==null&&$meta['sha256']==='3aba3033d743cd35cb788b8f485db1aef8ef718a84f06e48582c975cb86aac5b','fixture_stock_database_manager');
        fwrite(STDOUT,cp_initial_cli_canonical(['version'=>1,'purpose'=>'actual-native-database-manager-session-profile',
            'environment'=>cp_initial_environment($db),'stockDatabaseManager'=>['path'=>$manager,'sha256'=>$meta['sha256']],
            'nativeSessionOverridesApplied'=>false,'installationExecuted'=>false,'permissionExecutionReached'=>false])."\n");
    }finally{flock($lock,LOCK_UN);fclose($lock);}
    return;
}
if($initialStage==='raw-state'){
    // Audit BEFORE any SuiteCRM include/hook/DBManager can normalize state.
    require '/source/native-email-initial-cli.php';$root=CLAWPILOT_NATIVE_INITIAL_APP_ROOT;
    $db=new mysqli('db','fixture','Synthetic-native-db-password-only','suitecrm_native_test',3306);$db->set_charset('utf8mb4');$tables=[];
    $r=$db->query("SHOW FULL TABLES WHERE Table_type='BASE TABLE'");while($row=$r->fetch_row())$tables[]=$row[0];sort($tables,SORT_STRING);$database=[];
    foreach($tables as $table){cp_initial_cli_need(preg_match('/^[A-Za-z0-9_]+$/D',$table)===1,'fixture_table');
        $r=$db->query('SELECT * FROM `'.$table.'`');$rows=[];$bytes=0;while($row=$r->fetch_assoc()){$encoded=cp_initial_cli_canonical($row);$bytes+=strlen($encoded);
            cp_initial_cli_need(count($rows)<50000&&$bytes<16777216,'fixture_rows');$rows[]=$encoded;}sort($rows,SORT_STRING);$database[$table]=hash('sha256',implode("\n",$rows));}
    $auditCustomFields=(int)$db->query("SELECT COUNT(*) FROM fields_meta_data WHERE custom_module='Audit' AND deleted=0")->fetch_row()[0];
    $db->close();$cache=[];$cacheRoot=$root.'/public/legacy/cache';
    if(is_dir($cacheRoot))foreach(new RecursiveIteratorIterator(new RecursiveDirectoryIterator($cacheRoot,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::SELF_FIRST) as $file){
        $path=$file->getPathname();cp_initial_cli_need(!is_link($path)&&count($cache)<20000,'fixture_cache');
        clearstatcache(true,$path);$stat=lstat($path);cp_initial_cli_need(is_array($stat),'fixture_cache_stat');
        $meta=['nlink'=>$stat['nlink'],'ino'=>$stat['ino'],'ctime'=>$stat['ctime']];
        $cache[substr($path,strlen($cacheRoot)+1)]=$file->isDir()?array_merge(['directory'=>true,'mode'=>$stat['mode']&0777,
            'uid'=>$stat['uid'],'gid'=>$stat['gid'],'mtime'=>$stat['mtime']],$meta):array_merge(cp_scope_snapshot($path),$meta);}
    ksort($cache,SORT_STRING);$critical=[];
    $auditSources=['public/legacy/modules/Audit/vardefs.php'=>'0639772c062c5d509919cdcf6b77e80d804df41a1a9742fd9ecd4f112478418d',
        'public/legacy/modules/Audit/Audit.php'=>'e71603454d14143c44cba1bff9477e159add938507450ed8f1a30b3e313bd9de',
        'public/legacy/modules/DynamicFields/DynamicField.php'=>'39b244d65b02214d529daf19a94a38bc2be3db4a9d4108b96cfe775d3aeb83d6',
        'public/legacy/include/SugarObjects/VardefManager.php'=>'3ad363489bbf2f7a7eb7aa05f0160dd1d3759445f870748c308ca684a17ed360',
        'public/legacy/include/utils/sugar_file_utils.php'=>'8f199e0b72f14ff18f89929d526fa0d228b0ec855f2027c9581bc5ac1895110b'];
    foreach($auditSources as $relative=>$hash)cp_initial_cli_need(cp_runtime_snapshot($root,$relative)['sha256']===$hash,'fixture_official_audit_source');
    if(!defined('sugarEntry'))define('sugarEntry',true);
    $auditVardef=(static function(string $path):array{$dictionary=[];require $path;return $dictionary['Audit'];})($root.'/public/legacy/modules/Audit/vardefs.php');
    cp_initial_cli_need($auditVardef===['table'=>'does_not_exist'],'fixture_audit_shape');
    $stockAudit=['sources'=>$auditSources,'vardef'=>$auditVardef,'auditCustomFields'=>$auditCustomFields,'fieldsMetaDataHash'=>$database['fields_meta_data']];
    foreach(array_unique(array_merge(CP_INITIAL_CLI_BOOTSTRAP_LEAVES,array_keys($auditSources),array_values(cp_runtime_targets()),array_map(static fn($p)=>'public/legacy/'.$p,array_keys(clawpilot_native_scope_input_hashes())))) as $relative){
        if(str_starts_with($relative,'custom/'))$relative='public/legacy/'.$relative;$critical[$relative]=cp_runtime_snapshot($root,$relative);}
    ksort($critical,SORT_STRING);fwrite(STDOUT,cp_initial_cli_canonical(['database'=>$database,'cache'=>$cache,'critical'=>$critical,'stockAudit'=>$stockAudit])."\n");return;
}
if(in_array($initialStage,['joint-retained-state','joint-content-update'],true)){
    // Explicit disposable-fixture construction/observation only, never a
    // production CLI action or a substitute Native history/authority response.
    if(!defined('CLAWPILOT_NATIVE_INITIAL_APP_ROOT')||count($GLOBALS['argv'])!==4)throw new RuntimeException('Exact joint root operation required');
    require '/source/native-email-initial-cli.php';$operation=$GLOBALS['argv'][3];cp_initial_cli_hash($operation);
    $db=new mysqli('db','fixture','Synthetic-native-db-password-only','suitecrm_native_test',3306);$db->set_charset('utf8mb4');
    $statement=$db->prepare('SELECT * FROM clawpilot_email_initial_enrollments WHERE operation_id=?');$statement->bind_param('s',$operation);$statement->execute();
    $rows=$statement->get_result()->fetch_all(MYSQLI_ASSOC);$statement->close();
    cp_initial_cli_need(count($rows)===1&&$rows[0]['state']==='cancelled','joint_actual_cancelled_root_required');
    if($initialStage==='joint-retained-state'){
        $files=[];$bytes=0;
        foreach([CP_INITIAL_CLI_SCOPE,CP_INITIAL_CLI_RUNTIME,CP_INITIAL_CLI_STATE] as $directory){
            cp_scope_protected_directory($directory,false);
            foreach(new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory,FilesystemIterator::SKIP_DOTS)) as $file){
                $path=$file->getPathname();$relative=substr($path,strlen($directory)+1);
                if($directory===CP_INITIAL_CLI_STATE&&(str_starts_with($relative,'operations/')&&!str_starts_with($relative,'operations/'.$operation.'/')
                    ||$relative==='activation-origin.json'))continue;
                cp_initial_cli_need($file->isFile()&&!$file->isLink()&&count($files)<512,'joint_retained_files');
                $contents=file_get_contents($path);$meta=lstat($path);$bytes+=strlen($contents);
                cp_initial_cli_need(is_string($contents)&&is_array($meta)&&$meta['uid']===0&&$meta['nlink']===1&&$bytes<=8388608,'joint_retained_bound');
                $files[basename($directory).'/'.$relative]=['sha256'=>hash('sha256',$contents),'size'=>strlen($contents),'bytesBase64'=>base64_encode($contents),
                    'uid'=>$meta['uid'],'gid'=>$meta['gid'],'mode'=>$meta['mode']&0777];
            }
        }
        ksort($files,SORT_STRING);$db->close();
        fwrite(STDOUT,cp_initial_cli_canonical(['version'=>1,'purpose'=>'joint-actual-retained-root-observation','operationId'=>$operation,
            'files'=>$files,'nativeCancellation'=>$rows[0],'excludedNewOrigin'=>'activation-origin.json'])."\n");return;
    }
    $source=json_decode(cp_initial_cli_protected_file(CP_INITIAL_CLI_STATE.'/operations/'.$operation.'/native-source.json',1800000)['bytes'],true,64,JSON_THROW_ON_ERROR);
    cp_initial_cli_need($source['version']===1&&$source['purpose']==='clawpilot-native-email-initial-source'&&count($source['emails'])===329,'joint_original_source_required');
    $email=$source['emails'][0]['nativeId'];cp_initial_cli_id($email);$marker="\nJoint replan fixture content edit AFTER actual cancelled root.";
    $db->begin_transaction();
    try{
        cp_initial_cli_need($db->query('SELECT 1 FROM clawpilot_email_bindings LIMIT 1')->num_rows===0,'joint_unenrolled_fixture_required');
        $statement=$db->prepare('SELECT * FROM emails_text WHERE email_id=? FOR UPDATE');$statement->bind_param('s',$email);$statement->execute();
        $texts=$statement->get_result()->fetch_all(MYSQLI_ASSOC);$statement->close();
        cp_initial_cli_need(count($texts)===1&&is_string($texts[0]['description'])&&!str_contains($texts[0]['description'],$marker),'joint_one_content_edit_required');
        $before=$texts[0];$old=$before['description'];$next=$old.$marker;
        $statement=$db->prepare('UPDATE emails_text SET description=? WHERE email_id=? AND description=?');$statement->bind_param('sss',$next,$email,$old);$statement->execute();
        cp_initial_cli_need($statement->affected_rows===1,'joint_content_cas');$statement->close();
        $statement=$db->prepare('SELECT * FROM emails_text WHERE email_id=?');$statement->bind_param('s',$email);$statement->execute();
        $after=$statement->get_result()->fetch_assoc();$statement->close();$expected=$before;$expected['description']=$next;
        cp_initial_cli_need($after===$expected,'joint_content_only_readback');$db->commit();$db->close();
        fwrite(STDOUT,cp_initial_cli_canonical(['version'=>1,'purpose'=>'joint-intentional-content-only-fixture-update','emailId'=>$email,
            'table'=>'emails_text','field'=>'description','before'=>$before,'after'=>$after,'originalRecordFingerprint'=>$source['emails'][0]['recordFingerprint']])."\n");return;
    }catch(Throwable $error){$db->rollback();$db->close();throw $error;}
}
// Explicit fixture-only configuration/schema setup. This is NOT a production
// DDL/config installer: it records actual bytes/steps only inside owned tmpfs.
if($initialStage==='config-schema'){
    if(!defined('CLAWPILOT_NATIVE_INITIAL_APP_ROOT')||count($GLOBALS['argv'])!==3)throw new RuntimeException('Named initial volume required');
    require '/source/install-native-email-runtime.php';
    cp_scope_quiescent(true);$app=CLAWPILOT_NATIVE_INITIAL_APP_ROOT;$root='/var/lib/suitecrm/initial-fixture-setup';
    cp_scope_protected_directory($root,true);$path=$app.'/public/legacy/config_override.php';
    $before=cp_scope_snapshot($path);cp_scope_require($before!==null,'Actual installed config required');
    $bytes=(string)file_get_contents($path);cp_scope_require(!str_contains($bytes,'clawpilot_managed_email_write_scope'),'Fresh fixture config required');
    $close=strrpos($bytes,'?>');cp_scope_require($close===false||trim(substr($bytes,$close+2))==='','Unexpected fixture config trailing bytes');
    $updated=($close===false?rtrim($bytes):rtrim(substr($bytes,0,$close)))."\n\$sugar_config['clawpilot_managed_email_write_scope'] = true;\n";
    token_get_all($updated,TOKEN_PARSE);$source=json_decode((string)file_get_contents('/tmp/clawpilot-initial-source.json'),true,64,JSON_THROW_ON_ERROR);
    $journal=['version'=>1,'fixtureOnly'=>true,'phase'=>'prepared','sourceRuntimeFingerprint'=>$source['source']['nativeRuntimeFingerprint'],
        'beforeConfig'=>$before,'afterConfigSha256'=>hash('sha256',$updated),'schemas'=>[]];
    cp_scope_journal($root,$journal);cp_scope_require(cp_scope_matches(cp_scope_snapshot($path),$before,true),'Config changed before fixture CAS');
    cp_scope_write($root.'/config-staged.php',$updated,$before);cp_scope_require(rename($root.'/config-staged.php',$path),'Fixture config replacement failed');
    cp_scope_sync_directory(dirname($path));cp_scope_require(hash_file('sha256',$path)===$journal['afterConfigSha256'],'Fixture config readback changed');
    $db=new mysqli('db','fixture','Synthetic-native-db-password-only','suitecrm_native_test',3306);
    foreach(['publication-schema.sql','authority-transition-schema.sql','initial-enrollment-schema.sql'] as $file){
        $sql=(string)file_get_contents('/source/email-audience/'.$file);$journal['phase']='schema-applying';
        $journal['schemas'][$file]=['sha256'=>hash('sha256',$sql),'applied'=>false];cp_scope_journal($root,$journal);
        cp_scope_require($db->multi_query($sql),'Fixture schema failed');do{if($r=$db->store_result())$r->free();}while($db->more_results()&&$db->next_result());
        cp_scope_require($db->errno===0,'Fixture schema readback failed');$journal['schemas'][$file]['applied']=true;cp_scope_journal($root,$journal);
    }
    $db->close();$journal['phase']='applied';cp_scope_journal($root,$journal);
    fwrite(STDOUT,"NATIVE_INITIAL_FIXTURE_CONFIG_DDL_APPLIED=1\n");return;
}
define('CLAWPILOT_NATIVE_HELPERS_ONLY',true);
require '/fixture/acceptance.php';
require '/source/email-audience/NativeEmailInitialEnrollment.php';
require_once '/source/native-email-initial-cli.php';

function initialFixtureRead(string $path): array
{must(str_starts_with($path,'/tmp/clawpilot-initial-')&&!is_link($path)&&is_file($path),'Exact private initial fixture input required');
    $value=json_decode((string)file_get_contents($path),true,64,JSON_THROW_ON_ERROR);must(is_array($value),'Initial fixture object required');return $value;}
function initialFixtureWrite(string $path,array $value): void
{must(str_starts_with($path,'/tmp/clawpilot-initial-')&&!file_exists($path)&&!is_link($path),'Never overwrite an initial fixture artifact');
    $bytes=ClawPilotNativeEmailAuthorityContract::canonical($value)."\n";$h=fopen($path,'x');must($h!==false,'Private initial artifact required');
    try{must(chmod($path,0600)&&fwrite($h,$bytes)===strlen($bytes),'Complete private initial artifact required');}finally{fclose($h);}}
function initialFixtureCaps(array $ids): array {return array_fill_keys(['view','list','export','edit','delete'],$ids);}
function initialFixtureCliArtifact(array $state,?array $plan=null,?string $stamp=null,?array $authorization=null): array
{
    $root=CP_INITIAL_CLI_STATE;cp_scope_protected_directory($root,true);cp_scope_protected_directory($root.'/operations',true);
    $dir=$root.'/operations/'.$state['operationId'];cp_scope_protected_directory($dir,true);if(!file_exists($root.'/cli.lock'))cp_scope_write($root.'/cli.lock','');
    $pins=[];foreach(CP_INITIAL_CLI_BOOTSTRAP_LEAVES as $path){$meta=cp_runtime_snapshot(CP_INITIAL_CLI_APP,$path);$pins[$path]=$meta['sha256']??null;}
    $source=$dir.'/native-source.json';$sourceDigest=is_file($source)?hash_file('sha256',$source):null;
    $artifact=['version'=>1,'purpose'=>'clawpilot-native-email-initial-cli-artifact','operationId'=>$state['operationId'],'nativeInstanceId'=>'native-initial-fixture',
        'appGeneration'=>7,'appSourceFingerprint'=>hash('sha256','synthetic-app-initial-source'),'sourceArtifactDigest'=>$plan===null?null:$sourceDigest,
        'database'=>'suitecrm_native_test','serviceUserId'=>$state['serviceUserId'],'oauthClientId'=>$state['oauthClientId'],
        'cliSourceHash'=>hash_file('sha256','/source/native-email-initial-cli.php'),
        'imagePackageHash'=>cp_runtime_context(CP_INITIAL_CLI_APP,CP_INITIAL_CLI_RUNTIME,'/source')['packageHash'],'bootstrapPins'=>$pins,
        'mappings'=>$plan===null?array_map(static function($row){unset($row['capabilities']);return $row;},$state['source']['emails']):null,
        'plan'=>$plan,'preparedAt'=>$stamp,'authorization'=>$authorization];
    $bytes=cp_initial_cli_canonical($artifact)."\n";$sha=hash('sha256',$bytes);$retained=$dir.'/input-'.$sha.'.json';if(!file_exists($retained))cp_scope_write($retained,$bytes);
    $next=$dir.'/next-'.bin2hex(random_bytes(8)).'.json';cp_scope_write($next,$bytes);must(rename($next,$dir.'/input.json'),'Fixture artifact publication failed');
    return ['operationId'=>$state['operationId'],'artifactHash'=>$sha,'planHash'=>$plan===null?null:hash('sha256',cp_initial_cli_canonical($plan)),'sourcePath'=>$source];
}
function initialFixtureService(array $state): ClawPilotNativeEmailInitialEnrollment
{// Explicit synthetic environment pin, never a production client fallback.
    putenv('SUITECRM_NATIVE_AUTHORITY_CLIENT_ID='.$state['oauthClientId']);
    return new ClawPilotNativeEmailInitialEnrollment(DBManagerFactory::getInstance()->database,
    ['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>'suitecrm_native_test'],$state['serviceUserId'],$state['oauthClientId']);}
function initialFixtureState(bool $excludeTerminal=false): string
{$tables=['acl_actions','acl_roles','acl_roles_actions','acl_roles_users','securitygroups','securitygroups_users','securitygroups_records',
    'emails','emails_text','emails_cstm','emails_beans','emails_email_addr_rel','accounts_contacts','clawpilot_email_bindings','clawpilot_email_identities',
    'clawpilot_email_write_scopes','clawpilot_email_write_permissions','clawpilot_email_initial_enrollments'];$state=[];
    foreach($tables as $table){if($excludeTerminal&&$table==='clawpilot_email_initial_enrollments')continue;
        $data=rows('SELECT * FROM '.$table);usort($data,static fn($a,$b)=>strcmp(json_encode($a),json_encode($b)));$state[$table]=$data;}
    return ClawPilotNativeEmailAuthorityContract::digest($state);}

(static function():void{
    $stage=$GLOBALS['argv'][1]??'';must(in_array($stage,['source','installed-profile','prepare','execute','resolve','cancel-expired',
        'cli-source-artifact','cli-project-artifact','cli-prepare-artifact','cli-execution-artifact'],true)
        &&count($GLOBALS['argv'])===(defined('CLAWPILOT_NATIVE_INITIAL_APP_ROOT')?3:2),'Select exact initial fixture stage');
    $_REQUEST=[];$C=ClawPilotNativeEmailAuthorityContract::class;
    if($stage==='source'){
        must(!file_exists('/tmp/clawpilot-initial-source.json'),'Source stage may execute once only');
        must(rows('SELECT id FROM emails LIMIT 1')===[],'Initial fixture requires a fresh native database, never cleanup/adoption');
        $admins=rows("SELECT id FROM users WHERE user_name='fixture-admin' AND is_admin=1 AND deleted=0");must(count($admins)===1,'Exact fresh fixture admin required');
        $admin=fresh('Users',$admins[0]['id']);selectUser($admin);ensureGlobalId();
        $role=native('ACLRoles');$role->name='Synthetic initial explicit Email denial';$role->save(false);
        foreach(rows("SELECT id,name FROM acl_actions WHERE category='Emails' AND acltype='module' AND deleted=0") as $action)
            $role->setAction($role->id,$action['id'],$action['name']==='access'?ACL_ALLOW_DISABLED:ACL_ALLOW_NONE);
        foreach(['initial-denied-one','initial-denied-two'] as $label){$u=userFixture($label);linkBeans($role,'users',[(string)$u->id]);}
        $viewer=userFixture('initial-unroled-viewer');
        // Match the observed blank-status unroled principal. Do not infer that
        // blank status disables native ACL access or omit this user from proof.
        DBManagerFactory::getInstance()->query("UPDATE users SET status='' WHERE id='".quote((string)$viewer->id)."'",true);
        $viewer=fresh('Users',(string)$viewer->id);must($viewer->status===''&&$viewer->employee_status==='Active','Exact blank-status fixture principal required');
        must(rows("SELECT status,employee_status,is_admin,portal_only FROM users WHERE id='".quote((string)$viewer->id)."'")===[
            ['status'=>'','employee_status'=>'Active','is_admin'=>'0','portal_only'=>'0']],'Blank-status principal SQL readback required');selectUser($admin);
        $conflicting=getenv('CLAWPILOT_NATIVE_INITIAL_FIXTURE_CONFLICTING_ALL')==='1';
        if($conflicting){$all=native('ACLRoles');$all->name='Synthetic conflicting explicit Email ALL';$all->save(false);
            foreach(rows("SELECT id,name FROM acl_actions WHERE category='Emails' AND acltype='module' AND deleted=0") as $action)
                $all->setAction($all->id,$action['id'],$action['name']==='access'?ACL_ALLOW_ENABLED:ACL_ALLOW_ALL);
            linkBeans($all,'users',[(string)$viewer->id]);}
        $client=native('OAuth2Clients');$client->name='Synthetic initial dedicated issuer client';$client->allowed_grant_type='client_credentials';
        $client->is_confidential=1;$client->assigned_user_id=$admin->id;$_REQUEST=['new_secret'=>'synthetic-only-'.bin2hex(random_bytes(24)),
            'duration_amount'=>1,'duration_unit'=>'hour'];try{$client->save(false);}finally{$_REQUEST=[];}
        $readers=[(string)$admin->id,(string)$viewer->id];sort($readers,SORT_STRING);$pipelines=[];
        foreach([$readers,[(string)$admin->id],[(string)$admin->id]] as $read){$pipeline=create_guid();$workspace=create_guid();$pipelines[]=['groupId'=>create_guid(),'policy'=>[
            'version'=>2,'pipelineId'=>$pipeline,'workspaceId'=>$workspace,'ownerSuiteCrmId'=>(string)$admin->id,'audienceFingerprint'=>hash('sha256',
                json_encode(['policy'=>'pipeline-internal','ownerSuiteCrmId'=>(string)$admin->id,'allowedSuiteCrmUserIds'=>$read,
                    'workspaceId'=>$workspace,'pipelineId'=>$pipeline],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)),
            'principalSuiteCrmUserIds'=>[],'futureCreate'=>initialFixtureCaps($read),'historical'=>[]]];}
        $count=getenv('CLAWPILOT_NATIVE_INITIAL_FIXTURE_EMAILS');must($count===false||in_array($count,['329','334'],true),'Named initial fixture history required');
        $count=$count===false?329:(int)$count;$mappings=[];
        $related=[];foreach(['first','second'] as $label){$account=native('Accounts');$account->name='Synthetic initial related '.$label;
            $account->assigned_user_id=$admin->id;$account->save(false);$contact=native('Contacts');$contact->last_name='Initial '.$label;
            $contact->assigned_user_id=$admin->id;$contact->account_id=$account->id;$contact->save(false);
            $related[]=['account'=>(string)$account->id,'contact'=>(string)$contact->id];}
        $bpoCount=$count===334?131:126;
        for($index=0;$index<$count;$index++){$p=$pipelines[$index<27?0:($index<27+$bpoCount?1:2)]['policy'];$global='gi'.(9700000+$index);
            $email=emailFixture('Synthetic initial historical Email '.$index,$global,(string)$admin->id);
            if($index===0){linkBeans($email,'accounts',array_column($related,'account'));linkBeans($email,'contacts',array_column($related,'contact'));
                must(count(linkedIds($email,'accounts'))===2&&count(linkedIds($email,'contacts'))===2,'Actual multi-company/contact relationship fixture required');}
            $mappings[]=['localId'=>create_guid(),'nativeId'=>(string)$email->id,'globalId'=>$global,'pipelineId'=>$p['pipelineId'],
                'workspaceId'=>$p['workspaceId'],'archived'=>$index<6,'recordFingerprint'=>str_repeat('0',64)];}
        usort($mappings,static fn($a,$b)=>strcmp($a['nativeId'],$b['nativeId']));
        $state=['serviceUserId'=>(string)$admin->id,'oauthClientId'=>(string)$client->id,'viewerId'=>(string)$viewer->id,'scopeCounts'=>[27,$bpoCount,176],
            'conflictingAll'=>$conflicting,'pipelines'=>$pipelines,'operationId'=>hash('sha256','native-initial-fixture-'.bin2hex(random_bytes(16)))];
        $source=initialFixtureService($state)->inspectSource($mappings);
        must(count($source['principalSuiteCrmUserIds'])===4,'All four actual native principal classes must be captured');
        $config=$GLOBALS['sugar_config'];foreach(['1',true] as $bad){$GLOBALS['sugar_config']['clawpilot_managed_email_write_scope']=$bad;$held=false;
            try{initialFixtureService($state)->inspectSource($mappings);}catch(ClawPilotNativeEmailTransactionRefused $error){$held=true;}
            finally{$GLOBALS['sugar_config']=$config;}must($held,'Unknown managed-write input must fail closed');}
        must(initialFixtureService($state)->inspectSource($mappings)===$source,'Source capture/negative profile checks must leave actual before state unchanged');
        foreach($state['pipelines'] as &$pipeline)$pipeline['policy']['principalSuiteCrmUserIds']=$source['principalSuiteCrmUserIds'];unset($pipeline);
        usort($state['pipelines'],static fn($a,$b)=>strcmp($a['policy']['pipelineId'],$b['policy']['pipelineId']));$state['source']=$source;
        initialFixtureWrite('/tmp/clawpilot-initial-source.json',$state);
        fwrite(STDOUT,'NATIVE_INITIAL_SOURCE_CAPTURED='.json_encode(['emailCount'=>count($source['emails']),
            'principalCount'=>count($source['principalSuiteCrmUserIds']),'scopeCounts'=>$state['scopeCounts'],'blankStatusUnroled'=>true,
            'sourceRuntimeFingerprint'=>$source['nativeRuntimeFingerprint']],JSON_THROW_ON_ERROR)."\n");return;
    }
    $state=initialFixtureRead('/tmp/clawpilot-initial-source.json');$service=initialFixtureService($state);
    selectUser(fresh('Users',$state['serviceUserId']));
    if($stage==='cli-source-artifact'){fwrite(STDOUT,cp_initial_cli_canonical(initialFixtureCliArtifact($state))."\n");return;}
    if($stage==='cli-prepare-artifact'){
        $selected=initialFixtureRead('/tmp/clawpilot-initial-cli-plan.json');$project=initialFixtureRead('/tmp/clawpilot-initial-cli-project.json');
        $selected['plan']['nativePolicyAfterFingerprint']=$project['result']['afterPolicyFingerprint'];$selected['plan']['nativeRuntimeAfterFingerprint']=$project['result']['runtimeFingerprint'];
        $path='/tmp/clawpilot-initial-cli-final-plan.json';initialFixtureWrite($path,$selected);
        fwrite(STDOUT,cp_initial_cli_canonical(initialFixtureCliArtifact($state,$selected['plan'],$selected['preparedAt']))."\n");return;
    }
    if($stage==='cli-execution-artifact'){
        $selected=initialFixtureRead('/tmp/clawpilot-initial-cli-final-plan.json');$authorization=initialFixtureRead('/tmp/clawpilot-initial-authorization.json');
        fwrite(STDOUT,cp_initial_cli_canonical(initialFixtureCliArtifact($state,$selected['plan'],$selected['preparedAt'],$authorization))."\n");return;
    }
    if($stage==='installed-profile'){
        must(defined('CLAWPILOT_NATIVE_INITIAL_APP_ROOT'),'Named actual volume setup required');$root='/var/lib/suitecrm';$journals=[];
        foreach(['clawpilot-native-email-scope-v1','clawpilot-native-email-runtime-v1','initial-fixture-setup'] as $name){
            $path=$root.'/'.$name.'/manifest.json';must(!is_link($path)&&is_file($path),'Actual setup journal required');
            $j=json_decode((string)file_get_contents($path),true,64,JSON_THROW_ON_ERROR);must($j['phase']==='applied','Every actual setup stage must be complete');$journals[$name]=$j;}
        must($journals['initial-fixture-setup']['sourceRuntimeFingerprint']===$state['source']['nativeRuntimeFingerprint'],'Actual source/config journal linkage required');
        $installed=ClawPilotNativeEmailRuntime::attestInitialInstalled(DBManagerFactory::getInstance()->database);
        initialFixtureWrite('/tmp/clawpilot-initial-installation.json',['sourceRuntimeFingerprint'=>$state['source']['nativeRuntimeFingerprint'],
            'installedRuntimeFingerprint'=>$installed,'installationJournalFingerprint'=>$C::digest($journals)]);
        fwrite(STDOUT,"NATIVE_INITIAL_ACTUAL_INSTALLED_PROFILE=1\n");return;
    }
    if($stage==='prepare'||$stage==='cli-project-artifact'){
        // Parent supplies actual protected source→installed journal readback,
        // never a sugar_config=false simulation in this PHP process.
        $installation=$stage==='prepare'?initialFixtureRead('/tmp/clawpilot-initial-installation.json'):null;$source=$state['source'];$emails=[];$revocations=[];$byPipeline=[];
        foreach($state['pipelines'] as $pipeline)$byPipeline[$pipeline['policy']['pipelineId']]=$pipeline['policy'];
        foreach($source['emails'] as $before){$after=$before;$after['capabilities']=$byPipeline[$before['pipelineId']]['futureCreate'];
            $emails[]=['before'=>$before,'after'=>$after];foreach(['view','list','export','edit','delete'] as $surface)
                foreach(array_diff($before['capabilities'][$surface],$after['capabilities'][$surface]) as $principalId)
                    $revocations[]=['nativeId'=>$before['nativeId'],'surface'=>$surface,'principalId'=>$principalId];}
        usort($revocations,static fn($a,$b)=>strcmp($a['nativeId'].':'.$a['surface'].':'.$a['principalId'],$b['nativeId'].':'.$b['surface'].':'.$b['principalId']));
        $defaults=array_map(static fn($row)=>['before'=>$row,'after'=>array_replace($row,['aclAccess'=>in_array($row['action'],['edit','delete'],true)?75:80])],$source['defaults']);
        // This fixture can prove native execution with an explicit synthetic PG
        // boundary. A full app/PG rehearsal replaces these with real reserved
        // generation/source pins before preparing and signing the final plan.
        $reservation=is_file('/tmp/clawpilot-initial-app-reservation.json')?initialFixtureRead('/tmp/clawpilot-initial-app-reservation.json'):
            ['generation'=>7,'appSourceFingerprint'=>hash('sha256','synthetic-app-initial-source')];
        $plan=['version'=>1,'kind'=>'initial_enrollment_plan_v1','operationId'=>$state['operationId'],'nativeInstanceId'=>'native-initial-fixture',
            'appGeneration'=>$reservation['generation'],'appSourceFingerprint'=>$reservation['appSourceFingerprint'],
            'nativePolicyBeforeFingerprint'=>$source['nativePolicyFingerprint'],'nativeRuntimeBeforeFingerprint'=>$source['nativeRuntimeFingerprint'],
            'nativePolicyAfterFingerprint'=>str_repeat('0',64),'nativeRuntimeAfterFingerprint'=>str_repeat('0',64),
            'principalSuiteCrmUserIds'=>$source['principalSuiteCrmUserIds'],'defaults'=>$defaults,'emails'=>$emails,'pipelines'=>$state['pipelines'],
            'reviewedRevocations'=>$revocations,'rootEmployeeGrants'=>[]];
        $stamp=gmdate('Y-m-d H:i:s');
        if($stage==='cli-project-artifact'){initialFixtureWrite('/tmp/clawpilot-initial-cli-plan.json',['plan'=>$plan,'preparedAt'=>$stamp]);
            fwrite(STDOUT,cp_initial_cli_canonical(initialFixtureCliArtifact($state,$plan,$stamp))."\n");return;}
        $forecast=$service->project($plan,$stamp,$installation);
        $plan['nativePolicyAfterFingerprint']=$forecast['result']['afterPolicyFingerprint'];$plan['nativeRuntimeAfterFingerprint']=$forecast['result']['runtimeFingerprint'];
        $before=initialFixtureState();$forecast=$service->prepare($plan,$stamp,$installation);must(initialFixtureState()===$before,'Native preparation must be read-only');
        initialFixtureWrite('/tmp/clawpilot-initial-prepared.json',['plan'=>$plan,'forecast'=>$forecast,'installation'=>$installation]);
        fwrite(STDOUT,'NATIVE_INITIAL_PREPARED='.json_encode(['emailCount'=>count($emails),'principalCount'=>count($source['principalSuiteCrmUserIds']),
            'planHash'=>$forecast['planHash'],'deltaFingerprint'=>$forecast['deltaFingerprint'],'executableWithoutApproval'=>false],JSON_THROW_ON_ERROR)."\n");return;
    }
    $prepared=initialFixtureRead('/tmp/clawpilot-initial-prepared.json');$authorization=initialFixtureRead('/tmp/clawpilot-initial-authorization.json');
    $before=initialFixtureState();
    if($stage==='cancel-expired'){
        $unchanged=initialFixtureState(true);$receipt=$service->cancelExpired($prepared['plan'],$authorization,$prepared['installation']);
        must($receipt['state']==='cancelled'&&$receipt['result']===null&&initialFixtureState(true)===$unchanged,'Expiry cancellation must not apply or undo any permission/content changes');
        $cancelled=initialFixtureState();$resolved=$service->resolve($prepared['plan'],$authorization);
        must($C::canonical($resolved)===$C::canonical($receipt),'Cancelled resolution must retain canonically identical evidence');
        must(initialFixtureState()===$cancelled,'Cancelled resolution must not mutate native state');
        $held=false;try{$service->execute($prepared['plan'],$authorization,$prepared['installation']);}
        catch(ClawPilotNativeEmailTransactionRefused $error){$held=$error->holdCode==='initial_operation_cancelled';}
        must($held&&initialFixtureState()===$cancelled,'Delayed execution must not bypass the cancellation tombstone');
        must($C::canonical($service->cancelExpired($prepared['plan'],$authorization,$prepared['installation']))===$C::canonical($receipt),'Repeated cancellation must retain canonically identical evidence');
        must(initialFixtureState()===$cancelled,'Repeated cancellation must be read-only');
        initialFixtureWrite('/tmp/clawpilot-initial-cancelled-receipt.json',$receipt);
        fwrite(STDOUT,"NATIVE_INITIAL_EXPIRED_CANCELLATION_PASSED=1\n");return;
    }
    if($stage==='execute'){
        if($state['conflictingAll']){
            $held=false;try{$service->execute($prepared['plan'],$authorization,$prepared['installation']);}
            catch(ClawPilotNativeEmailTransactionRefused $error){$held=$error->holdCode==='initial_after_matrix_or_content_changed';}
            must($held&&initialFixtureState()===$before,'After-DML explicit-ALL conflict must roll back every row and terminal receipt');
            fwrite(STDOUT,"NATIVE_INITIAL_ROLLBACK_PASSED=1\n");return;
        }
        $receipt=$service->execute($prepared['plan'],$authorization,$prepared['installation']);
        must($receipt['state']==='committed'&&$receipt['approvalHash']===$C::digest($authorization),'Genuine initial native receipt required');
        $committed=initialFixtureState();$resolved=$service->resolve($prepared['plan'],$authorization);
        must($C::canonical($resolved)===$C::canonical($receipt),'Lost-response resolution must return canonically identical retained evidence');
        must(initialFixtureState()===$committed,'Lost-response resolution must not mutate native state');
        must($C::canonical($service->execute($prepared['plan'],$authorization,$prepared['installation']))===$C::canonical($receipt),'Completed replay must return canonically identical retained evidence');
        must(initialFixtureState()===$committed,'Completed replay must be read-only');
        initialFixtureWrite('/tmp/clawpilot-initial-receipt.json',$receipt);
        fwrite(STDOUT,'NATIVE_INITIAL_EXECUTION_PASSED='.json_encode(['emailCount'=>$receipt['result']['emailCount'],
            'principalCount'=>$receipt['result']['principalCount'],'commitDeadlineSeconds'=>5,'realNativeReceipt'=>true,
            'appPostgresActivationProven'=>false],JSON_THROW_ON_ERROR)."\n");return;
    }
    $receipt=$service->resolve($prepared['plan'],$authorization);$path=is_file('/tmp/clawpilot-initial-cancelled-receipt.json')?
        '/tmp/clawpilot-initial-cancelled-receipt.json':'/tmp/clawpilot-initial-receipt.json';must($receipt===initialFixtureRead($path)
        &&initialFixtureState()===$before,'Fresh-process resolution must verify the exact retained native receipt without mutation');
    fwrite(STDOUT,"NATIVE_INITIAL_FRESH_RESOLVE_PASSED=1\n");
})();
