<?php
declare(strict_types=1);
require '/source/email-audience/NativeEmailAuthorityProof.php';
$path='/fixture-authority-issuer.json';
if(PHP_SAPI!=='cli' || getenv('CLAWPILOT_NATIVE_FIXTURE_REMEDIATION')!=='1' || !is_file($path) || is_link($path) || filesize($path)>100000)
    throw new RuntimeException('Bounded synthetic cross-language proof fixture required');
$f=json_decode((string)file_get_contents($path),true,64,JSON_THROW_ON_ERROR);
if(($f['syntheticOnly']??null)!==true || !is_array($f['config']??null))throw new RuntimeException('Synthetic-only issuer evidence required');
putenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID='.$f['config']['keyId']);
putenv('SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID='.$f['config']['nativeInstanceId']);
putenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY='.$f['publicKey']);
$checks=0;
foreach(['revoke','grant'] as $phase) {
    $e=$f[$phase]['envelope'];$c=$f[$phase]['command'];ClawPilotNativeEmailAuthorityContract::validate($c);
    // Retained-proof verification mode only: the fixture clock may be old.
    // Actual approve/execute still checks current signed expiry independently.
    $p=ClawPilotNativeEmailAuthorityProof::verify($e,$c,$f['config']['serviceUserId'],$f['config']['oauthClientId'],true);
    if($p!==$e['proof'])throw new RuntimeException('Exact TS/PHP issuer proof parity required');$checks++;
    $bad=$e;$bad['proof']['planHash']=str_repeat('0',64);$denied=false;
    // Preserve the structural grant chain so this case specifically reaches
    // signature verification, rather than failing an earlier app-commit check.
    if($phase==='grant')$bad['proof']['appCommit']['planHash']=$bad['proof']['planHash'];
    try{ClawPilotNativeEmailAuthorityProof::verify($bad,$c,$f['config']['serviceUserId'],$f['config']['oauthClientId'],true);}
    catch(ClawPilotNativeEmailTransactionRefused $error){$denied=$error->holdCode==='authority_proof_signature';}
    if(!$denied)throw new RuntimeException('Cross-language forged proof must fail');$checks++;
}
$receipt=$f['grant']['revokeReceipt'];$receipt['replayed']=false;
if(ClawPilotNativeEmailAuthorityContract::digest($receipt)!==$f['grant']['envelope']['proof']['appCommit']['revokeReceiptHash'])
    throw new RuntimeException('Exact cross-language normalized revoke receipt digest required');$checks++;
if(array_key_exists('grantAttempts',$f)) {
    if(!is_array($f['grantAttempts']) || !array_is_list($f['grantAttempts']) || count($f['grantAttempts'])!==2)
        throw new RuntimeException('Exactly two bounded synthetic retry proofs required');
    $C=ClawPilotNativeEmailAuthorityContract::class;$original=$f['grant']['command'];$originalProof=$f['grant']['envelope']['proof'];$previous=$original;
    foreach($f['grantAttempts'] as $index=>$attempt) {
        $C::keys($attempt,['command','envelope']);$c=$attempt['command'];$e=$attempt['envelope'];$C::validate($c);
        $p=ClawPilotNativeEmailAuthorityProof::verify($e,$c,$f['config']['serviceUserId'],$f['config']['oauthClientId'],true);
        if($p!==$e['proof'] || $p['version']!==2)throw new RuntimeException('Exact TS/PHP retry signature and deterministic operation ID parity required');$checks++;
        $expectedCancellation=['version'=>$previous['version'],'operationId'=>$previous['operationId'],'transitionId'=>$previous['transitionId'],
            'phase'=>'grant','commandHash'=>$C::digest($previous),'state'=>'cancelled','replayed'=>false,'result'=>null];
        $expectedAttempt=['ordinal'=>$index+1,'originalOperationId'=>$original['operationId'],'originalCommandHash'=>$C::digest($original),
            'previousOperationId'=>$previous['operationId'],'previousCommandHash'=>$C::digest($previous),
            'previousCancellationReceiptHash'=>$C::digest($expectedCancellation)];
        if($C::canonical($p['grantAttempt'])!==$C::canonical($expectedAttempt)
            || $C::canonical($p['appCommit'])!==$C::canonical($originalProof['appCommit'])
            || $p['planHash']!==$originalProof['planHash'] || $p['revokeOperationId']!==$originalProof['revokeOperationId']
            || $p['revokeCommandHash']!==$originalProof['revokeCommandHash'])
            throw new RuntimeException('Retry parity must retain original app commit and exact immediate cancellation chain');$checks++;
        $bad=$e;$bad['signature']=($bad['signature'][0]==='A'?'B':'A').substr($bad['signature'],1);$denied=false;
        try{ClawPilotNativeEmailAuthorityProof::verify($bad,$c,$f['config']['serviceUserId'],$f['config']['oauthClientId'],true);}
        catch(ClawPilotNativeEmailTransactionRefused $error){$denied=$error->holdCode==='authority_proof_signature';}
        if(!$denied)throw new RuntimeException('Forged cross-language retry signature must fail');$checks++;
        $previous=$c;
    }
    // Shape/signature parity is not evidence that either synthetic cancellation
    // exists in native storage. Actual service fixtures prove that separately.
}
fwrite(STDOUT,'NATIVE_AUTHORITY_ISSUER_PASSED=checks='.$checks.'; actual TS RSA3072 signatures verified in PHP; no PG/native approval or live key provisioning proof.' ."\n");
