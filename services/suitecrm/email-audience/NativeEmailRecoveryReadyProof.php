<?php
declare(strict_types=1);

/** Only call after verifying the exact root-protected fence, runtime identity
 * and image pins, and holding the existing native CLI lock. All identifiers
 * in the frame are digests or non-secret challenge and lease metadata. */
function cp_recovery_cli_ready_line(string $action, int $expiresAt, string $fenceEpoch, string $nonce,
    string $targetFingerprint, string $secretBase64, int $now): string
{
    $key=base64_decode($secretBase64,true);
    if(!in_array($action,['prepare','publish','resolve'],true)||$now<1||$expiresAt<=$now||$expiresAt>9007199254740991
        ||preg_match('/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/D',$fenceEpoch)!==1
        ||preg_match('/^[a-f0-9]{64}$/D',$nonce)!==1||preg_match('/^[a-f0-9]{64}$/D',$targetFingerprint)!==1
        ||!is_string($key)||strlen($key)!==32||base64_encode($key)!==$secretBase64)
        throw new RuntimeException('native_recovery_cli_ready_context');
    $proof=['action'=>$action,'expiresAt'=>$expiresAt,'fenceEpoch'=>$fenceEpoch,'nonce'=>$nonce,
        'purpose'=>'clawpilot-native-email-recovery-ready-v1','targetFingerprint'=>$targetFingerprint,'version'=>1];
    $mac=hash_hmac('sha256',json_encode($proof,JSON_THROW_ON_ERROR),$key);
    return json_encode(['mac'=>$mac,'proof'=>$proof],JSON_THROW_ON_ERROR)."\n";
}
