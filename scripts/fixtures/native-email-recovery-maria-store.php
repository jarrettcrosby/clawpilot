<?php
declare(strict_types=1);

// Isolated protocol/row guard fixture. Include production code without
// invoking its entrypoint or opening a connection, even to a local database.
if (PHP_SAPI!=='cli'||count($argv)!==2) throw new RuntimeException('Isolated Maria store fixture required');
require $argv[1];
$wire=stream_get_contents(STDIN,8193);
if (!is_string($wire)||strlen($wire)>8192) throw new RuntimeException('Bounded fixture input required');
$data=json_decode($wire,true,16,JSON_THROW_ON_ERROR);
$row=$data['observed'];$target=$data['target'];

function fixtureNeed(bool $condition): void
{if (!$condition) throw new RuntimeException('Maria store fixture assertion failed');}
function fixtureHeld(mixed $observed,array $target): void
{
    try {cp_recovery_cli_db_identity_row($observed,$target);}
    catch (RuntimeException $error) {fixtureNeed($error->getMessage()==='native_recovery_cli_native_database_identity');return;}
    throw new RuntimeException('Changed Maria store must hold');
}

fixtureNeed(cp_recovery_cli_maria_store_fingerprint($row)===$target['mariaStoreFingerprint']);
fixtureNeed(cp_recovery_cli_db_identity_row($row,$target)===1794000000);
fixtureNeed(cp_recovery_cli_maria_store_fingerprint(array_reverse($row,true))===$target['mariaStoreFingerprint']);
// A valid-looking wrong UID must hold even when name, account and every
// other SQL value is unchanged. The digest must not trust routing aliases.
$wrongStore=['database_name'=>'other_fixture','hostname'=>'other-maria','server_id'=>'513',
    'server_version'=>'11.4.14-MariaDB-ubu2404','server_uid'=>base64_encode(str_repeat('B',20))];
foreach ($wrongStore as $field=>$replacement) {
    $different=array_replace($row,[$field=>$replacement]);
    fixtureNeed(cp_recovery_cli_maria_store_fingerprint($different)!==$target['mariaStoreFingerprint']);
    fixtureHeld($different,$target);
    unset($different[$field]);fixtureHeld($different,$target);
}
foreach ([null,'','unknown',' '.$row['server_uid'],rtrim($row['server_uid'],'='),str_repeat('A',26).'B=',str_repeat('A',26).'-='] as $invalidUid) {
    fixtureHeld(array_replace($row,['server_uid'=>$invalidUid]),$target);
}
foreach ([['server_id'=>512],['server_id'=>'4294967296'],['principal'=>'other_recovery@%'],['epoch'=>'0000000000']] as $change) {
    fixtureHeld(array_replace($row,$change),$target);
}
foreach ([null,'bad',strtoupper($target['mariaStoreFingerprint']),str_repeat('0',64)] as $pin) {
    fixtureHeld($row,array_replace($target,['mariaStoreFingerprint'=>$pin]));
}
$missing=$target;unset($missing['mariaStoreFingerprint']);fixtureHeld($row,$missing);
fwrite(STDOUT,"PASS PHP native writer binds exact Maria identity and rejects missing or mismatched UID\n");
