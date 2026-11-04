<?php
declare(strict_types=1);
require '/source/NativeEmailAuthorityTransition.php';
require '/native-email-scope/Scope.php';
class User {public function __construct(public string $id){}}
$method=new ReflectionMethod(ClawPilotNativeEmailAuthorityTransition::class,'capabilityMatrixMatches');
$cases=json_decode(stream_get_contents(STDIN),true,32,JSON_THROW_ON_ERROR);
$result=[];
foreach($cases as $case)$result[]=$method->invoke(null,$case['actual'],$case['expected']);
$GLOBALS['current_user']=new User('first');
clawpilot_candidate_refresh_email_acl(true);clawpilot_candidate_refresh_email_acl();
clawpilot_candidate_refresh_email_acl(true);clawpilot_candidate_refresh_email_acl();
$GLOBALS['current_user']=new User('first');clawpilot_candidate_refresh_email_acl(true);
$GLOBALS['current_user']=new User('second');
clawpilot_candidate_refresh_email_acl();clawpilot_candidate_refresh_email_acl();
clawpilot_candidate_refresh_email_acl(true);
$GLOBALS['current_user']=new User('first');clawpilot_candidate_refresh_email_acl();
$inactive=ClawPilotNativeEmailWriteReadFrame::groupAccess(null,'Emails','fixture-email','first','view');
if($inactive!==null)throw new RuntimeException('An inactive frame cannot read or decide native access');
echo json_encode(['matrices'=>$result,'refreshCalls'=>ACLAction::$calls],JSON_THROW_ON_ERROR);
