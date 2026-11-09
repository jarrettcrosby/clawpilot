<?php
declare(strict_types=1);

// Only the isolated launcher with this exact disposable schema may run this.
require_once __DIR__.'/../services/suitecrm/email-audience/SharedBpoEmailNativeAbsence.php';
if (PHP_SAPI!=='cli' || ($argv[1] ?? null)!=='db' || ($argv[2] ?? null)!=='synthetic-only'
    || getenv('CLAWPILOT_SHARED_EMAIL_SYNTHETIC_ONLY')!=='1') throw new RuntimeException('Isolated test launcher required');

mysqli_report(MYSQLI_REPORT_ERROR|MYSQLI_REPORT_STRICT);
$dbName='suitecrm_absence_test';
$open=static fn(): mysqli=>new mysqli('db','fixture','Synthetic-native-db-password-only',$dbName);
$db=$open(); $race=$open();
$race->query('SET SESSION innodb_lock_wait_timeout=1');
$profile=['profile'=>'suitecrm-8.10.1-mariadb-11.4.13-v1','database'=>$dbName];
$candidate='abcdef01-aaaa-4bbb-8ccc-0123456789ab';
$other='11111111-aaaa-4bbb-8ccc-0123456789ab';
$gid='gi000abcdefabc';
$create=static function(string $name,string $cols) use($db): void {
    $db->query("CREATE TABLE `$name` ($cols) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci");
};
// Refuse a populated or reused database before the first fixture write.
$schema=$db->query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()')->fetch_assoc();
if ((int)$schema['n']!==0) throw new RuntimeException('Test database must be empty');
$pk='id CHAR(36) PRIMARY KEY';
foreach (ClawPilotNativeEmailTransaction::policyTables() as $table) {
    $cols=match($table){
        'config'=>'category VARCHAR(32), name VARCHAR(32), value VARCHAR(32), KEY idx_config_cat(category)',
        'securitygroups_records'=>"$pk, record_id CHAR(36)",
        default=>$pk
    };
    $create($table,$cols);
}
for($n=0;$n<100;$n++) $create('synthetic_filler_'.$n,$pk);
$create('emails',"$pk,parent_id CHAR(36),deleted TINYINT, KEY idx_email_parent_id(parent_id)");
$create('emails_text','email_id CHAR(36) PRIMARY KEY,description TEXT,deleted TINYINT');
$create('emails_cstm','id_c CHAR(36) PRIMARY KEY,global_id_c VARCHAR(255)');
$create('emails_beans',"$pk,email_id CHAR(36),bean_id CHAR(36),deleted TINYINT, KEY idx_emails_beans_email_bean(email_id,bean_id,deleted),KEY idx_emails_beans_bean_id(bean_id)");
$create('emails_email_addr_rel',"$pk,email_id CHAR(36),address_type VARCHAR(4),KEY idx_eearl_email_id(email_id,address_type)");
$create('email_addr_bean_rel',"$pk,bean_id CHAR(36),bean_module VARCHAR(100),KEY idx_bean_id(bean_id,bean_module)");
$create('notes',"$pk,parent_id CHAR(36),parent_type VARCHAR(255),KEY idx_notes_parent(parent_id,parent_type)");
$create('attachments_references','parent_id CHAR(36),source_record_id CHAR(36),KEY idx_attachments_ref_parent_id(parent_id),KEY idx_attachments_ref_source_record_id(source_record_id)');
$create('folders_rel',"$pk,polymorphic_id CHAR(36)");

$testCount=0;
$assert=static function(?string $reason,bool $templates=false,?callable $after=null,?string $native=null,bool $post=false) use($db,$profile,$candidate,$gid,&$testCount): void {
    $tx=ClawPilotNativeEmailTransaction::begin($db,$profile);
    try {
        try {
            if ($post) ClawPilotSharedBpoEmailNativeAbsence::assertNoExtraSidecars($db,$tx,$native ?? $candidate,$templates);
            else ClawPilotSharedBpoEmailNativeAbsence::assertAbsent($db,$tx,$native ?? $candidate,$gid,$templates);
            if ($reason!==null) throw new RuntimeException('Unexpected absence assertion success');
            if ($after!==null) $after($tx);
        } catch(ClawPilotNativeEmailTransactionRefused $e) {
            if ($e->holdCode!=='shared_bpo_email_absence_'.$reason) throw $e;
        }
        $testCount++;
    } finally { $tx->rollback(); }
};
$assert(null);
$assert('identity',false,null,strtoupper($candidate));
$assert('table_profile',true);
$uppercase=strtoupper($candidate);
$gidAlias=strtoupper($gid).' ';
$present=[
    ['emails', "(id,deleted) VALUES ('$uppercase',1)"],
    ['emails', "(id,parent_id,deleted) VALUES ('$other','$candidate',1)"],
    ['emails_text', "(email_id,description,deleted) VALUES ('$candidate','synthetic no-read content',1)"],
    ['emails_cstm', "(id_c,global_id_c) VALUES ('$other','$gidAlias')"],
    ['emails_cstm', "(id_c,global_id_c) VALUES ('$candidate',NULL)"],
    ['emails_beans', "(id,email_id,bean_id,deleted) VALUES ('$other','$candidate','$other',1)"],
    ['emails_beans', "(id,email_id,bean_id,deleted) VALUES ('$other','$other','$candidate',1)"],
    ['emails_email_addr_rel', "(id,email_id,address_type) VALUES ('$other','$candidate','TO')"],
    ['email_addr_bean_rel', "(id,bean_id,bean_module) VALUES ('$other','$candidate','Other')"],
    ['notes', "(id,parent_id,parent_type) VALUES ('$other','$candidate','Other')"],
    ['attachments_references', "(parent_id,source_record_id) VALUES ('$candidate','$other')"],
    ['attachments_references', "(parent_id,source_record_id) VALUES ('$other','$candidate')"],
    ['folders_rel', "(id,polymorphic_id) VALUES ('$other','$candidate')"],
    ['securitygroups_records', "(id,record_id) VALUES ('$other','$candidate')"],
];
foreach($present as [$table,$values]){
    $db->query("INSERT INTO $table $values");
    try { $assert('identity_or_sidecar_present'); }
    finally { $db->query("DELETE FROM $table"); } // Synthetic fixture only, isolated and owned by launcher.
}
$create('emails_email_templates',"$pk,emails_email_templates_ida VARCHAR(36),KEY emails_email_templates_ida1(emails_email_templates_ida)");
$assert('table_profile');
$assert(null,true);
$db->query("INSERT INTO emails_email_templates VALUES ('$other','$candidate')");
$assert('identity_or_sidecar_present',true);
$db->query('DELETE FROM emails_email_templates');

$locked=static function(string $sql) use($race): void {
    try { $race->query($sql); }
    catch(mysqli_sql_exception $e) { if ($e->getCode()===1205) return; throw $e; }
    throw new RuntimeException('Expected exact native write to wait on a locked range');
};
$assert(null,true,fn()=>$locked("INSERT INTO emails (id,deleted) VALUES ('$candidate',0)"));
$assert(null,true,fn()=>$locked("INSERT INTO emails_cstm VALUES ('$other','$gid')"));
$assert(null,true,fn()=>$locked("INSERT INTO emails_beans (id,email_id,bean_id,deleted) VALUES ('$other','$other','$candidate',1)"));
$db->query("INSERT INTO folders_rel VALUES ('$other',NULL)");
$assert(null,true,fn()=>$locked("UPDATE folders_rel SET polymorphic_id='$candidate' WHERE id='$other'"));

$db->query('ALTER TABLE notes ALTER INDEX idx_notes_parent IGNORED');
$assert('index_profile',true);
$db->query('ALTER TABLE notes ALTER INDEX idx_notes_parent NOT IGNORED');
$db->query('ALTER TABLE notes MODIFY parent_id CHAR(36) CHARACTER SET utf8mb3 COLLATE utf8mb3_bin');
$assert('identity_column_profile',true);
$db->query('ALTER TABLE notes MODIFY parent_id CHAR(36) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci');
$assert(null,true);
$db->query("INSERT INTO emails (id,deleted) VALUES ('$candidate',0)");
$db->query("INSERT INTO emails_text (email_id,description,deleted) VALUES ('$candidate','synthetic owned content',0)");
$db->query("INSERT INTO emails_cstm VALUES ('$candidate','$gid')");
$db->query("INSERT INTO emails_beans (id,email_id,bean_id,deleted) VALUES ('$other','$candidate','$other',0)");
$assert(null,true,null,null,true);
$db->query("INSERT INTO notes (id,parent_id,parent_type) VALUES ('$other','$candidate','Emails')");
$assert('identity_or_sidecar_present',true,null,null,true);
fwrite(STDOUT,"CLAWPILOT_SHARED_NATIVE_ABSENCE_CASES=$testCount\n");
