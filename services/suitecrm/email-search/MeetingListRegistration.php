<?php
// ClawPilot managed email search presentation v1.
if (!defined('sugarEntry') || !sugarEntry) {
    die('Not A Valid Entry Point');
}
if (isset($beanList['Meetings']) && !in_array($beanList['Meetings'], ['Meeting', 'ClawPilotMeeting'], true)) {
    throw new RuntimeException('Unmanaged Meeting bean override requires review');
}
$beanList['Meetings'] = 'ClawPilotMeeting';
$beanFiles['ClawPilotMeeting'] = 'custom/include/ClawPilot/MeetingList.php';
