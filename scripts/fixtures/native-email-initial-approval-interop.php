<?php
declare(strict_types=1);
// Actual TypeScript issuer → PHP signature/value parity only. Expected context
// here is explicitly synthetic fixture data, NOT trusted PG/native admission.
require_once __DIR__.'/../../services/suitecrm/email-audience/NativeEmailInitialEnrollment.php';
$bytes=stream_get_contents(STDIN,32769);if(!is_string($bytes)||strlen($bytes)>32768)throw new RuntimeException('Bounded interop fixture required');
$fixture=json_decode($bytes,true,32,JSON_THROW_ON_ERROR);
if(!is_array($fixture)||($fixture['syntheticOnly']??null)!==true||!is_string($fixture['publicKey']??null)
    ||!is_array($fixture['envelope']??null))throw new RuntimeException('Explicit synthetic issuer fixture required');
$authorization=$fixture['envelope'];$p=$authorization['proof'];
putenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_KEY_ID='.$p['keyId']);putenv('SUITECRM_NATIVE_AUTHORITY_INSTANCE_ID='.$p['nativeInstanceId']);
putenv('SUITECRM_NATIVE_AUTHORITY_ISSUER_PUBLIC_KEY='.$fixture['publicKey']);
$reflection=new ReflectionClass(ClawPilotNativeEmailInitialEnrollment::class);$service=$reflection->newInstanceWithoutConstructor();
foreach(['serviceUserId','oauthClientId'] as $name)$reflection->getProperty($name)->setValue($service,$p[$name]);
$plan=array_intersect_key($p,array_fill_keys(['nativeInstanceId','operationId','appGeneration','appSourceFingerprint'],true));
$forecast=array_intersect_key($p,array_fill_keys(['planHash','preparedAt','deltaFingerprint'],true));
$installation=array_intersect_key($p,array_fill_keys(['sourceRuntimeFingerprint','installedRuntimeFingerprint','installationJournalFingerprint'],true));
$verify=$reflection->getMethod('verifyApproval');$verify->invoke($service,$plan,$forecast,$authorization,$installation);
$authorization['proof']['purpose']='clawpilot-native-email-authority-approval';$held=false;
try{$verify->invoke($service,$plan,$forecast,$authorization,$installation);}catch(Throwable $error){$held=true;}
if(!$held)throw new RuntimeException('Ordinary authority domain must not authorize initial enrollment');
fwrite(STDOUT,"NATIVE_INITIAL_TS_PHP_APPROVAL_PASSED=1\nBOUNDARY: cryptographic interop only; source/context are synthetic, no SQL or native receipt\n");
