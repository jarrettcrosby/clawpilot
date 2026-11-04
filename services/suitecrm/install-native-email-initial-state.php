<?php
declare(strict_types=1);
// Explicit offline config/schema installation only. Never called by startup.
// No SuiteCRM bootstrap, enrollment, ACL/record changes, keys, or row cleanup.
// All offline utilities/Native* classes use one canonical image graph. Refuse
// an alternate already-loaded Patch graph before PHP can redeclare functions.
if(function_exists('clawpilot_native_scope_input_hashes')){
    $loaded=(new ReflectionFunction('clawpilot_native_scope_input_hashes'))->getFileName();$canonical=__DIR__.'/native-email-scope/Patch.php';
    if(!is_string($loaded)||realpath($loaded)!==realpath($canonical)||hash_file('sha256',$loaded)!==hash_file('sha256',$canonical))
        throw new RuntimeException('Initial installer requires the canonical image Patch graph');
}
require_once __DIR__.'/install-native-email-runtime.php';

const CP_INITIAL_STATE_PACKAGE='clawpilot-native-email-initial-state-v1';
const CP_INITIAL_CONFIG_BLOCK="\n// BEGIN ClawPilot initial managed Email write scope v1\n\$sugar_config['clawpilot_managed_email_write_scope'] = true;\n// END ClawPilot initial managed Email write scope v1\n";
const CP_INITIAL_SCHEMA_FILES=['publication-schema.sql','authority-transition-schema.sql','initial-enrollment-schema.sql'];
const CP_INITIAL_TABLES=['clawpilot_email_bindings','clawpilot_email_identities','clawpilot_email_operations',
    'clawpilot_email_authority_approvals','clawpilot_email_authority_operations','clawpilot_email_write_scopes',
    'clawpilot_email_write_permissions','clawpilot_email_initial_enrollments'];

function cp_initial_keys(mixed $value,array $keys): void
{cp_scope_require(is_array($value)&&!array_is_list($value),'Initial installer object required');$actual=array_keys($value);sort($actual,SORT_STRING);sort($keys,SORT_STRING);cp_scope_require($actual===$keys,'Initial installer object shape changed');}
function cp_initial_hash(mixed $value): void
{cp_scope_require(is_string($value)&&preg_match('/^[a-f0-9]{64}$/D',$value)===1,'Initial installer digest required');}
function cp_initial_canonical(mixed $value): string
{if(is_array($value)){if(!array_is_list($value))ksort($value,SORT_STRING);foreach($value as &$item)$item=json_decode(cp_initial_canonical($item),true,128,JSON_THROW_ON_ERROR);unset($item);}return json_encode($value,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);}
function cp_initial_digest(mixed $value): string {return hash('sha256',cp_initial_canonical($value));}
function cp_initial_binding(array $value): void
{
    cp_initial_keys($value,['operationId','nativeInstanceId','appGeneration','appSourceFingerprint','sourceArtifactDigest']);
    foreach(['operationId','appSourceFingerprint','sourceArtifactDigest'] as $key)cp_initial_hash($value[$key]);
    cp_scope_require(is_string($value['nativeInstanceId'])&&preg_match('/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/D',$value['nativeInstanceId'])===1
        &&is_int($value['appGeneration'])&&$value['appGeneration']>0&&$value['appGeneration']<=9007199254740991,'Initial reservation identity required');
}
function cp_initial_private(string $path,int $limit=4194304): string
{
    $stat=cp_scope_snapshot($path);cp_scope_require($stat!==null&&$stat['uid']===0&&$stat['mode']===0600&&$stat['size']<=$limit,'Exact root-owned mode 0600 initial artifact required');
    $bytes=(string)file_get_contents($path);cp_scope_require(hash('sha256',$bytes)===$stat['sha256'],'Initial artifact changed while reading');return $bytes;
}
function cp_initial_source(string $path,array $binding): array
{
    cp_initial_binding($binding);$bytes=cp_initial_private($path);
    cp_scope_require(hash('sha256',$bytes)===$binding['sourceArtifactDigest'],'Retained source artifact bytes changed');
    $source=json_decode($bytes,true,128,JSON_THROW_ON_ERROR);
    cp_initial_keys($source,['version','purpose','nativePolicyFingerprint','nativeRuntimeFingerprint','principalSuiteCrmUserIds','emails','defaults']);
    cp_scope_require($source['version']===1&&$source['purpose']==='clawpilot-native-email-initial-source','Actual initial source artifact required');
    cp_initial_hash($source['nativePolicyFingerprint']);cp_initial_hash($source['nativeRuntimeFingerprint']);
    foreach(['principalSuiteCrmUserIds'=>500,'emails'=>500,'defaults'=>5] as $key=>$cap)cp_scope_require(is_array($source[$key])&&array_is_list($source[$key])&&count($source[$key])>0&&count($source[$key])<=$cap,'Initial source inventory bound');
    cp_scope_require(count($source['defaults'])===5,'Complete initial source defaults required');return $source;
}
/** Token parsing only. Preserve every original byte, including a final close
 * tag/whitespace. An existing managed-key assignment is deliberately not adopted. */
function cp_initial_config(string $before): string
{
    cp_scope_require(!str_contains($before,'clawpilot_managed_email_write_scope'),'Existing managed config requires separate review');
    $tokens=token_get_all($before,TOKEN_PARSE);$offset=0;$close=null;$opened=0;
    foreach($tokens as $token){$bytes=is_array($token)?$token[1]:$token;
        if(is_array($token)&&$token[0]===T_OPEN_TAG){$opened++;cp_scope_require($opened===1&&$close===null,'One original PHP configuration block required');}
        if(is_array($token)&&$token[0]===T_CLOSE_TAG){cp_scope_require($close===null,'Unexpected config closing tag');$close=$offset;}
        if(is_array($token)&&$token[0]===T_INLINE_HTML)cp_scope_require(trim($bytes)==='','Config has non-PHP output');
        $offset+=strlen($bytes);}
    cp_scope_require($opened===1,'A parsed PHP configuration file is required');
    $after=$close===null?$before.CP_INITIAL_CONFIG_BLOCK:substr($before,0,$close).CP_INITIAL_CONFIG_BLOCK.substr($before,$close);
    token_get_all($after,TOKEN_PARSE);return $after;
}
function cp_initial_rows(mysqli $db,string $sql,array $parameters=[]): array
{
    $statement=null;$result=null;
    try{$statement=$db->prepare($sql);cp_scope_require($statement instanceof mysqli_stmt,'Initial schema metadata read failed');
        if($parameters)$statement->bind_param(str_repeat('s',count($parameters)),...$parameters);
        cp_scope_require($statement->execute(),'Initial schema metadata read failed');$result=$statement->get_result();cp_scope_require($result instanceof mysqli_result,'Initial schema metadata result required');
        $rows=$result->fetch_all(MYSQLI_ASSOC);cp_scope_require(count($rows)<=256&&strlen(json_encode($rows,JSON_THROW_ON_ERROR))<=1048576,'Initial schema metadata bound');return $rows;
    }catch(mysqli_sql_exception $error){throw new RuntimeException('Initial schema metadata query failed; state remains held');}
    finally{if($result instanceof mysqli_result)$result->free();if($statement instanceof mysqli_stmt)$statement->close();}
}
/** Public for the independent fresh-database profile generator. Production
 * never learns expected metadata here: it compares against the shipped profile. */
function cp_initial_schema_metadata(mysqli $db,string $table): ?array
{
    cp_scope_require(in_array($table,CP_INITIAL_TABLES,true),'Unknown initial schema table');
    $meta=cp_initial_rows($db,'SELECT ENGINE,TABLE_TYPE,ROW_FORMAT,TABLE_COLLATION,CREATE_OPTIONS FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table]);
    if($meta===[])return null;cp_scope_require(count($meta)===1&&$meta[0]['TABLE_TYPE']==='BASE TABLE','Initial schema object is not one base table');
    $create=cp_initial_rows($db,'SHOW CREATE TABLE `'.$table.'`');cp_scope_require(count($create)===1&&is_string($create[0]['Create Table']??null),'Exact CREATE readback required');
    return ['table'=>$meta[0],'create'=>$create[0]['Create Table'],
        'columns'=>cp_initial_rows($db,'SELECT ORDINAL_POSITION,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,CHARACTER_MAXIMUM_LENGTH,CHARACTER_SET_NAME,COLLATION_NAME,EXTRA,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[$table]),
        'indexes'=>cp_initial_rows($db,'SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,COLLATION,SUB_PART,NULLABLE,INDEX_TYPE,INDEX_COMMENT,IGNORED FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',[$table]),
        'constraints'=>cp_initial_rows($db,'SELECT CONSTRAINT_NAME,CONSTRAINT_TYPE FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY CONSTRAINT_NAME',[$table])];
}
function cp_initial_environment(mysqli $db): array
{
    $rows=cp_initial_rows($db,'SELECT VERSION() AS serverVersion,@@session.sql_mode AS sqlMode,@@session.character_set_connection AS characterSetConnection,@@session.collation_connection AS collationConnection,@@lower_case_table_names AS lowerCaseTableNames,@@session.foreign_key_checks AS foreignKeyChecks,@@session.unique_checks AS uniqueChecks');
    cp_scope_require(count($rows)===1,'Initial database environment unavailable');
    $schema=cp_initial_rows($db,'SELECT DEFAULT_CHARACTER_SET_NAME AS characterSet,DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()');
    cp_scope_require(count($schema)===1,'Initial database defaults unavailable');return ['server'=>$rows[0],'databaseDefaults'=>$schema[0]];
}
function cp_initial_sql(string $sourceRoot): array
{
    $sources=[];$statements=[];
    foreach(CP_INITIAL_SCHEMA_FILES as $file){$path=cp_runtime_path($sourceRoot,'email-audience/'.$file);$stat=cp_scope_snapshot($path);cp_scope_require($stat!==null,'Fixed initial SQL source missing');
        $bytes=(string)file_get_contents($path);$sources[$file]=$stat['sha256'];
        $plain=preg_replace('/^\s*--[^\n]*(?:\n|$)/m','',$bytes);cp_scope_require(is_string($plain),'Cannot read fixed SQL');
        foreach(explode(';',$plain) as $statement){$statement=trim($statement);if($statement==='')continue;
            cp_scope_require(preg_match('/^CREATE TABLE (clawpilot_email_[a-z_]+) \(/D',$statement,$match)===1,'Only fixed CREATE TABLE statements are admitted');
            $table=$match[1];cp_scope_require(!isset($statements[$table]),'Duplicate initial table');$statements[$table]=$statement;}}
    cp_scope_require(array_keys($statements)===CP_INITIAL_TABLES,'Fixed initial SQL statement inventory changed');return compact('sources','statements');
}
function cp_initial_installation_context(string $appRoot,string $stateRoot,string $sourceRoot=__DIR__): array
{
    cp_scope_path($appRoot);cp_scope_path($stateRoot,true);cp_scope_path($sourceRoot);
    cp_scope_require(is_dir($appRoot)&&is_dir($sourceRoot)&&!str_starts_with($stateRoot.'/',$appRoot.'/')&&!str_starts_with($appRoot.'/',$stateRoot.'/'),'Protected initial state must be outside the app tree');
    cp_scope_require(cp_scope_snapshot($appRoot.'/VERSION')!==null&&trim((string)file_get_contents($appRoot.'/VERSION'))==='8.10.1','Exact SuiteCRM 8.10.1 required');
    $sql=cp_initial_sql($sourceRoot);$profilePath=cp_runtime_path($sourceRoot,'native-email-initial-install-profile.json');$profileMeta=cp_scope_snapshot($profilePath);
    cp_scope_require($profileMeta!==null&&$profileMeta['size']<=131072,'Independently generated initial schema profile is missing');
    $profile=json_decode((string)file_get_contents($profilePath),true,64,JSON_THROW_ON_ERROR);
    cp_initial_keys($profile,['version','purpose','profile','sqlSources','environment','verificationEnvironment','tables']);
    cp_scope_require($profile['version']===1&&$profile['purpose']==='clawpilot-native-email-initial-install-profile'
        &&$profile['profile']==='suitecrm-8.10.1-mariadb-11.4.13-v1'&&$profile['sqlSources']===$sql['sources']
        &&array_keys($profile['tables'])===CP_INITIAL_TABLES,'Initial schema profile/source identity changed');
    $fileVerifiers=[];foreach(['install-native-email-scope.php','install-native-email-runtime.php','native-email-scope/Patch.php','native-email-scope/Scope.php'] as $file){
        $metadata=cp_scope_snapshot(cp_runtime_path($sourceRoot,$file));cp_scope_require($metadata!==null,'Canonical file verifier source missing');$fileVerifiers[$file]=$metadata['sha256'];}
    $packageHash=cp_initial_digest(['package'=>CP_INITIAL_STATE_PACKAGE,'installer'=>hash_file('sha256',__FILE__),'fileVerifiers'=>$fileVerifiers,
        'profile'=>$profileMeta['sha256'],'sqlSources'=>$sql['sources'],'configBlock'=>hash('sha256',CP_INITIAL_CONFIG_BLOCK)]);
    return ['appRoot'=>$appRoot,'legacy'=>$appRoot.'/public/legacy','stateRoot'=>$stateRoot,'sourceRoot'=>$sourceRoot,
        'sql'=>$sql,'profile'=>$profile,'profileHash'=>$profileMeta['sha256'],'packageHash'=>$packageHash];
}
function cp_initial_file_journals(array $c): array
{
    $root=dirname($c['stateRoot']);$paths=['scope'=>$root.'/clawpilot-native-email-scope-v1','runtime'=>$root.'/clawpilot-native-email-runtime-v1'];
    cp_scope_require(cp_scope_check(cp_scope_context($c['appRoot'],$paths['scope']))['status']==='applied','Actual scope file installation is incomplete');
    cp_scope_require(cp_runtime_check(cp_runtime_context($c['appRoot'],$paths['runtime'],$c['sourceRoot']))['status']==='applied','Actual runtime file installation is incomplete');
    $hashes=[];foreach($paths as $key=>$path)$hashes[$key]=hash('sha256',cp_initial_private($path.'/manifest.json',131072));return $hashes;
}
function cp_initial_database_inspection(array $c,mysqli $db): array
{
    $transaction=cp_initial_rows($db,'SELECT @@in_transaction AS activeTransaction,@@autocommit AS autocommit');
    cp_scope_require(count($transaction)===1&&(string)$transaction[0]['activeTransaction']==='0'&&(string)$transaction[0]['autocommit']==='1','Initial installer requires an otherwise idle autocommit connection');
    $environment=cp_initial_environment($db);
    $identity=cp_initial_rows($db,'SELECT DATABASE() AS databaseName,CURRENT_USER() AS databaseUser');cp_scope_require(count($identity)===1
        &&is_string($identity[0]['databaseName'])&&preg_match('/^[A-Za-z0-9_]{1,64}$/D',$identity[0]['databaseName'])===1,'Exact native database identity required');
    // Visibility of triggers/events cannot be inferred from an empty result.
    $runtime=$c['sourceRoot'].'/email-audience/NativeEmailRuntime.php';
    if(class_exists('ClawPilotNativeEmailRuntime',false)){$loaded=(new ReflectionClass('ClawPilotNativeEmailRuntime'))->getFileName();
        cp_scope_require(is_string($loaded)&&realpath($loaded)===realpath($runtime)&&cp_scope_snapshot($loaded)['sha256']===cp_scope_snapshot($runtime)['sha256'],'Initial installer requires the canonical image NativeRuntime graph');}
    else require_once $runtime;
    ClawPilotNativeEmailRuntime::assertDatabaseSideEffectProfile($db);
    return ['identity'=>$identity[0],'environment'=>$environment];
}
/** Standalone installer only. Its DDL session remains strictly pinned and is
 * never changed to imitate the native DBManager verification connection. */
function cp_initial_database_profile(array $c,mysqli $db): array
{
    $actual=cp_initial_database_inspection($c,$db);
    cp_scope_require(cp_initial_canonical($actual['environment'])===cp_initial_canonical($c['profile']['environment']),'Unrecognized MariaDB/charset/collation/sql-mode profile');return $actual;
}
/** Native read-only verification only. Stock DBManager establishes this
 * independently captured exact session; this helper must not issue SET to
 * normalize it, accept an OR-list, or learn a new profile from live state. */
function cp_initial_verification_database_profile(array $c,mysqli $db): array
{
    $actual=cp_initial_database_inspection($c,$db);
    cp_scope_require(isset($c['profile']['verificationEnvironment'])
        &&cp_initial_canonical($actual['environment'])===cp_initial_canonical($c['profile']['verificationEnvironment']),'Unrecognized native verification MariaDB/charset/collation/sql-mode profile');return $actual;
}
function cp_initial_empty(mysqli $db,string $table): void
{cp_scope_require(cp_initial_rows($db,'SELECT COUNT(*) AS rowCount FROM `'.$table.'`')===[['rowCount'=>0]],'Initial installer refuses existing managed rows');}
function cp_initial_exact_schema(array $c,mysqli $db,string $table): bool
{return cp_initial_canonical(cp_initial_schema_metadata($db,$table))===cp_initial_canonical($c['profile']['tables'][$table]);}
function cp_initial_installer_lock(array $c): mixed
{
    cp_scope_protected_directory($c['stateRoot'],false);$path=$c['stateRoot'].'/cli.lock';$bytes=cp_initial_private($path,0);
    cp_scope_require($bytes==='','Initial shared lock must remain empty');$lock=fopen($path,'r+b');cp_scope_require(is_resource($lock)&&flock($lock,LOCK_EX|LOCK_NB),'Another native initial operation is active');return $lock;
}
function cp_initial_install_load(array $c): ?array
{
    $path=$c['stateRoot'].'/manifest.json';cp_scope_path($path,true);if(!file_exists($path))return null;
    cp_scope_protected_directory($c['stateRoot'],false);$m=json_decode(cp_initial_private($path,262144),true,64,JSON_THROW_ON_ERROR);
    cp_initial_keys($m,['version','package','packageHash','appRoot','installId','plan','planHash','phase','steps']);
    cp_scope_require($m['version']===1&&$m['package']===CP_INITIAL_STATE_PACKAGE&&$m['packageHash']===$c['packageHash']&&$m['appRoot']===$c['appRoot'],'Initial journal/package identity changed');
    cp_initial_hash($m['installId']);cp_initial_hash($m['planHash']);cp_scope_require($m['planHash']===cp_initial_digest($m['plan']),'Retained initial plan changed');
    cp_scope_require(in_array($m['phase'],['prepared','applying-schema','schema-applied','applying-config','applied'],true)
        &&array_keys($m['steps'])===CP_INITIAL_TABLES,'Initial journal phase/steps changed');
    foreach($m['steps'] as $step)cp_scope_require(in_array($step,['absent','intent','done'],true),'Unknown initial DDL state');
    cp_initial_keys($m['plan'],['packageHash','binding','database','fileJournals','sourceRuntimeFingerprint','sourceArtifactDigest','configBefore','configAfter','schemaProfileHash','sqlSources']);
    cp_initial_binding($m['plan']['binding']);cp_initial_hash($m['plan']['sourceRuntimeFingerprint']);
    cp_scope_require($m['plan']['packageHash']===$c['packageHash']&&$m['plan']['sourceArtifactDigest']===$m['plan']['binding']['sourceArtifactDigest']&&$m['plan']['schemaProfileHash']===$c['profileHash']
        &&$m['plan']['sqlSources']===$c['sql']['sources'],'Initial journal source/profile changed');
    cp_scope_protected_directory($c['stateRoot'].'/originals',false);
    $original=cp_initial_private($c['stateRoot'].'/originals/config_override.php');
    cp_scope_require(hash('sha256',$original)===($m['plan']['configBefore']['sha256']??null),'Retained exact config original changed');
    $after=cp_initial_config($original);$expected=$m['plan']['configBefore'];$expected['sha256']=hash('sha256',$after);$expected['size']=strlen($after);
    cp_scope_require($expected===$m['plan']['configAfter'],'Retained config output changed');
    $source=cp_initial_source($c['stateRoot'].'/source.json',$m['plan']['binding']);
    cp_scope_require($source['nativeRuntimeFingerprint']===$m['plan']['sourceRuntimeFingerprint'],'Retained initial runtime source changed');return $m;
}
function cp_initial_installation_check(array $c,mysqli $db,array $binding,string $sourcePath): array
{
    cp_initial_binding($binding);$m=cp_initial_install_load($c);
    if($m!==null){cp_scope_require(cp_initial_canonical($m['plan']['binding'])===cp_initial_canonical($binding),'Initial reservation binding changed');
        $status=$m['phase']==='applied'?'applied':'recovery-required';if($status==='applied')cp_initial_installation_verify_installer($c,$db,$binding);
        return ['package'=>CP_INITIAL_STATE_PACKAGE,'packageHash'=>$c['packageHash'],'status'=>$status,'installId'=>$m['installId'],'planHash'=>$m['planHash'],'steps'=>$m['steps']];}
    $source=cp_initial_source($sourcePath,$binding);$database=cp_initial_database_profile($c,$db);$journals=cp_initial_file_journals($c);
    foreach(CP_INITIAL_TABLES as $table)cp_scope_require(cp_initial_schema_metadata($db,$table)===null,'Preexisting initial tables are not adopted');
    $path=$c['legacy'].'/config_override.php';$before=cp_scope_snapshot($path);cp_scope_require($before!==null,'Exact original config required');
    $bytes=(string)file_get_contents($path);cp_scope_require(hash('sha256',$bytes)===$before['sha256'],'Config changed during check');$updated=cp_initial_config($bytes);
    $after=$before;$after['sha256']=hash('sha256',$updated);$after['size']=strlen($updated);
    $plan=['packageHash'=>$c['packageHash'],'binding'=>$binding,'database'=>$database,'fileJournals'=>$journals,'sourceRuntimeFingerprint'=>$source['nativeRuntimeFingerprint'],
        'sourceArtifactDigest'=>$binding['sourceArtifactDigest'],'configBefore'=>$before,'configAfter'=>$after,'schemaProfileHash'=>$c['profileHash'],'sqlSources'=>$c['sql']['sources']];
    return ['package'=>CP_INITIAL_STATE_PACKAGE,'packageHash'=>$c['packageHash'],'status'=>'ready','planHash'=>cp_initial_digest($plan),'plan'=>$plan];
}
/** Before any persisted configuration/bootstrap include: validate only the
 * protected, complete installation and exact current file bytes. This is NOT
 * database/schema verification or native startup readiness. It deliberately
 * returns only the same two provenance hashes, never configuration contents. */
function cp_initial_installation_verify_files(array $c,array $expectedBinding): array
{
    cp_initial_binding($expectedBinding);$m=cp_initial_install_load($c);cp_scope_require($m!==null&&$m['phase']==='applied'
        &&cp_initial_canonical($m['plan']['binding'])===cp_initial_canonical($expectedBinding)&&array_values(array_unique($m['steps']))===['done'],'Complete exact initial installation journal required');
    cp_scope_require(cp_initial_file_journals($c)===$m['plan']['fileJournals'],'Initial file installation identity changed');
    cp_scope_require(cp_scope_matches(cp_scope_snapshot($c['legacy'].'/config_override.php'),$m['plan']['configAfter'],true),'Installed exact config changed');
    return ['sourceRuntimeFingerprint'=>$m['plan']['sourceRuntimeFingerprint'],'installationJournalFingerprint'=>cp_initial_digest($m)];
}
/** The CLI uses this read-only helper, never a caller-supplied installation
 * JSON. Legitimate enrolled rows/defaults are allowed; DDL/config/files cannot
 * drift. NativeInitial separately proves current before/after ACL/content. */
function cp_initial_installation_verify(array $c,mysqli $db,array $expectedBinding): array
{
    $pins=cp_initial_installation_verify_files($c,$expectedBinding);$m=cp_initial_install_load($c);
    cp_scope_require($m!==null&&cp_initial_digest($m)===$pins['installationJournalFingerprint'],'Initial installation journal changed while verifying');
    $database=cp_initial_verification_database_profile($c,$db);
    cp_scope_require($database['identity']===$m['plan']['database']['identity']
        &&cp_initial_canonical($m['plan']['database']['environment'])===cp_initial_canonical($c['profile']['environment']),'Initial database installation identity changed');
    foreach(CP_INITIAL_TABLES as $table)cp_scope_require(cp_initial_exact_schema($c,$db,$table),'Installed complete native schema changed');return $pins;
}
/** Explicit check/apply/recover final readback on the standalone strict DDL
 * connection. Native CLI/startup callers must use the fixed native verifier
 * above; there is deliberately no caller-selectable profile/bypass flag. */
function cp_initial_installation_verify_installer(array $c,mysqli $db,array $expectedBinding): array
{
    $pins=cp_initial_installation_verify_files($c,$expectedBinding);$m=cp_initial_install_load($c);
    cp_scope_require($m!==null&&cp_initial_digest($m)===$pins['installationJournalFingerprint'],'Initial installation journal changed while verifying');
    cp_scope_require(cp_initial_database_profile($c,$db)===$m['plan']['database'],'Initial database installation identity changed');
    foreach(CP_INITIAL_TABLES as $table)cp_scope_require(cp_initial_exact_schema($c,$db,$table),'Installed complete native schema changed');return $pins;
}
function cp_initial_installation_apply(array $c,mysqli $db,array $binding,string $sourcePath,bool $quiescent,string $approval,?callable $afterStep=null): array
{
    cp_scope_quiescent($quiescent);$lock=cp_initial_installer_lock($c);
    try{$check=cp_initial_installation_check($c,$db,$binding,$sourcePath);cp_scope_require(hash_equals($check['planHash'],$approval),'Exact independently reviewed initial install plan approval required');
        if($check['status']==='applied')return $check;cp_scope_require($check['status']==='ready','Interrupted initial installation requires explicit recovery');
        cp_scope_require(!file_exists($c['stateRoot'].'/originals')&&!file_exists($c['stateRoot'].'/source.json')&&!file_exists($c['stateRoot'].'/staged'),'Unjournaled initial preparation requires explicit review');
        cp_scope_protected_directory($c['stateRoot'].'/originals',true);cp_scope_protected_directory($c['stateRoot'].'/staged',true);
        cp_scope_require(stat($c['stateRoot'])['dev']===stat($c['legacy'])['dev'],'Initial staging must share the application filesystem');
        $original=(string)file_get_contents($c['legacy'].'/config_override.php');cp_scope_require(hash('sha256',$original)===$check['plan']['configBefore']['sha256'],'Config original changed before retention');
        cp_scope_write($c['stateRoot'].'/originals/config_override.php',$original);cp_scope_write($c['stateRoot'].'/source.json',cp_initial_private($sourcePath));
        cp_scope_write($c['stateRoot'].'/staged/config_override.php',cp_initial_config($original),$check['plan']['configAfter']);
        cp_scope_sync_directory($c['stateRoot'].'/originals');cp_scope_sync_directory($c['stateRoot'].'/staged');
        $m=['version'=>1,'package'=>CP_INITIAL_STATE_PACKAGE,'packageHash'=>$c['packageHash'],'appRoot'=>$c['appRoot'],'installId'=>bin2hex(random_bytes(32)),
            'plan'=>$check['plan'],'planHash'=>$check['planHash'],'phase'=>'prepared','steps'=>array_fill_keys(CP_INITIAL_TABLES,'absent')];
        cp_scope_journal($c['stateRoot'],$m);return cp_initial_install_forward($c,$db,$m,$quiescent,$afterStep);
    }finally{flock($lock,LOCK_UN);fclose($lock);}
}
function cp_initial_install_forward(array $c,mysqli $db,array $m,bool $quiescent,?callable $afterStep): array
{
    cp_scope_quiescent($quiescent);cp_scope_require(cp_initial_database_profile($c,$db)===$m['plan']['database']&&cp_initial_file_journals($c)===$m['plan']['fileJournals'],'Initial install prerequisites drifted');
    $config=cp_scope_snapshot($c['legacy'].'/config_override.php');cp_scope_require(cp_scope_matches($config,$m['plan']['configBefore'],true)
        ||($m['phase']==='applying-config'&&cp_scope_matches($config,$m['plan']['configAfter'],true)),'Config is neither retained before nor journaled after');
    // Validate the complete current set before creating anything. A table may
    // be recovered only after its durable intent, with the independently pinned
    // full schema and no rows. DDL success followed by lost response is unknown.
    foreach(CP_INITIAL_TABLES as $table){$actual=cp_initial_schema_metadata($db,$table);$step=$m['steps'][$table];
        cp_scope_require($step!=='absent'||$actual===null,'Table exists without a retained DDL intent');
        cp_scope_require($step!=='done'||$actual!==null,'Completed initial table disappeared');
        if($actual!==null){cp_scope_require(cp_initial_exact_schema($c,$db,$table),'Journaled initial DDL differs from independent expected profile');cp_initial_empty($db,$table);}}
    foreach(CP_INITIAL_TABLES as $table){
        if($m['steps'][$table]==='done')continue;
        if($m['steps'][$table]==='absent'){$m['phase']='applying-schema';$m['steps'][$table]='intent';cp_scope_journal($c['stateRoot'],$m);if($afterStep!==null)$afterStep('intent:'.$table);}
        if(cp_initial_schema_metadata($db,$table)===null){
            cp_scope_quiescent($quiescent);
            try{cp_scope_require($db->query($c['sql']['statements'][$table])===true,'Fixed initial DDL was not confirmed');}
            catch(mysqli_sql_exception $error){throw new RuntimeException('Initial DDL outcome requires exact retained recovery');}
            if($afterStep!==null)$afterStep('created:'.$table);
        }
        cp_scope_require(cp_initial_exact_schema($c,$db,$table),'Created initial schema readback differs');cp_initial_empty($db,$table);
        $m['steps'][$table]='done';cp_scope_journal($c['stateRoot'],$m);if($afterStep!==null)$afterStep('done:'.$table);
    }
    // Never downgrade an interrupted post-rename config intent: a second
    // interruption must still recognize the exact already-published config.
    if($m['phase']!=='applying-config'){$m['phase']='schema-applied';cp_scope_journal($c['stateRoot'],$m);}
    $config=cp_scope_snapshot($c['legacy'].'/config_override.php');
    if(!cp_scope_matches($config,$m['plan']['configAfter'],true)){
        $stage=$c['stateRoot'].'/staged/config_override.php';cp_scope_require(cp_scope_matches(cp_scope_snapshot($stage),$m['plan']['configAfter'],true),'Exact staged config unavailable');
        cp_scope_require(cp_scope_matches($config,$m['plan']['configBefore'],true),'Config changed before exact replacement');
        $m['phase']='applying-config';cp_scope_journal($c['stateRoot'],$m);if($afterStep!==null)$afterStep('config-intent');
        cp_scope_quiescent($quiescent);cp_scope_require(rename($stage,$c['legacy'].'/config_override.php'),'Config replacement requires recovery');
        cp_scope_sync_directory($c['legacy']);if($afterStep!==null)$afterStep('config-replaced');
    }
    cp_scope_require(cp_scope_matches(cp_scope_snapshot($c['legacy'].'/config_override.php'),$m['plan']['configAfter'],true),'Exact installed config readback failed');
    foreach(CP_INITIAL_TABLES as $table){cp_scope_require(cp_initial_exact_schema($c,$db,$table),'Initial schema drift before completion');cp_initial_empty($db,$table);}
    $m['phase']='applied';cp_scope_journal($c['stateRoot'],$m);cp_initial_installation_verify_installer($c,$db,$m['plan']['binding']);
    return ['package'=>CP_INITIAL_STATE_PACKAGE,'packageHash'=>$c['packageHash'],'status'=>'applied','installId'=>$m['installId'],'planHash'=>$m['planHash'],'steps'=>$m['steps']];
}
function cp_initial_installation_recover(array $c,mysqli $db,array $binding,bool $quiescent,string $approval,string $installId): array
{
    cp_scope_quiescent($quiescent);$lock=cp_initial_installer_lock($c);
    try{$m=cp_initial_install_load($c);cp_scope_require($m!==null&&cp_initial_canonical($m['plan']['binding'])===cp_initial_canonical($binding)&&hash_equals($m['planHash'],$approval)
        &&hash_equals($m['installId'],$installId),'Exact retained install and plan approval required');
        if($m['phase']==='applied'){cp_initial_installation_verify_installer($c,$db,$binding);return ['package'=>CP_INITIAL_STATE_PACKAGE,'packageHash'=>$c['packageHash'],'status'=>'applied','installId'=>$m['installId'],'planHash'=>$m['planHash'],'steps'=>$m['steps']];}
        return cp_initial_install_forward($c,$db,$m,$quiescent,null);
    }finally{flock($lock,LOCK_UN);fclose($lock);}
}

if(PHP_SAPI==='cli'&&realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__){
    try{$op='check';$app='/var/lib/suitecrm/app';$state='/var/lib/suitecrm/clawpilot-native-email-initial-enrollment-v1';$bindingPath='';$source='';$approval='';$install='';$quiescent=false;$seen=[];
        foreach(array_slice($argv,1) as $arg){$key=explode('=',$arg,2)[0];if(in_array($arg,['check','apply','recover'],true))$key='operation';cp_scope_require(!isset($seen[$key]),'Duplicate initial installer argument');$seen[$key]=true;
            if($key==='operation')$op=$arg;elseif($arg==='--quiescent')$quiescent=true;
            elseif(str_starts_with($arg,'--app-root='))$app=substr($arg,11);elseif(str_starts_with($arg,'--state-root='))$state=substr($arg,13);
            elseif(str_starts_with($arg,'--binding-file='))$bindingPath=substr($arg,15);elseif(str_starts_with($arg,'--source-artifact='))$source=substr($arg,18);
            elseif(str_starts_with($arg,'--approve-plan='))$approval=substr($arg,15);elseif(str_starts_with($arg,'--approve-install='))$install=substr($arg,18);
            else throw new RuntimeException('Unknown initial installer argument');}
        cp_scope_require($bindingPath!==''&&($op==='recover'||$source!==''),'Private exact binding/source artifacts required');
        cp_scope_require($op==='recover'||$install==='','Install identity is recovery-only');cp_scope_require($op!=='check'||(!$quiescent&&$approval===''),'Read-only check takes no mutation approval');
        cp_scope_require(getenv('CLAWPILOT_NATIVE_INITIAL_MAINTENANCE')==='1','Explicit initial maintenance environment required');
        $binding=json_decode(cp_initial_private($bindingPath,16384),true,32,JSON_THROW_ON_ERROR);cp_initial_binding($binding);
        $c=cp_initial_installation_context($app,$state);$database=(string)getenv('SUITECRM_DB_NAME');$port=(string)getenv('SUITECRM_DB_PORT');
        cp_scope_require(preg_match('/^[A-Za-z0-9_]{1,64}$/D',$database)===1&&preg_match('/^[0-9]{1,5}$/D',$port)===1&&(int)$port>0&&(int)$port<=65535,'Exact configured native database required');
        mysqli_report(MYSQLI_REPORT_ERROR|MYSQLI_REPORT_STRICT);$db=new mysqli((string)getenv('SUITECRM_DB_HOST'),(string)getenv('SUITECRM_DB_USER'),(string)getenv('SUITECRM_DB_PASSWORD'),$database,(int)$port);
        cp_scope_require($db->set_charset('utf8mb4'),'Initial connection charset unavailable');
        $result=match($op){'apply'=>cp_initial_installation_apply($c,$db,$binding,$source,$quiescent,$approval),
            'recover'=>cp_initial_installation_recover($c,$db,$binding,$quiescent,$approval,$install),default=>cp_initial_installation_check($c,$db,$binding,$source)};
        unset($result['plan']);fwrite(STDOUT,json_encode($result,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n");$db->close();exit($result['status']==='recovery-required'?2:0);
    }catch(Throwable $error){$safe=$error instanceof mysqli_sql_exception||$error instanceof JsonException?'Database/artifact operation failed; retained state remains held':$error->getMessage();fwrite(STDERR,'Native initial state held: '.$safe."\n");exit(1);}
}
