<?php
// ClawPilot managed email search presentation v1.
if (!defined('sugarEntry') || !sugarEntry) {
    die('Not A Valid Entry Point');
}
if ((isset($beanList['Meetings']) && $beanList['Meetings'] !== 'Meeting')
    || (isset($customBeanList['Meetings']) && $customBeanList['Meetings'] !== 'ClawPilotMeeting')
    || (isset($customObjectList['Meetings']) && $customObjectList['Meetings'] !== 'Meeting')
    || isset($customBeanFiles['Meeting'])
    || (isset($customBeanFiles['ClawPilotMeeting']) && $customBeanFiles['ClawPilotMeeting'] !== 'custom/include/ClawPilot/MeetingList.php')) {
    throw new RuntimeException('Unmanaged Meeting bean override requires review');
}
// Keep native object/dictionary/API identities intact. SuiteCRM's supported
// custom-bean maps select the subclass without renaming the native Meeting.
$customBeanList['Meetings'] = 'ClawPilotMeeting';
$customObjectList['Meetings'] = 'Meeting';
$customBeanFiles['ClawPilotMeeting'] = 'custom/include/ClawPilot/MeetingList.php';
