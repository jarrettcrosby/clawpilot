<?php
declare(strict_types=1);
require '/source/NativeEmailIdentityLink.php';
$input=json_decode((string)stream_get_contents(STDIN),true,64,JSON_THROW_ON_ERROR);
$result=['commands'=>[],'metadata'=>[]];
foreach($input['commands'] as $command){
    try{ClawPilotNativeEmailAuthorityContract::validate($command);$result['commands'][]=[
        'accepted'=>true,'hash'=>ClawPilotNativeEmailAuthorityContract::digest($command)];}
    catch(Throwable $error){$result['commands'][]=['accepted'=>false];}
}
foreach($input['metadata'] as $case){
    try{ClawPilotNativeEmailIdentityLink::validateRows($case['links'],$case['users'],$case['custom']);$result['metadata'][]=true;}
    catch(Throwable $error){$result['metadata'][]=false;}
}
fwrite(STDOUT,json_encode($result,JSON_THROW_ON_ERROR));
