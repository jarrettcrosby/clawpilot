<?php
declare(strict_types=1);
// Pinned real SuiteCRM, real OAuth, real beans, synthetic data only.
if (PHP_SAPI!=='cli' || getenv('CLAWPILOT_RECORD_LIFECYCLE_NATIVE_TEST')!=='1'
    || trim((string)file_get_contents('/app/VERSION'))!=='8.10.1') throw new RuntimeException('Disposable native runtime required');
chdir('/app/public/legacy');
define('sugarEntry',true);
require_once 'include/entryPoint.php';
function need(bool $ok,string $label): void { if(!$ok)throw new RuntimeException($label); }
function rows(string $sql): array {
    $db=DBManagerFactory::getInstance();$result=$db->query($sql,true);$rows=[];
    while($row=$db->fetchByAssoc($result,false))$rows[]=$row;return $rows;
}
function quote(string $value): string { return DBManagerFactory::getInstance()->quote($value); }
function control(array $data): void {
    $body=json_encode($data,JSON_THROW_ON_ERROR);
    need(file_put_contents('/tmp/record-lifecycle-control.json',$body,LOCK_EX)===strlen($body)
        && chmod('/tmp/record-lifecycle-control.json',0600),'Private synthetic control write failed');
}
$adminRows=rows("SELECT id FROM users WHERE user_name='fixture-admin' AND deleted=0");
need(count($adminRows)===1,'Exact fixture administrator required');
$GLOBALS['current_user']=BeanFactory::getBean('Users',$adminRows[0]['id']);
need($GLOBALS['current_user']->is_admin==1,'Actual administrator required');
if (($argv[1]??'')==='prepare') {
    require_once 'modules/DynamicFields/DynamicField.php';
    require_once 'modules/DynamicFields/FieldCases.php';
    require_once 'include/SugarObjects/VardefManager.php';
    foreach(['Accounts'=>'Account','Contacts'=>'Contact'] as $module=>$object) {
        $bean=BeanFactory::newBean($module);$dynamic=new DynamicField($module);$dynamic->setup($bean);
        $field=get_widget('varchar');$field->name='global_id';$field->label='LBL_GLOBAL_ID';$field->vname='LBL_GLOBAL_ID';
        $field->label_value='Fixture Global ID';$field->len='32';$field->required=false;$field->audited=false;$field->reportable=true;$field->save($dynamic);
        VardefManager::clearVardef($module,$object);unset($GLOBALS['dictionary'][$object]);
        VardefManager::refreshVardefs($module,$object);
    }
    $state=['enabled'=>false];
    foreach(['allowed','wrong'] as $label) {
        $client=BeanFactory::newBean('OAuth2Clients');$client->name='Synthetic lifecycle '.$label;
        $client->allowed_grant_type='client_credentials';$client->is_confidential=1;$client->assigned_user_id=$adminRows[0]['id'];
        $secret='Synthetic-client-only-'.bin2hex(random_bytes(24));
        $_REQUEST=['new_secret'=>$secret,'duration_amount'=>1,'duration_unit'=>'hour'];
        try { need((bool)$client->save(false),'Actual OAuth client save failed'); } finally { $_REQUEST=[]; }
        $state[$label]=['id'=>(string)$client->id,'secret'=>$secret];
    }
    $key=openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_RSA,'private_key_bits'=>2048]);
    need($key!==false && openssl_pkey_export($key,$private),'Synthetic signing key failed');
    foreach(['private.key'=>$private,'public.key'=>openssl_pkey_get_details($key)['key']] as $file=>$bytes) {
        $path='/app/public/legacy/Api/V8/OAuth2/'.$file;
        need(file_put_contents($path,$bytes)===strlen($bytes) && chmod($path,0600),'Synthetic signing key write failed');
    }
    $configPath='/app/public/legacy/config_override.php';
    $config=is_file($configPath)?(string)file_get_contents($configPath):"<?php\n";
    $config=preg_replace('/\\?>\\s*$/','',$config);
    $config.="\n".'$sugar_config[\'site_url\']=\'http://127.0.0.1:8099\';'
        ."\n".'$sugar_config[\'trusted_hosts\']=[\'^127\\\\.0\\\\.0\\\\.1$\'];'
        ."\n".'$sugar_config[\'oauth2_encryption_key\']='.var_export(bin2hex(random_bytes(32)),true).";\n";
    need(file_put_contents($configPath,$config)===strlen($config),'Synthetic config failed');
    foreach(['account'=>['Accounts','ga1234567'],'bpo'=>['Accounts','ga7654321'],'contact'=>['Contacts','gc1234567']] as $label=>[$module,$global]) {
        $GLOBALS['reload_vardefs']=true;$bean=BeanFactory::newBean($module);unset($GLOBALS['reload_vardefs']);
        $bean->name='Synthetic '.$label;$bean->last_name='Synthetic '.$label;$bean->global_id_c=$global;
        $bean->assigned_user_id=$adminRows[0]['id'];
        need((bool)$bean->save(false),'Actual record save failed');
        $state[$label]=['module'=>$module,'nativeId'=>(string)$bean->id,'globalId'=>$global];
    }
    control($state);echo "PASS real SuiteCRM schema, beans and OAuth clients prepared\n";exit;
}
need(($argv[1]??'')==='verify','Explicit verification mode required');
$state=json_decode((string)file_get_contents('/tmp/record-lifecycle-control.json'),true,8,JSON_THROW_ON_ERROR);
function request(string $path,?string $token,string $body,string $method='POST',string $type='application/vnd.api+json'): array {
    need(str_starts_with($path,'/Api/'),'Only native API requests allowed');
    $curl=curl_init('http://127.0.0.1:8099'.$path);
    $headers=['Content-Type: '.$type,'Accept: application/json'];if($token!==null)$headers[]='Authorization: Bearer '.$token;
    curl_setopt_array($curl,[CURLOPT_CUSTOMREQUEST=>$method,CURLOPT_POSTFIELDS=>$body,CURLOPT_HTTPHEADER=>$headers,
        CURLOPT_RETURNTRANSFER=>true,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_PROXY=>'',CURLOPT_CONNECTTIMEOUT=>3,CURLOPT_TIMEOUT=>20,
        CURLOPT_PROTOCOLS=>CURLPROTO_HTTP]);
    $result=curl_exec($curl);need(is_string($result)&&strlen($result)<131072,'Bounded native HTTP response required');
    $status=(int)curl_getinfo($curl,CURLINFO_RESPONSE_CODE);curl_close($curl);
    return ['status'=>$status,'document'=>json_decode($result,true)];
}
function token(array $client): string {
    $r=request('/Api/access_token',null,http_build_query(['grant_type'=>'client_credentials',
        'client_id'=>$client['id'],'client_secret'=>$client['secret']]),'POST','application/x-www-form-urlencoded');
    need($r['status']===200&&is_string($r['document']['access_token']??null),'Real OAuth service grant required');
    return $r['document']['access_token'];
}
function inspect(array $records,string $token): array {
    return request('/Api/V8/custom/clawpilot-record-lifecycle/inspect',$token,json_encode(['version'=>1,'records'=>$records],JSON_THROW_ON_ERROR));
}
$token=token($state['allowed']);$wrong=token($state['wrong']);
$none=request('/Api/V8/custom/clawpilot-record-lifecycle/inspect',null,'{}');
need($none['status']===401,'Stock OAuth must reject unauthenticated request');
need(inspect([$state['account']],$token)['status']===409,'Default-off route must refuse');
echo "PASS actual native OAuth middleware and disabled route denial\n";
$state['enabled']=true;control($state);
need(inspect([$state['account']],$wrong)['status']===409,'Wrong OAuth client must refuse');
$missing=['module'=>'Accounts','nativeId'=>'missing-fixture','globalId'=>'ga1111111'];
$r=inspect([$state['account'],$state['contact'],$missing],$token);
need($r['status']===200 && ($r['document']['version']??null)===1,'Native inspection must succeed');
need(array_column($r['document']['records'],'state')===['active','active','missing'],'Exact active/contact/missing states required');
echo "PASS actual authenticated exact Account/Contact inspection and missing-not-deleted proof\n";
$bad=$state['account'];$bad['globalId']='ga9999999';
$r=inspect([$state['contact'],$bad],$token);
need($r['status']===409&&!isset($r['document']['records']),'Mismatched pair must refuse the whole batch');
echo "PASS wrong client and mismatched native/global pair cannot disclose partial evidence\n";
$r=request('/Api/V8/module/Accounts/'.$state['account']['nativeId'],$token,'','DELETE');
need(in_array($r['status'],[200,204],true),'Real native Account DELETE must succeed');
$r=inspect([$state['account'],$state['contact'],$state['bpo']],$token);
need($r['status']===200&&array_column($r['document']['records'],'state')===['deleted','active','active'],'Native Account deletion must not delete other account/contact');
echo "PASS real native Account deletion produces positive tombstone without contact/BPO cascade\n";
$r=request('/Api/V8/module/Contacts/'.$state['contact']['nativeId'],$token,'','DELETE');
need(in_array($r['status'],[200,204],true),'Real native Contact DELETE must succeed');
$r=inspect([$state['contact'],$state['bpo']],$token);
need($r['status']===200&&array_column($r['document']['records'],'state')===['deleted','active'],'Native Contact deletion must preserve BPO account');
echo "PASS real native Contact deletion produces positive tombstone without account cascade\n";
$claims=json_decode(base64_decode(strtr(explode('.',$token)[1],'-_','+/')),true,8,JSON_THROW_ON_ERROR);
need(is_string($claims['jti']??null),'Actual token identifier required');
$db=DBManagerFactory::getInstance();$where="access_token='".quote($claims['jti'])."'";
$db->query("UPDATE oauth2tokens SET token_is_revoked=1 WHERE ".$where,true);
$r=inspect([$state['bpo']],$token);
need(in_array($r['status'],[401,409],true)&&!isset($r['document']['records']),'Revoked token must refuse');
$db->query("UPDATE oauth2tokens SET token_is_revoked=0 WHERE ".$where,true);
need(inspect([$state['bpo']],$token)['status']===200,'Fresh restored fixture token must be admitted');
echo "PASS actual persisted token revocation denies inspection\n";
$r=request('/Api/V8/custom/clawpilot-record-lifecycle/inspect',$token,str_repeat('x',32769));
need($r['status']===409&&!isset($r['document']['records']),'Oversized command must refuse');
$state['enabled']=false;control($state);
need(inspect([$state['bpo']],$token)['status']===409,'Runtime disable must refuse after prior success');
echo "PASS oversized commands and runtime disable fail closed\n";
echo "NATIVE_RECORD_LIFECYCLE_ACCEPTANCE_PASSED=7\n";
