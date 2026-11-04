<?php
declare(strict_types=1);
// PURE contracts/signatures only. The existing five-group fixture supplies
// synthetic plan/key values; no database, bootstrap or native response is used.
require __DIR__.'/native-email-initial-enrollment.php';
$L=ClawPilotNativeEmailInitialInstallationLineage::class;$lineageChecks=0;
$lineageCheck=static function(string $name,callable $run)use(&$lineageChecks):void{$run();$lineageChecks++;fwrite(STDOUT,'PASS '.$name."\n");};
$operationB=hash('sha256','synthetic-replan-B');$freshRuntime=hash('sha256','fresh-installed-runtime');
$rootProof=$proof;$rootProof['issuedAt']=time()-240;$rootProof['expiresAt']=time()-120;
function lineagePureRow(array $p,?array $authorization=null): array
{
    global $C,$sign;$authorization??=$sign($p);$approvalHash=$C::digest($authorization);
    $receipt=['version'=>1,'purpose'=>'clawpilot-native-email-initial-enrollment-receipt','operationId'=>$p['operationId'],
        'planHash'=>$p['planHash'],'approvalHash'=>$approvalHash,'state'=>'cancelled','result'=>null];
    return ['operation_id'=>$p['operationId'],'plan_hash'=>$p['planHash'],'delta_fingerprint'=>$p['deltaFingerprint'],'approval_hash'=>$approvalHash,
        'approval_json'=>$C::canonical($authorization),'receipt_json'=>$C::canonical($receipt),'state'=>'cancelled','created_at'=>'synthetic physical metadata'];
}
$historical=$reflection->getMethod('historicalTerminal');$rootRow=lineagePureRow($rootProof);
$rootRetained=$historical->invoke($service,$rootRow,'native-fixture');$history=[$rootRetained['entry']];
$historyMaterial=['history'=>$history,'proofs'=>[$rootProof['operationId']=>$rootProof],'fingerprint'=>$L::historyFingerprint($history)];
$lineage=['version'=>1,'purpose'=>'clawpilot-native-email-initial-installation-lineage','rootOperationId'=>$rootProof['operationId'],
    'rootInstallationJournalFingerprint'=>$rootProof['installationJournalFingerprint'],'rootSourceArtifactDigest'=>hash('sha256','retained-root-source'),
    'rootStockRuntimeFingerprint'=>$rootProof['sourceRuntimeFingerprint'],'predecessorOperationId'=>$rootProof['operationId'],
    'predecessorPlanHash'=>$rootProof['planHash'],'predecessorApprovalHash'=>$rootRow['approval_hash'],
    'predecessorCancellationReceiptHash'=>$C::digest(json_decode($rootRow['receipt_json'],true,32,JSON_THROW_ON_ERROR)),
    'previousLineageHash'=>null,'depth'=>1,'cancelledHistoryFingerprint'=>$historyMaterial['fingerprint'],
    'freshSourceArtifactDigest'=>hash('sha256','fresh-source-B'),'freshInstalledRuntimeFingerprint'=>$freshRuntime];
$context=$L::contextFromLineage($lineage,$operationB);
$lineageCheck('strict native lineage/context scalars separate fresh artifact fields and preserve defensive value copies',static function()use($C,$L,$lineage,$context,$operationB):void{
    initialPureNeed($C::canonical($L::prepare($lineage,$operationB))===$C::canonical($lineage),'Lineage changed');
    initialPureNeed(!isset($context['freshSourceArtifactDigest'])&&!isset($context['freshInstalledRuntimeFingerprint'])
        &&$context['purpose']==='clawpilot-native-email-initial-replan-context','Context contains recursive fresh fields');
    initialPureNeed($L::prepareContext($context,$operationB)===$context,'Context changed');
    $reference=hash('sha256','reference');$aliased=$lineage;$aliased['freshSourceArtifactDigest']=&$reference;
    $copy=$L::prepare($aliased,$operationB);$reference=hash('sha256','changed-reference');
    initialPureNeed($copy['freshSourceArtifactDigest']!==$reference,'Scalar result retained caller alias');
    foreach(['extra','missing','float-depth','zero-depth','overflow-depth','uppercase-hash','self','wrong-purpose','previous-hash'] as $change){$bad=$lineage;
        match($change){'extra'=>$bad['extra']=true,'missing'=>null,'float-depth'=>$bad['depth']=1.0,'zero-depth'=>$bad['depth']=0,
            'overflow-depth'=>$bad['depth']=501,'uppercase-hash'=>$bad['rootSourceArtifactDigest']=str_repeat('A',64),
            'self'=>$bad['rootOperationId']=$operationB,'wrong-purpose'=>$bad['purpose']=$context['purpose'],
            'previous-hash'=>$bad['previousLineageHash']=hash('sha256','unexpected')};
        if($change==='missing')unset($bad['freshSourceArtifactDigest']);initialPureReject(static fn()=>$L::prepare($bad,$operationB));}
    $bad=$context;$bad['freshSourceArtifactDigest']=$lineage['freshSourceArtifactDigest'];
    initialPureReject(static fn()=>$L::prepareContext($bad,$operationB));
});
$lineageCheck('v1 remains exact while replan plan requires lineage and actual fresh-runtime scalar equality',static function()use($plan,$lineage,$operationB,$freshRuntime):void{
    ClawPilotNativeEmailInitialEnrollment::validatePlan($plan);$replan=$plan;$replan['kind']='initial_enrollment_replan_v1';
    $replan['operationId']=$operationB;$replan['nativeRuntimeBeforeFingerprint']=$freshRuntime;$replan['installationLineage']=$lineage;
    ClawPilotNativeEmailInitialEnrollment::validatePlan($replan);
    $bad=$plan;$bad['installationLineage']=$lineage;initialPureReject(static fn()=>ClawPilotNativeEmailInitialEnrollment::validatePlan($bad));
    $bad=$replan;unset($bad['installationLineage']);initialPureReject(static fn()=>ClawPilotNativeEmailInitialEnrollment::validatePlan($bad));
    $bad=$replan;$bad['nativeRuntimeBeforeFingerprint']=$plan['nativeRuntimeBeforeFingerprint'];
    initialPureReject(static fn()=>ClawPilotNativeEmailInitialEnrollment::validatePlan($bad));
    $bad=$replan;$bad['rootEmployeeGrants']=[['userId'=>'viewer']];initialPureReject(static fn()=>ClawPilotNativeEmailInitialEnrollment::validatePlan($bad));
});
$lineageCheck('effective installation digest binds exact root journal plus full lineage without reinterpreting stock as fresh runtime',static function()use($C,$L,$lineage,$operationB):void{
    $expected=$C::digest(['version'=>1,'purpose'=>'clawpilot-native-email-initial-effective-installation',
        'rootInstallationJournalFingerprint'=>$lineage['rootInstallationJournalFingerprint'],'installationLineageHash'=>$L::digest($lineage,$operationB)]);
    initialPureNeed($L::effectiveInstallationJournalFingerprint($lineage,$operationB)===$expected,'Effective journal domain differs');
    $bad=$lineage;$bad['freshSourceArtifactDigest']=hash('sha256','other-fresh-source');
    initialPureNeed($L::effectiveInstallationJournalFingerprint($bad,$operationB)!==$expected,'Fresh artifact was omitted from effective lineage digest');
});
$lineageCheck('signed expired native tombstone validates original issuer identity and exact canonical stored hashes',static function()use($historical,$service,$rootRow,$rootProof,$rootRetained,$sign,$C):void{
    $changed=$rootRow;$changed['created_at']='different physical metadata';
    initialPureNeed($historical->invoke($service,$changed,'native-fixture')['entry']===$rootRetained['entry'],'Physical creation metadata changed history identity');
    foreach(['keyId','serviceUserId','oauthClientId','nativeInstanceId','purpose','issuer','audience'] as $field){$p=$rootProof;$p[$field]='other';$bad=lineagePureRow($p);
        initialPureReject(static fn()=>$historical->invoke($service,$bad,'native-fixture'));}
    $bad=$rootRow;$bad['approval_json'].="\n";initialPureReject(static fn()=>$historical->invoke($service,$bad,'native-fixture'));
    $bad=$rootRow;$bad['receipt_json'].=' ';initialPureReject(static fn()=>$historical->invoke($service,$bad,'native-fixture'));
    foreach(['plan_hash','delta_fingerprint','approval_hash'] as $field){$bad=$rootRow;$bad[$field]=hash('sha256','changed');
        initialPureReject(static fn()=>$historical->invoke($service,$bad,'native-fixture'));}
    $approval=$sign($rootProof);$approval['signature']=str_repeat('A',512);$bad=lineagePureRow($rootProof,$approval);
    initialPureReject(static fn()=>$historical->invoke($service,$bad,'native-fixture'));
    $p=$rootProof;$p['expiresAt']=time()+30;$p['issuedAt']=time()-30;$bad=lineagePureRow($p);
    initialPureReject(static fn()=>$historical->invoke($service,$bad,'native-fixture'));
});
$lineageCheck('history digest uses exact sorted five-field rows and excludes all physical metadata',static function()use($L,$history,$C):void{
    initialPureNeed($L::historyFingerprint($history)===$C::digest($history),'History fingerprint parity failed');
    $bad=$history;$bad[0]['created_at']='not in protocol';initialPureReject(static fn()=>$L::historyFingerprint($bad));
    $bad=[$history[0],$history[0]];initialPureReject(static fn()=>$L::historyFingerprint($bad));
    $a=$history[0];$a['operationId']=str_repeat('a',64);$b=$a;$b['operationId']=str_repeat('b',64);
    $L::historyFingerprint([$a,$b]);initialPureReject(static fn()=>$L::historyFingerprint([$b,$a]));
});
$verifyContext=$reflection->getMethod('verifyHistoryContext');
$lineageCheck('current history context requires all actual row anchors, root signed stock/journal pins and exact complete depth',static function()use($verifyContext,$service,$context,$operationB,$historyMaterial):void{
    $verifyContext->invoke($service,$context,$operationB,$historyMaterial);
    foreach(['rootInstallationJournalFingerprint','rootStockRuntimeFingerprint','predecessorPlanHash','predecessorApprovalHash',
        'predecessorCancellationReceiptHash','cancelledHistoryFingerprint'] as $field){$bad=$context;$bad[$field]=hash('sha256','changed');
        initialPureReject(static fn()=>$verifyContext->invoke($service,$bad,$operationB,$historyMaterial));}
    $bad=$historyMaterial;$bad['history']=[];initialPureReject(static fn()=>$verifyContext->invoke($service,$context,$operationB,$bad));
});
$lineageCheck('historical cancellation verification never calls forecast or captures ancestor before permissions',static function():void{
    $source=(string)file_get_contents(__DIR__.'/../../services/suitecrm/email-audience/NativeEmailInitialEnrollment.php');
    $start=strpos($source,'private function verifyCancelledBefore(');$end=strpos($source,'private function forecast(',$start);
    initialPureNeed($start!==false&&$end!==false,'Historical cancellation method missing');$section=substr($source,$start,$end-$start);
    initialPureNeed(!str_contains($section,'$this->forecast(')&&!str_contains($section,'$this->capture(')
        &&str_contains($section,'$this->historicalTerminal('),'Cancelled history replays obsolete current evidence');
    initialPureNeed(str_contains($source,"'initial_replan_required'")&&str_contains($source,'ClawPilotNativeEmailTransaction::begin($this->db,$this->profile)'),
        'Explicit replan/actual transaction source guard missing');
});
fwrite(STDOUT,'NATIVE_INITIAL_INSTALLATION_LINEAGE_PURE_PASSED='.$lineageChecks."\n");
fwrite(STDOUT,'PURE_LINEAGE_DIGEST='.$L::digest($lineage,$operationB)."\n");
fwrite(STDOUT,"BOUNDARY: scalar/synthetic signature checks only; no actual history/runtime/DB/bootstrap or production proof\n");
