<?php
declare(strict_types=1);
// Actual MariaDB DDL/config recovery fixture; source-capture facts are synthetic.
// No SuiteCRM install/bootstrap, provider or production artifact is accessed.
if(PHP_SAPI!=='cli'||getenv('CLAWPILOT_INITIAL_INSTALLER_FIXTURE')!=='1')throw new RuntimeException('Explicit disposable initial installer fixture required');
require '/source/install-native-email-initial-state.php';
$checks=0;$counter=0;
function initial_install_check(string $name,callable $run):void{$run();$GLOBALS['checks']++;fwrite(STDOUT,'PASS '.$name."\n");}
function initial_install_refuses(callable $run,string $message):void
{try{$run();}catch(Throwable $error){cp_scope_require(str_contains($error->getMessage(),$message),'Unexpected bounded installer refusal');return;}throw new RuntimeException('Expected installer refusal');}
function initial_install_db(string $name):mysqli
{$db=new mysqli('db','root','Synthetic-initial-installer-db-only',$name,3306);$db->set_charset('utf8mb4');return $db;}
function initial_install_fresh():mysqli
{$admin=initial_install_db('initial_install_fixture');$name='initial_install_case_'.(++$GLOBALS['counter']);$admin->query('CREATE DATABASE `'.$name.'` CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci');$admin->close();return initial_install_db($name);}
function initial_install_artifact(string $path,string $bytes):void
{cp_scope_write($path,$bytes);}
function initial_install_tree(mysqli $db):array
{
    $base='/tmp/clawpilot-initial-state-'.bin2hex(random_bytes(8));mkdir($base,0700);$app=$base.'/app';mkdir($app,0755);file_put_contents($app.'/VERSION',"8.10.1\n");
    $legacy=$app.'/public/legacy';mkdir($legacy,0755,true);mkdir($legacy.'/custom',0755);
    foreach(clawpilot_native_scope_input_hashes() as $relative=>$hash){$path=$legacy.'/'.$relative;if(!is_dir(dirname($path)))mkdir(dirname($path),0755,true);
        $source='/official/public/legacy/'.$relative;cp_scope_require(is_file($source)&&hash_file('sha256',$source)===$hash,'Exact archive native scope source required');copy($source,$path);}
    cp_scope_apply(cp_scope_context($app,$base.'/clawpilot-native-email-scope-v1'),true);
    $runtime=cp_runtime_context($app,$base.'/clawpilot-native-email-runtime-v1','/source');cp_runtime_apply($runtime,true,$runtime['packageHash']);
    file_put_contents($legacy.'/config_override.php',"<?php\n// Synthetic private config original.\n\$sugar_config['synthetic_private'] = 'not-for-logs';\n?>\n \n");chmod($legacy.'/config_override.php',0640);
    $state=$base.'/clawpilot-native-email-initial-enrollment-v1';cp_scope_protected_directory($state,true);cp_scope_write($state.'/cli.lock','');
    $source=['version'=>1,'purpose'=>'clawpilot-native-email-initial-source','nativePolicyFingerprint'=>hash('sha256','synthetic-native-policy'),
        'nativeRuntimeFingerprint'=>hash('sha256','synthetic-native-runtime'),'principalSuiteCrmUserIds'=>['synthetic-user'],
        'emails'=>[['nativeId'=>'synthetic-email']],
        'defaults'=>array_map(static fn($name)=>['id'=>'synthetic-'.$name,'action'=>$name,'aclAccess'=>90],['delete','edit','export','list','view'])];
    $sourcePath=$base.'/source.json';$bytes=cp_initial_canonical($source)."\n";cp_scope_write($sourcePath,$bytes);
    $binding=['operationId'=>hash('sha256',$base),'nativeInstanceId'=>'synthetic-native-instance','appGeneration'=>1,
        'appSourceFingerprint'=>hash('sha256','synthetic-app-source'),'sourceArtifactDigest'=>hash('sha256',$bytes)];
    $c=cp_initial_installation_context($app,$state,'/source');return compact('base','app','legacy','state','sourcePath','binding','c','db');
}
function initial_install_apply(array $x,?callable $inject=null):array
{$check=cp_initial_installation_check($x['c'],$x['db'],$x['binding'],$x['sourcePath']);return cp_initial_installation_apply($x['c'],$x['db'],$x['binding'],$x['sourcePath'],true,$check['planHash'],$inject);}
function initial_install_recover(array $x):array
{$m=cp_initial_install_load($x['c']);return cp_initial_installation_recover($x['c'],$x['db'],$x['binding'],true,$m['planHash'],$m['installId']);}
function initial_install_complete(array $x):void
{foreach(CP_INITIAL_TABLES as $table){cp_scope_require(cp_initial_exact_schema($x['c'],$x['db'],$table),'Complete schema expected');cp_initial_empty($x['db'],$table);}
    $pins=cp_initial_installation_verify_installer($x['c'],$x['db'],$x['binding']);cp_initial_keys($pins,['sourceRuntimeFingerprint','installationJournalFingerprint']);}

mysqli_report(MYSQLI_REPORT_ERROR|MYSQLI_REPORT_STRICT);cp_scope_quiescent(true);
$mode=$argv[1]??'';cp_scope_require(count($argv)===2&&in_array($mode,['generate-profile','acceptance'],true),'Select bounded installer fixture mode');
if($mode==='generate-profile'){
    $db=initial_install_db('initial_install_fixture');$sql=cp_initial_sql('/source');$tables=[];
    cp_scope_require(cp_initial_rows($db,'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()')===[],'Profile requires a separate fresh empty database');
    $environment=cp_initial_environment($db);cp_scope_require(preg_match('/^11\.4\.13-MariaDB(?:-|$)/D',$environment['server']['serverVersion'])===1,'Exact independent MariaDB 11.4.13 profile required');
    foreach($sql['statements'] as $table=>$statement){$db->query($statement);$tables[$table]=cp_initial_schema_metadata($db,$table);cp_initial_empty($db,$table);}
    // Only DDL metadata is generated here. The separately reviewed native
    // verification session is carried forward from the shipped source profile,
    // never inferred by SET-normalizing this standalone DDL connection. Its
    // actual stock DBManager capture has a distinct native cold-process gate.
    $reviewed=json_decode((string)file_get_contents('/source/native-email-initial-install-profile.json'),true,64,JSON_THROW_ON_ERROR);
    cp_initial_keys($reviewed,['version','purpose','profile','sqlSources','environment','verificationEnvironment','tables']);
    cp_scope_require($reviewed['version']===1&&$reviewed['purpose']==='clawpilot-native-email-initial-install-profile'
        &&$reviewed['profile']==='suitecrm-8.10.1-mariadb-11.4.13-v1'&&$reviewed['sqlSources']===$sql['sources']
        &&cp_initial_canonical($reviewed['verificationEnvironment']['databaseDefaults'])===cp_initial_canonical($environment['databaseDefaults'])
        &&$reviewed['verificationEnvironment']['server']['serverVersion']===$environment['server']['serverVersion'],'Separately reviewed native verification profile required');
    $profile=['version'=>1,'purpose'=>'clawpilot-native-email-initial-install-profile','profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1',
        'sqlSources'=>$sql['sources'],'environment'=>$environment,'verificationEnvironment'=>$reviewed['verificationEnvironment'],'tables'=>$tables];
    fwrite(STDOUT,json_encode($profile,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n");$db->close();exit(0);
}
initial_install_check('independent pinned profile and read-only check create no installer journal or schema',function():void{
    $x=initial_install_tree(initial_install_fresh());$before=cp_scope_snapshot($x['legacy'].'/config_override.php');$check=cp_initial_installation_check($x['c'],$x['db'],$x['binding'],$x['sourcePath']);
    cp_scope_require($check['status']==='ready'&&!file_exists($x['state'].'/manifest.json')&&cp_scope_snapshot($x['legacy'].'/config_override.php')===$before,'Check mutated config/journal');
    foreach(CP_INITIAL_TABLES as $table)cp_scope_require(cp_initial_schema_metadata($x['db'],$table)===null,'Check created schema');$x['db']->close();
});
initial_install_check('explicit reviewed approval and root lock are required before any mutation',function():void{
    $x=initial_install_tree(initial_install_fresh());initial_install_refuses(fn()=>cp_initial_installation_apply($x['c'],$x['db'],$x['binding'],$x['sourcePath'],false,str_repeat('0',64)),'explicit --quiescent');
    initial_install_refuses(fn()=>cp_initial_installation_apply($x['c'],$x['db'],$x['binding'],$x['sourcePath'],true,str_repeat('0',64)),'reviewed initial install plan');
    cp_scope_require(!file_exists($x['state'].'/manifest.json'),'Rejected approval created journal');$x['db']->close();
});
initial_install_check('all eight real DDL statements and exact append-only config complete idempotently',function():void{
    $x=initial_install_tree(initial_install_fresh());$before=(string)file_get_contents($x['legacy'].'/config_override.php');$applied=initial_install_apply($x);cp_scope_require($applied['status']==='applied','Initial installation incomplete');initial_install_complete($x);
    $after=(string)file_get_contents($x['legacy'].'/config_override.php');cp_scope_require(str_replace(CP_INITIAL_CONFIG_BLOCK,'',$after)===$before,'Other config bytes changed');
    $journal=(string)file_get_contents($x['state'].'/manifest.json');$pins=cp_initial_installation_verify_installer($x['c'],$x['db'],$x['binding']);
    $reordered=array_reverse($x['binding'],true);cp_scope_require(cp_initial_installation_verify_installer($x['c'],$x['db'],$reordered)===$pins,'Identical binding key order changed identity');
    cp_scope_require(cp_initial_installation_check($x['c'],$x['db'],$reordered,$x['sourcePath'])['status']==='applied','Reordered binding check failed');
    $x['binding']=$reordered;
    cp_scope_require(initial_install_recover($x)['status']==='applied'&&file_get_contents($x['state'].'/manifest.json')===$journal
        &&cp_initial_installation_verify_installer($x['c'],$x['db'],$x['binding'])===$pins,'Completed recovery rewrote journal/pins');$x['db']->close();
});
initial_install_check('real implicit-commit interruption after each CREATE recovers only its durable exact intent',function():void{
    foreach(CP_INITIAL_TABLES as $selected){$x=initial_install_tree(initial_install_fresh());initial_install_refuses(fn()=>initial_install_apply($x,static function(string $step)use($selected):void{if($step==='created:'.$selected)throw new RuntimeException('Injected post-DDL interruption');}),'Injected post-DDL');
        $m=cp_initial_install_load($x['c']);cp_scope_require($m['steps'][$selected]==='intent'&&cp_initial_schema_metadata($x['db'],$selected)!==null,'Implicitly committed table or preceding intent missing');
        cp_scope_require(cp_initial_installation_check($x['c'],$x['db'],$x['binding'],$x['sourcePath'])['status']==='recovery-required','Interrupted install not held');
        initial_install_refuses(fn()=>cp_initial_installation_apply($x['c'],$x['db'],$x['binding'],$x['sourcePath'],true,$m['planHash']),'explicit recovery');
        cp_scope_require(initial_install_recover($x)['status']==='applied','Exact real DDL recovery failed');initial_install_complete($x);$x['db']->close();}
});
initial_install_check('pre-DDL intent and pre/post-config rename interruptions recover without learning live expectations',function():void{
    foreach(['intent:'.CP_INITIAL_TABLES[0],'config-intent','config-replaced'] as $selected){$x=initial_install_tree(initial_install_fresh());
        initial_install_refuses(fn()=>initial_install_apply($x,static function(string $step)use($selected):void{if($step===$selected)throw new RuntimeException('Injected persisted-step interruption');}),'Injected persisted-step');
        cp_scope_require(initial_install_recover($x)['status']==='applied','Exact config/intent recovery failed');initial_install_complete($x);$x['db']->close();}
});
initial_install_check('unowned existing schema is never adopted, even when it exactly matches expected DDL',function():void{
    $x=initial_install_tree(initial_install_fresh());$x['db']->query($x['c']['sql']['statements'][CP_INITIAL_TABLES[0]]);
    initial_install_refuses(fn()=>cp_initial_installation_check($x['c'],$x['db'],$x['binding'],$x['sourcePath']),'Preexisting initial tables');cp_scope_require(!file_exists($x['state'].'/manifest.json'),'Adoption created journal');$x['db']->close();
});
initial_install_check('actual schema or row drift after a journaled CREATE holds without cleanup or repair',function():void{
    foreach(['column','rows','unjournaled'] as $case){$x=initial_install_tree(initial_install_fresh());
        initial_install_refuses(fn()=>initial_install_apply($x,static function(string $step):void{if($step==='created:'.CP_INITIAL_TABLES[0])throw new RuntimeException('Injected drift setup');}),'Injected drift');
        if($case==='column')$x['db']->query('ALTER TABLE clawpilot_email_bindings ADD COLUMN unexpected INT NULL');
        elseif($case==='rows')$x['db']->query("INSERT INTO clawpilot_email_bindings(pipeline_id,workspace_id,group_id,generation,owner_id,readers_json,audience_fingerprint,policy_fingerprint,runtime_fingerprint) VALUES('p','w','g',1,'u','[]',REPEAT('a',64),REPEAT('b',64),REPEAT('c',64))");
        else $x['db']->query($x['c']['sql']['statements'][CP_INITIAL_TABLES[1]]);
        initial_install_refuses(fn()=>initial_install_recover($x),$case==='column'?'differs':($case==='rows'?'existing managed rows':'without a retained DDL intent'));
        cp_scope_require(cp_initial_install_load($x['c'])['phase']!=='applied','Drift was normalized');$x['db']->close();}
});
initial_install_check('private original, source, binding, config and MariaDB setting drift all hold',function():void{
    foreach(['original','source','binding','config','mode'] as $case){$x=initial_install_tree(initial_install_fresh());
        initial_install_refuses(fn()=>initial_install_apply($x,static function(string $step):void{if($step==='intent:'.CP_INITIAL_TABLES[0])throw new RuntimeException('Injected evidence setup');}),'Injected evidence');
        if($case==='original')file_put_contents($x['state'].'/originals/config_override.php',"<?php // changed\n");
        elseif($case==='source')file_put_contents($x['state'].'/source.json',"{}\n");
        elseif($case==='binding')$x['binding']['appGeneration']=2;
        elseif($case==='config')file_put_contents($x['legacy'].'/config_override.php',"<?php // operator edit\n");
        else $x['db']->query("SET SESSION sql_mode='NO_ENGINE_SUBSTITUTION'");
        initial_install_refuses(fn()=>initial_install_recover($x),match($case){'original'=>'config original changed','source'=>'artifact bytes changed','binding'=>'retained install and plan','config'=>'neither retained before',default=>'Unrecognized MariaDB'});$x['db']->close();}
});
initial_install_check('completed read-only verification permits legitimate terminal/identity content without changing installed pins',function():void{
    $x=initial_install_tree(initial_install_fresh());initial_install_apply($x);$pins=cp_initial_installation_verify_installer($x['c'],$x['db'],$x['binding']);
    $x['db']->query("INSERT INTO clawpilot_email_initial_enrollments VALUES(REPEAT('a',64),REPEAT('b',64),REPEAT('c',64),REPEAT('d',64),'{}','{}','cancelled',CURRENT_TIMESTAMP(6))");
    $x['db']->query("INSERT INTO clawpilot_email_identities(email_id,global_id,local_id,pipeline_id,workspace_id,app_archived) VALUES('native','gi0000001','local','pipeline','workspace',0)");
    cp_scope_require(cp_initial_installation_verify_installer($x['c'],$x['db'],$x['binding'])===$pins,'Journal helper incorrectly treats legitimate data as a new install');
    // This tests only installed schema/file provenance, not native receipt or ACL validity.
    $x['db']->close();
});
initial_install_check('files-first provenance has no database dependency and native verification never adopts the DDL session',function():void{
    $x=initial_install_tree(initial_install_fresh());
    initial_install_refuses(fn()=>cp_initial_installation_verify_files($x['c'],$x['binding']),'Complete exact initial installation journal');
    initial_install_apply($x);$pins=cp_initial_installation_verify_installer($x['c'],$x['db'],$x['binding']);
    cp_scope_require(cp_initial_installation_verify_files($x['c'],$x['binding'])===$pins,'Files-first output leaked or changed provenance');
    $before=cp_initial_environment($x['db']);
    initial_install_refuses(fn()=>cp_initial_installation_verify($x['c'],$x['db'],$x['binding']),'Unrecognized native verification');
    cp_scope_require(cp_initial_environment($x['db'])===$before,'Native verifier normalized the DDL session');
    $x['db']->close();cp_scope_require(cp_initial_installation_verify_files($x['c'],$x['binding'])===$pins,'Files-first path requires a live database');
    file_put_contents($x['legacy'].'/config_override.php',"<?php throw new RuntimeException('Never include drifted config');\n");
    initial_install_refuses(fn()=>cp_initial_installation_verify_files($x['c'],$x['binding']),'Installed exact config changed');
});
fwrite(STDOUT,'NATIVE_INITIAL_INSTALLER_PASSED='.$checks."; actualMariaDbDdl=1; sourceCaptureSynthetic=1; nativeEnrollment=0; production=0\n");
