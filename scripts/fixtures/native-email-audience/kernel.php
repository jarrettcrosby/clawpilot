<?php
declare(strict_types=1);
require 'modules/Emails/Email.php';
require '/source/install-email-audience.php';
install_clawpilot_email_audience('/source/email-audience', getcwd());
require 'custom/include/ClawPilot/EmailAudience.php';

class User
{
    public $id;
    public $status;
    private $administrator;
    public function __construct($id, $administrator, $status = 'Active') { $this->id=$id; $this->administrator=$administrator; $this->status=$status; }
    public function isAdmin() { return $this->administrator; }
}
class BeanFactory
{
    public static function getBean($module, $id) {
        if ($module === 'Users') return $GLOBALS['fixture']['users'][$id] ?? false;
        if ($module === 'Emails') return new Email();
        throw new RuntimeException('Unexpected module');
    }
    public static function newBean($module) { if ($module !== 'Emails') throw new RuntimeException('Unexpected module'); return new Email(); }
}
class FixtureResult { public $rows; public $offset=0; public function __construct($rows) { $this->rows=$rows; } }
class FixtureDb
{
    public $queries=[];
    public function quote($value) { return addslashes($value); }
    public function query($sql, $die = true) {
        if (!preg_match('/^\s*SELECT\b/i', $sql)) throw new RuntimeException('Database writes are prohibited');
        $this->queries[]=$sql;
        $fixture=$GLOBALS['fixture'];
        if (strpos($sql,'securitygroups_default')!==false) return new FixtureResult($fixture['defaultGroups'] ? [['id'=>'default-group']] : []);
        if (strpos($sql,'aow_workflow')!==false) return new FixtureResult($fixture['workflow'] ? [['id'=>'workflow']] : []);
        if (strpos($sql,'FROM emails')!==false) return new FixtureResult($fixture['exists'] ? [['id'=>'native-email']] : []);
        if (strpos($sql,'FROM users')!==false) return new FixtureResult(array_map(fn($id)=>['id'=>$id],array_keys($fixture['users'])));
        if (strpos($sql,'oauth2clients')!==false) return new FixtureResult([['assigned_user_id'=>'native-owner']]);
        throw new RuntimeException('Unexpected read query');
    }
    public function fetchByAssoc($result) { return $result->rows[$result->offset++] ?? false; }
}
class DBManagerFactory { public static function getInstance() { return $GLOBALS['fixtureDb']; } }
class FixtureApp { public $handler; public function post($path,$handler) { if($path!=='/clawpilot-email-audience')throw new RuntimeException('Unexpected route'); $this->handler=$handler; } }
class FixtureRequest
{
    public $body; public $client='native-client'; public $user='native-owner';
    public function __construct($command) { $this->body=json_encode($command,JSON_THROW_ON_ERROR); }
    public function getAttribute($key) { return $key==='oauth_client_id'?$this->client:($key==='oauth_user_id'?$this->user:null); }
    public function getBody() { return $this->body; }
    public function getHeaderLine($key) { return 'application/vnd.api+json'; }
}
class FixtureResponse
{
    public $body; public $status=200; public $headers=[];
    public function withHeader($key,$value) { $this->headers[$key]=$value; return $this; }
    public function withJson($body,$status=200) { $this->body=$body; $this->status=$status; return $this; }
}
function reset_fixture(): void {
    $GLOBALS['fixture']=['exists'=>true,'defaultGroups'=>false,'workflow'=>false,'permissions'=>[], 'evaluated'=>[],
        'users'=>['native-owner'=>new User('native-owner',true), 'native-service'=>new User('native-service',false),
            'native-inactive'=>new User('native-inactive',false,'Inactive')]];
    $GLOBALS['fixtureDb']=new FixtureDb();
    $GLOBALS['sugar_config']=['securitysuite_inherit_creator'=>false,'securitysuite_inherit_assigned'=>false,'securitysuite_inherit_parent'=>false];
    $GLOBALS['current_user']=new User('previous-user',false);
    $_SESSION=['preserved'=>'session'];
}
function command_fixture(): array {
    $audience=['policy'=>'pipeline-internal','ownerSuiteCrmId'=>'native-owner','allowedSuiteCrmUserIds'=>['native-owner'],
        'workspaceId'=>'native-workspace','pipelineId'=>'native-pipeline'];
    $audience['fingerprint']=hash('sha256',json_encode($audience,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));
    return ['version'=>1,'phase'=>'before','suiteCrmId'=>'native-email','globalId'=>'gi1234567','assignedUserId'=>'native-owner',
        'accounts'=>['native-account'],'contacts'=>['native-contact'],'audience'=>$audience];
}
function must($value,$message): void { if (!$value) throw new RuntimeException($message); }
function refuses(callable $run): void { try{$run();}catch(RuntimeException $error){return;}throw new RuntimeException('Expected safe refusal'); }
$checks=0;
function check_kernel($name,callable $run): void { reset_fixture();$run();$GLOBALS['checks']++;echo "PASS $name\n"; }

check_kernel('exact read-only audience includes approved administrator and evaluates denied service/inactive principals',function(){
    $proof=clawpilot_email_audience_proof(command_fixture(),'native-owner');
    must($proof['readerSuiteCrmUserIds']===['native-owner'],'Exact readers');
    must($proof['administratorSuiteCrmUserIds']===['native-owner'],'Explicit administrator');
    must(count($GLOBALS['fixture']['evaluated'])===3,'Every principal must be evaluated');
    must($GLOBALS['current_user']->id==='previous-user' && $_SESSION===['preserved'=>'session'],'Restore request globals');
});
check_kernel('missing/new native Email can be proven without save and after phase requires existence',function(){
    $GLOBALS['fixture']['exists']=false;
    must(clawpilot_email_audience_proof(command_fixture(),'native-owner')['complete']===true,'Unsaved owner template');
    $command=command_fixture();$command['phase']='after';refuses(fn()=>clawpilot_email_audience_proof($command,'native-owner'));
});
foreach(['view','list','export'] as $surface)check_kernel("extra reader through $surface is refused",function()use($surface){
    $GLOBALS['fixture']['permissions']['native-service'][$surface]=true;
    refuses(fn()=>clawpilot_email_audience_proof(command_fixture(),'native-owner'));
});
check_kernel('inactive principal read permission is conservatively refused',function(){
    $GLOBALS['fixture']['permissions']['native-inactive']['view']=true;
    refuses(fn()=>clawpilot_email_audience_proof(command_fixture(),'native-owner'));
});
check_kernel('new unapproved administrator is refused',function(){
    $GLOBALS['fixture']['users']['other-admin']=new User('other-admin',true);
    refuses(fn()=>clawpilot_email_audience_proof(command_fixture(),'native-owner'));
});
check_kernel('forged audience fingerprint is refused',function(){
    $command=command_fixture();$command['audience']['fingerprint']=str_repeat('0',64);
    refuses(fn()=>clawpilot_email_audience_proof($command,'native-owner'));
});
foreach(['defaultGroups','workflow'] as $flag)check_kernel("implicit $flag sharing is refused",function()use($flag){
    $GLOBALS['fixture'][$flag]=true;refuses(fn()=>clawpilot_email_audience_proof(command_fixture(),'native-owner'));
});
check_kernel('observed profile with all inheritance flags true and generated module hooks is safely refused, not certified compatible',function(){
    foreach(['Emails','Accounts','Contacts'] as $module){$directory='custom/modules/'.$module;mkdir($directory,0755,true);file_put_contents($directory.'/logic_hooks.php','<?php // controlled generated-hook fixture');}
    $GLOBALS['sugar_config']=array_fill_keys(['securitysuite_inherit_creator','securitysuite_inherit_assigned','securitysuite_inherit_parent'],true);
    refuses(fn()=>clawpilot_email_audience_proof(command_fixture(),'native-owner'));
    must(count($GLOBALS['fixtureDb']->queries)===0,'Observed unsupported profile must stop before query/write work');
});
check_kernel('generated hooks alone remain unreviewed and refused',function(){
    refuses(fn()=>clawpilot_email_audience_proof(command_fixture(),'native-owner'));
    foreach(['Emails','Accounts','Contacts'] as $module)unlink('custom/modules/'.$module.'/logic_hooks.php');
});

$app=new FixtureApp();require 'custom/application/Ext/Api/V8/Config/routes.php';
putenv('SUITECRM_CLIENT_ID=native-client'); // Synthetic fixture value only; no host environment is passed.
check_kernel('installed route executes authorized read-only proof using existing configured OAuth client',function()use($app){
    $response=($app->handler)(new FixtureRequest(command_fixture()),new FixtureResponse());
    must($response->status===200 && $response->body['complete']===true,'Authorized proof route');
});
check_kernel('foreign OAuth client and nonadmin principal cannot use proof route',function()use($app){
    $request=new FixtureRequest(command_fixture());$request->client='foreign-client';
    must(($app->handler)($request,new FixtureResponse())->status===403,'Foreign client');
    $request=new FixtureRequest(command_fixture());$request->user='native-service';
    must(($app->handler)($request,new FixtureResponse())->status===403,'Deny-role service principal');
});
check_kernel('oversized and fabricated-subject commands return fixed held error without private details',function()use($app){
    $request=new FixtureRequest(command_fixture());$request->body=str_repeat('x',32769);
    $response=($app->handler)($request,new FixtureResponse());must($response->status===409,'Size bound');
    $command=command_fixture();$command['providerAccountId']='caller-forged';
    $response=($app->handler)(new FixtureRequest($command),new FixtureResponse());must($response->status===409,'Exact command shape');
    must($response->body['error']==='Native Email audience proof is unavailable','No private diagnostics');
});
check_kernel('installer is idempotent and refuses unmanaged route or symlink without overwriting it',function(){
    install_clawpilot_email_audience('/source/email-audience',getcwd());
    $path='custom/application/Ext/Api/V8/Config/routes.php';file_put_contents($path,'<?php // operator-owned route');
    refuses(fn()=>install_clawpilot_email_audience('/source/email-audience',getcwd()));
    must(file_get_contents($path)==='<?php // operator-owned route','Preserve unmanaged source');
    unlink($path);symlink('/source/email-audience/routes.php',$path);
    refuses(fn()=>install_clawpilot_email_audience('/source/email-audience',getcwd()));
});
echo "Native Email audience PHP kernel passed $checks controlled-stub checks; not pinned SuiteCRM runtime equivalence.\n";
