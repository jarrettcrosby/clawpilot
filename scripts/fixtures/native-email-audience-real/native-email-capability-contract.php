<?php
declare(strict_types=1);
// Pure fixture: no SuiteCRM bootstrap, database, principal, or provider access.
require_once $argv[1]??dirname(__DIR__,3).'/services/suitecrm/email-audience/NativeEmailCapabilityContract.php';
$fixtureMode=isset($argv[2]);
if($fixtureMode) {
    if($argv[2]!=='--fixture=/fixture-capability-contract.json')throw new RuntimeException('Unexpected fixture path');
    $bundle=json_decode(file_get_contents('/fixture-capability-contract.json'),true,32,JSON_THROW_ON_ERROR);
    if(($bundle['version']??null)!==1 || !isset($bundle['vectors'],$bundle['expected'])
        || !is_array($bundle['vectors']) || !array_is_list($bundle['vectors']) || count($bundle['vectors'])>100
        || count($bundle['vectors'])!==count($bundle['expected']))throw new RuntimeException('Invalid capability parity fixture');
    $vectors=$bundle['vectors'];
} else $vectors=json_decode(stream_get_contents(STDIN),true,32,JSON_THROW_ON_ERROR);
$results=[];
foreach($vectors as $vector) {
    try {
        $prepared=ClawPilotNativeEmailCapabilityContract::prepare($vector['contract'],$vector['evidence']);
        if(isset($vector['expectedFingerprint']))ClawPilotNativeEmailCapabilityContract::verifyFingerprint(
            $vector['contract'],$vector['evidence'],$vector['expectedFingerprint'],$vector['fingerprintScope']??'bundle');
        if(isset($vector['selection']))ClawPilotNativeEmailCapabilityContract::verifyReadback(
            $vector['contract'],$vector['evidence'],$vector['selection'],$vector['readback']);
        $results[]=['ok'=>true,'fingerprint'=>$prepared['fingerprint'],'futurePolicyFingerprint'=>$prepared['futurePolicyFingerprint'],
            'historicalFingerprint'=>$prepared['historicalFingerprint']];
    } catch(Throwable $error) {$results[]=['ok'=>false];}
}
if($fixtureMode) {
    foreach($results as $index=>$result)if($result!==$bundle['expected'][$index])throw new RuntimeException('Capability parity mismatch at '.$index);
    echo 'NATIVE_EMAIL_CAPABILITY_CONTRACT_PASSED=checks='.count($results)."; exact TS/PHP parity vectors\n";
} else echo json_encode($results,JSON_THROW_ON_ERROR)."\n";
