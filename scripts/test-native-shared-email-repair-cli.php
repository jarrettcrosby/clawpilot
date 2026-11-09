<?php
declare(strict_types=1);

require_once __DIR__.'/../services/suitecrm/native-email-shared-repair-cli.php';

function sharedRepairTest(bool $ok,string $case): void
{if(!$ok)throw new RuntimeException('Shared repair CLI fixture failed: '.$case);}
function sharedRepairRefusal(callable $fn,string $code): void
{
    try{$fn();}catch(RuntimeException $error){sharedRepairTest($error->getMessage()==='shared_repair_'.$code,$code);return;}
    throw new RuntimeException('Expected shared repair CLI refusal: '.$code);
}

$uuid=static fn(int $i): string=>sprintf('00000000-0000-4000-8000-%012d',$i);
$hash=static fn(string $s): string=>hash('sha256',$s);
$key=openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_RSA,'private_key_bits'=>3072]);
sharedRepairTest($key instanceof OpenSSLAsymmetricKey,'fixture key');
$target=[];
foreach(CP_SHARED_REPAIR_RAILWAY as $field=>$_)$target[$field]=$field==='gitCommit'?str_repeat('a',40):$uuid(count($target)+1);
$target+=['database'=>'suitecrm_test','databasePrincipal'=>'suitecrm_test@%','serviceUserId'=>'fixture-admin','oauthClientId'=>$uuid(50)];
$bindings=[];foreach(CP_SHARED_REPAIR_BINDINGS as $name)$bindings[$name]=$hash($name);
$bootstrap=array_fill_keys(CP_SHARED_REPAIR_BOOTSTRAP,null);
$bootstrap['vendor/autoload.php']=$hash('vendor');$bootstrap['public/legacy/config.php']=$hash('config');
$bootstrap['public/legacy/include/entryPoint.php']='8f54a619a83286ab80937f818a67cf4fa98efd40f15b074da774023ec940ee73';
$pins=['version'=>1,'target'=>$target,'bindings'=>$bindings,'expectEmailTemplates'=>false,'keyId'=>'stock-operator',
    'publicKeyPem'=>openssl_pkey_get_details($key)['key'],'bootstrapPins'=>$bootstrap,'original11'=>[],'later8'=>[]];
$commands=[];
for($i=1;$i<=19;$i++){
    $localId=$uuid(100+$i);$nativeId=$uuid(200+$i);$globalId=sprintf('gi%07d',$i);
    $command=['suiteCrmId'=>$nativeId,'attributes'=>['global_id_c'=>$globalId,'name'=>'Fixture message',
        'date_sent_received'=>'2026-11-06T00:00:00Z','type'=>'archived','status'=>'sent','parent_type'=>'','parent_id'=>'',
        'assigned_user_id'=>'fixture-admin','description'=>'Fixture body','description_html'=>'','from_addr_name'=>'sender@example.test'],
        'accounts'=>[],'contacts'=>[],'contactAccounts'=>[],'previousManaged'=>['accounts'=>[],'contacts'=>[]],'expectedBeforeFingerprint'=>null];
    $commands[$localId]=$command;
    $pins[$i<=11?'original11':'later8'][]=['localId'=>$localId,'nativeId'=>$nativeId,'globalId'=>$globalId,
        'projectionFingerprint'=>ClawPilotNativeEmailAuthorityContract::digest($command),
        'slotFingerprint'=>$hash('slot-'.$i),'nonce'=>$hash('nonce-'.$i)];
}
$slots=cp_shared_repair_pins($pins);sharedRepairTest(count($slots)===19,'exact two cohorts');
$first=$pins['original11'][0];$localId=$first['localId'];$command=$commands[$localId];
$input=['localId'=>$localId,'projection'=>$command];
[$slot,$parsed,$permit]=cp_shared_repair_input($input,'inspect',$slots);
sharedRepairTest($slot===$first&&$parsed===$command&&$permit===null,'exact read-only projection');
sharedRepairRefusal(fn()=>cp_shared_repair_input(array_replace($input,['localId'=>$uuid(999)]),'inspect',$slots),'slot_unreviewed');
sharedRepairRefusal(fn()=>cp_shared_repair_input($input+['nonce'=>$hash('fake')],'inspect',$slots),'shape');
$different=$input;$different['projection']['attributes']['description']='Different body';
sharedRepairRefusal(fn()=>cp_shared_repair_input($different,'readback',$slots),'projection_changed');
$duplicate=$pins;$duplicate['later8'][0]['globalId']=$first['globalId'];
sharedRepairRefusal(fn()=>cp_shared_repair_pins($duplicate),'duplicate_slot');
$missing=$pins;array_pop($missing['original11']);sharedRepairRefusal(fn()=>cp_shared_repair_pins($missing),'cohort');

$scope=cp_shared_repair_trusted_scope($pins,$first,$hash('stock-policy'));
$proof=['version'=>1,'purpose'=>'clawpilot-shared-bpo-email-create-v1','scope'=>$scope,'issuedAt'=>1000,'expiresAt'=>1060];
sharedRepairTest(openssl_sign(ClawPilotNativeEmailAuthorityContract::canonical($proof),$sig,$key,OPENSSL_ALGO_SHA256),'fixture signature');
$permit=['proof'=>$proof,'signature'=>base64_encode($sig)];
[,,$parsedPermit]=cp_shared_repair_input($input+['permit'=>$permit],'create',$slots);
$verified=ClawPilotSharedBpoEmailCreatePermit::verify($parsedPermit,$scope,$command,$pins['publicKeyPem'],1010);
sharedRepairTest($verified->journalBinding()['nativeId']===$first['nativeId'],'signed exact creation binding');
try{ClawPilotSharedBpoEmailCreatePermit::verify($parsedPermit,$scope,$command,$pins['publicKeyPem'],1060);throw new LogicException('Expired permit accepted');}
catch(ClawPilotNativeEmailTransactionRefused $error){sharedRepairTest($error->holdCode==='shared_bpo_email_create_permit_clock','expired permit held');}
sharedRepairTest(cp_shared_repair_input($input,'readback',$slots)[2]===null,'readback does not need renewed create authorization');
fwrite(STDOUT,"Native shared repair CLI contract: exact 11+8 allowlist, input/role-free scope, signed creation and expiry-independent readback passed.\n");
