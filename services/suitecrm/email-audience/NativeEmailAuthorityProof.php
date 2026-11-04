<?php
declare(strict_types=1);
require_once __DIR__.'/NativeEmailAuthorityContract.php';

/** Fixed-algorithm, pinned-issuer verification. Only the app-side issuer which
 * has read a durable, authorized PG phase may sign this evidence. The native
 * OAuth principal, command hash, and an arbitrary appCommit hash cannot do so.
 * No key discovery, network call, caller-selected algorithm, or signing key. */
final class ClawPilotNativeEmailAuthorityProof
{
    public static function verify(array $authorization,array $command,string $userId,string $clientId,bool $allowExpired=false): array
    {
        $C=ClawPilotNativeEmailAuthorityContract::class;
        $C::keys($authorization,['proof','signature']);$p=$authorization['proof'];
        $keys=['version','purpose','issuer','audience','keyId','nativeInstanceId','issuedAt','expiresAt',
            'operationId','transitionId','planHash','commandHash','desiredAppChangeHash','phase','serviceUserId','oauthClientId',
            'revokeOperationId','revokeCommandHash','appCommit'];
        if(($p['version']??null)===2)$keys[]='grantAttempt';
        $C::keys($p,$keys);
        $C::need(in_array($p['version'],[1,2],true) && ($p['version']===1 || $p['phase']==='grant')
            && $p['purpose']==='clawpilot-native-email-authority-approval'
            && $p['issuer']==='clawpilot-pg-authority' && $p['audience']==='clawpilot-suitecrm-authority','authority_proof_domain');
        foreach(['keyId','nativeInstanceId'] as $key)$C::id($p[$key]);
        foreach(['operationId','transitionId','planHash','commandHash','desiredAppChangeHash'] as $key)$C::hash($p[$key]);
        foreach(['serviceUserId','oauthClientId'] as $key)$C::id($p[$key],36);
        $C::need($p['phase']===$command['phase'] && $p['operationId']===$command['operationId']
            && $p['transitionId']===$command['transitionId'] && $p['desiredAppChangeHash']===$command['desiredAppChangeHash']
            && $p['commandHash']===$C::digest($command) && $p['serviceUserId']===$userId && $p['oauthClientId']===$clientId,
            'authority_proof_identity');
        $now=time();
        $C::need(is_int($p['issuedAt']) && is_int($p['expiresAt']) && $p['issuedAt']>0 && $p['issuedAt']<=$now+30
            && $p['expiresAt']>$p['issuedAt'] && $p['expiresAt']-$p['issuedAt']<=300
            && ($allowExpired || $p['expiresAt']>$now),'authority_proof_expired');
        if($p['phase']==='revoke')$C::need($p['revokeOperationId']===null && $p['revokeCommandHash']===null && $p['appCommit']===null,'authority_proof_revoke');
        else {
            $C::hash($p['revokeOperationId']);$C::hash($p['revokeCommandHash']);$a=$p['appCommit'];
            $C::keys($a,['version','transitionId','planHash','desiredAppChangeHash','revokeReceiptHash','appAuthorityBeforeFingerprint','appAuthorityAfterFingerprint']);
            foreach(['transitionId','planHash','desiredAppChangeHash','revokeReceiptHash','appAuthorityBeforeFingerprint','appAuthorityAfterFingerprint'] as $key)$C::hash($a[$key]);
            $C::need($a['version']===1 && $a['transitionId']===$p['transitionId'] && $a['planHash']===$p['planHash']
                && $a['desiredAppChangeHash']===$p['desiredAppChangeHash'] && $p['revokeOperationId']!==$p['operationId'],'authority_proof_app_commit');
        }
        if($p['version']===2) {
            $attempt=$p['grantAttempt'];
            $C::keys($attempt,['ordinal','originalOperationId','originalCommandHash','previousOperationId',
                'previousCommandHash','previousCancellationReceiptHash']);
            $C::need(is_int($attempt['ordinal']) && $attempt['ordinal']>0 && $attempt['ordinal']<=9007199254740991,
                'authority_grant_attempt_ordinal');
            foreach(['originalOperationId','originalCommandHash','previousOperationId','previousCommandHash','previousCancellationReceiptHash'] as $key)
                $C::hash($attempt[$key]);
            $C::need($attempt['originalOperationId']!==$p['operationId'] && $attempt['previousOperationId']!==$p['operationId']
                && $attempt['originalOperationId']!==$p['revokeOperationId'] && $attempt['previousOperationId']!==$p['revokeOperationId']
                && ($attempt['ordinal']===1 ? $attempt['previousOperationId']===$attempt['originalOperationId']
                    && $attempt['previousCommandHash']===$attempt['originalCommandHash'] : $attempt['previousOperationId']!==$attempt['originalOperationId']),
                'authority_grant_attempt_identity');
            // The immutable original command is never rewritten. Every retry
            // is byte-identical apart from its new operation ID, including
            // timestamps, all membership preimages and every capability pin.
            $original=$command;$original['operationId']=$attempt['originalOperationId'];
            $previous=$command;$previous['operationId']=$attempt['previousOperationId'];
            $C::need($C::digest($original)===$attempt['originalCommandHash']
                && $C::digest($previous)===$attempt['previousCommandHash'],'authority_grant_attempt_command_changed');
            $expected=$C::digest(['version'=>1,'purpose'=>'clawpilot-native-email-grant-attempt',
                'transitionId'=>$p['transitionId'],'planHash'=>$p['planHash'],
                'originalOperationId'=>$attempt['originalOperationId'],'originalCommandHash'=>$attempt['originalCommandHash'],
                'ordinal'=>$attempt['ordinal'],'previousOperationId'=>$attempt['previousOperationId'],
                'previousCommandHash'=>$attempt['previousCommandHash'],
                'previousCancellationReceiptHash'=>$attempt['previousCancellationReceiptHash'],
                'appCommitFingerprint'=>$C::digest($p['appCommit'])]);
            $C::need($p['operationId']===$expected,'authority_grant_attempt_operation_id');
        }
        $keyId=(string)getenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID');
        $instance=(string)getenv('SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID');
        $pem=(string)getenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY');
        $C::need($keyId!=='' && $instance!=='' && $p['keyId']===$keyId && $p['nativeInstanceId']===$instance
            && strlen($pem)>=100 && strlen($pem)<=8192 && str_starts_with($pem,'-----BEGIN PUBLIC KEY-----'),
            'authority_proof_issuer_unconfigured');
        $key=openssl_pkey_get_public($pem);$details=$key===false?false:openssl_pkey_get_details($key);
        $C::need(is_array($details) && $details['type']===OPENSSL_KEYTYPE_RSA && $details['bits']===3072,
            'authority_proof_key_profile');
        $signature=$authorization['signature'];
        $C::need(is_string($signature) && strlen($signature)===512,'authority_proof_signature');
        $raw=base64_decode($signature,true);
        $C::need(is_string($raw) && strlen($raw)===384 && base64_encode($raw)===$signature,'authority_proof_signature');
        $bytes=$C::canonical($p);
        $C::need(strlen($bytes)<=8192 && preg_match('/^[\x20-\x7e]+$/D',$bytes)===1
            && openssl_verify($bytes,$raw,$key,OPENSSL_ALGO_SHA256)===1,'authority_proof_signature');
        return $p;
    }
}
