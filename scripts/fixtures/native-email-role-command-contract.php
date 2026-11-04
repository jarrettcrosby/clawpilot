<?php
declare(strict_types=1);
// Standalone wire validation only: no SuiteCRM bootstrap, DB or credentials.
require '/source/NativeEmailAuthorityContract.php';
$bytes=stream_get_contents(STDIN,3000001);
if(!is_string($bytes)||strlen($bytes)>3000000)throw new RuntimeException('Fixture exceeds bound');
$commands=json_decode($bytes,true,64,JSON_THROW_ON_ERROR);
if(!is_array($commands)||!array_is_list($commands)||count($commands)>100)throw new RuntimeException('Fixture shape');
$results=[];
foreach($commands as $command) {
    try {
        ClawPilotNativeEmailAuthorityContract::validate($command);
        $results[]=['accepted'=>true,'hash'=>ClawPilotNativeEmailAuthorityContract::digest($command)];
    }catch(Throwable $error){$results[]=['accepted'=>false];}
}
echo json_encode($results,JSON_THROW_ON_ERROR)."\n";
