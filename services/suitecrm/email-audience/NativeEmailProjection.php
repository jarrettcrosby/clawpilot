<?php
declare(strict_types=1);
require_once __DIR__.'/NativeEmailTransaction.php';
require_once __DIR__.'/NativeEmailRuntime.php';

final class ClawPilotNativeEmailProjectionRefused extends RuntimeException
{
    public function __construct(public readonly string $holdCode, public readonly ?string $diagnostic = null) { parent::__construct('Native Email projection refused: '.$holdCode); }
}

/** No commit, mail delivery, permission writes, Contact save, or historical repair.
 * The coordinator owns authoritative mapping, audience, operation receipts and
 * commit. Existing updates require an exact locked pre-image fingerprint.
 */
final class ClawPilotNativeEmailProjection
{
    private const HEADERS = ['from_addr_name'=>'from_addr','to_addrs_names'=>'to_addrs',
        'cc_addrs_names'=>'cc_addrs','bcc_addrs_names'=>'bcc_addrs','reply_to_addrs_names'=>'reply_to_addr'];
    private const REQUIRED = ['global_id_c','name','date_sent_received','type','status','parent_type','parent_id',
        'assigned_user_id','description','description_html'];
    private const UPDATE_FIELDS = ['name','date_sent_received','type','status','parent_type','parent_id','date_modified','modified_user_id'];
    private const INDEXES = [
        'emails'=>['PRIMARY',['id']], 'emails_text'=>['PRIMARY',['email_id']], 'emails_cstm'=>['PRIMARY',['id_c']],
        'emails_beans'=>['idx_emails_beans_email_bean',['email_id','bean_id','deleted']],
        'emails_email_addr_rel'=>['idx_eearl_email_id',['email_id','address_type']],
        'accounts'=>['PRIMARY',['id']], 'contacts'=>['PRIMARY',['id']],
        'accounts_contacts'=>['idx_contid_del_accid',['contact_id','deleted','account_id']],
    ];

    public static function validate(array $command): array
    {
        self::keys($command, ['suiteCrmId','attributes','accounts','contacts','contactAccounts','previousManaged','expectedBeforeFingerprint']);
        self::id($command['suiteCrmId']);
        self::need(is_array($command['attributes']) && !array_is_list($command['attributes']), 'attributes_shape');
        $attributes = $command['attributes'];
        foreach (self::REQUIRED as $key) self::need(array_key_exists($key,$attributes), 'attribute_missing');
        foreach ($attributes as $key=>$value) {
            self::need(in_array($key,array_merge(self::REQUIRED,array_keys(self::HEADERS)),true), 'unsupported_attribute');
            self::text($value, $key === 'description' ? 100000 : ($key === 'name' ? 255 : 8000));
        }
        self::need(preg_match('/^gi(?:[0-9]{7}|[0-9a-v]{12})$/D',$attributes['global_id_c']) === 1, 'global_id_shape');
        self::need($attributes['type'] === 'archived' && in_array($attributes['status'],['read','sent'],true)
            && $attributes['description_html'] === '', 'unsupported_email_state');
        self::need($attributes['name'] === trim($attributes['name']) && !str_contains($attributes['name'],"\n") && !str_contains($attributes['name'],"\r"), 'unsupported_subject');
        self::id($attributes['assigned_user_id']); self::utc($attributes['date_sent_received']);
        $accounts=self::ids($command['accounts']); $contacts=self::ids($command['contacts']);
        self::need(is_array($command['previousManaged']), 'previous_managed_shape'); self::keys($command['previousManaged'],['accounts','contacts']);
        $previous=['accounts'=>self::ids($command['previousManaged']['accounts']),'contacts'=>self::ids($command['previousManaged']['contacts'])];
        self::need(($attributes['parent_type'] === '' && $attributes['parent_id'] === '')
            || ($attributes['parent_type'] === 'Accounts' && in_array($attributes['parent_id'],$accounts,true)), 'unsupported_parent');
        self::need(is_array($command['contactAccounts']) && array_is_list($command['contactAccounts']) && count($command['contactAccounts']) === count($contacts), 'contact_bindings_shape');
        $bindings=[];
        foreach ($command['contactAccounts'] as $binding) {
            self::need(is_array($binding),'contact_bindings_shape'); self::keys($binding,['contactId','accountId']);
            self::id($binding['contactId']); self::id($binding['accountId']);
            self::need(in_array($binding['accountId'],$accounts,true),'contact_account_outside_projection'); $bindings[]=$binding;
        }
        usort($bindings,static fn($a,$b)=>strcmp($a['contactId'],$b['contactId']));
        self::need(array_column($bindings,'contactId') === $contacts,'contact_bindings_shape');
        $fingerprint=$command['expectedBeforeFingerprint'];
        self::need($fingerprint === null || (is_string($fingerprint) && preg_match('/^[a-f0-9]{64}$/D',$fingerprint) === 1),'preimage_shape');
        return ['suiteCrmId'=>$command['suiteCrmId'],'attributes'=>$attributes,'accounts'=>$accounts,'contacts'=>$contacts,
            'contactAccounts'=>$bindings,'previousManaged'=>$previous,'expectedBeforeFingerprint'=>$fingerprint];
    }

    /** Internal locked raw snapshot. Never log or return raw rows over a route. */
    public static function snapshot(mysqli $db, ClawPilotNativeEmailTransaction $transaction, string $emailId): array
    {
        self::connection($db,$transaction); self::id($emailId); self::schema($db);
        // global_id_c has no pinned unique index. Lock its entire bounded
        // PRIMARY range, including insertion gaps, instead of pretending that a
        // label lookup alone prevents duplicate native identities.
        $globalIndex=self::rows($db,'SELECT id_c,global_id_c FROM emails_cstm FORCE INDEX (PRIMARY) ORDER BY id_c FOR UPDATE',[],5000);
        $raw=[
            'emails'=>self::rows($db,'SELECT * FROM emails FORCE INDEX (PRIMARY) WHERE id=? FOR UPDATE',[$emailId],1),
            'emails_text'=>self::rows($db,'SELECT * FROM emails_text FORCE INDEX (PRIMARY) WHERE email_id=? FOR UPDATE',[$emailId],1),
            'emails_cstm'=>self::rows($db,'SELECT * FROM emails_cstm FORCE INDEX (PRIMARY) WHERE id_c=? FOR UPDATE',[$emailId],1),
            'emails_beans'=>self::rows($db,'SELECT * FROM emails_beans FORCE INDEX (idx_emails_beans_email_bean) WHERE email_id=? ORDER BY bean_id,deleted,id FOR UPDATE',[$emailId],200),
            'emails_email_addr_rel'=>self::rows($db,'SELECT * FROM emails_email_addr_rel FORCE INDEX (idx_eearl_email_id) WHERE email_id=? ORDER BY address_type,id FOR UPDATE',[$emailId],200),
        ];
        $contactIds=[];
        foreach ($raw['emails_beans'] as $row) if ($row['bean_module'] === 'Contacts') $contactIds[]=$row['bean_id'];
        $contactIds=array_values(array_unique($contactIds)); sort($contactIds,SORT_STRING);
        $raw['contactAccounts']=self::contactRows($db,$contactIds);
        self::connection($db,$transaction);
        return ['suiteCrmId'=>$emailId,'exists'=>$raw['emails'] !== [],'fingerprint'=>self::digest($raw),'raw'=>$raw,'globalIndex'=>$globalIndex];
    }

    /** Requires the current transaction's locked snapshot of this exact ID. */
    public static function assertCreatePreimage(mysqli $db, ClawPilotNativeEmailTransaction $transaction, array $before,
        string $id, string $globalId, mixed $previousManaged): void
    {
        self::connection($db,$transaction);
        self::need($before['suiteCrmId'] === $id && !$before['exists'] && is_array($previousManaged)
            && count($previousManaged) === 2 && ($previousManaged['accounts'] ?? null) === []
            && ($previousManaged['contacts'] ?? null) === [], 'create_requires_absent_identity');
        foreach (['emails_text','emails_cstm','emails_beans','emails_email_addr_rel'] as $table) self::need($before['raw'][$table] === [], 'orphaned_native_identity');
        // Use native collation so case and trailing-space collisions also hold.
        self::need(self::rows($db,'SELECT id_c FROM emails_cstm FORCE INDEX (PRIMARY) WHERE global_id_c=? ORDER BY id_c FOR UPDATE',[$globalId],2) === [], 'duplicate_or_changed_global_id');
    }

    public static function upsert(mysqli $db, ClawPilotNativeEmailTransaction $transaction, array $command): array
    {
        return self::upsertInternal($db,$transaction,$command,false);
    }

    /** Recovery creates only. One transaction owns absence, Email, links and
     * the receipt. No role, group, ACL, account or contact is edited. This is
     * not registered on a public route; only a private caller may verify a
     * permit using independently observed origin/release and login pins. */
    public static function createShared(mysqli $db, array $databaseProfile, array $command,
        ClawPilotSharedBpoEmailCreatePermit $permit, array $trustedScope, bool $expectEmailTemplates): array
    {
        require_once __DIR__.'/SharedBpoEmailReceipt.php';
        require_once __DIR__.'/SharedBpoEmailNativeAbsence.php';
        $transaction=ClawPilotNativeEmailTransaction::begin($db,$databaseProfile);
        try {
            $command=self::validate($command);
            $policyState=self::sharedLoginPolicyState($db,$transaction);
            self::need(hash_equals($policyState,(string)($trustedScope['policyStateFingerprint']??'')), 'shared_login_policy_changed');
            $permit->assertCurrent($trustedScope,$command,self::sharedClock($db));
            $receipt=ClawPilotSharedBpoEmailReceipt::lock($db,$transaction,$permit);
            if($receipt!==null){
                $before=self::snapshot($db,$transaction,$command['suiteCrmId']);
                $id=$command['suiteCrmId'];$globalId=$command['attributes']['global_id_c'];
                self::need($before['exists']&&hash_equals($receipt['snapshot_fingerprint'],$before['fingerprint'])
                    && self::rows($db,'SELECT id_c,global_id_c FROM emails_cstm FORCE INDEX (PRIMARY) WHERE global_id_c=? ORDER BY id_c FOR UPDATE',
                        [$globalId],2)===[['id_c'=>$id,'global_id_c'=>$globalId]], 'shared_receipt_projection_changed');
                ClawPilotSharedBpoEmailNativeAbsence::assertNoExtraSidecars($db,$transaction,$id,$expectEmailTemplates);
                $transaction->rollback();
                return $receipt;
            }
            ClawPilotSharedBpoEmailNativeAbsence::assertAbsent($db,$transaction,$command['suiteCrmId'],
                $command['attributes']['global_id_c'],$expectEmailTemplates);
            $permit->assertCurrent($trustedScope,$command,self::sharedClock($db));
            $result=self::upsertInternal($db,$transaction,$command,true);
            ClawPilotSharedBpoEmailNativeAbsence::assertNoExtraSidecars($db,$transaction,$command['suiteCrmId'],$expectEmailTemplates);
            $receipt=ClawPilotSharedBpoEmailReceipt::record($db,$transaction,$permit,$result['snapshotFingerprint']);
            $permit->assertCurrent($trustedScope,$command,self::sharedClock($db));
            $transaction->commit();
            return $receipt;
        } catch(Throwable $error){
            try{$transaction->rollback();}catch(Throwable $ignored){}
            throw $error;
        }
    }

    /** Native policy lock is for observing drift, not for granting access. */
    public static function sharedLoginPolicyState(mysqli $db, ClawPilotNativeEmailTransaction $transaction): string
    {
        self::connection($db,$transaction);
        return self::digest(['clawpilot-shared-login-source-v1',$transaction->policyFingerprint(),
            ClawPilotNativeEmailRuntime::attestSharedLoginSource($db)]);
    }

    /** Independent native observation for settlement. An exact existing copy
     * can be reused without a create receipt. Unknown/different copies hold;
     * no account, email, link, permission or receipt is written. */
    public static function observeSharedExact(mysqli $db, array $databaseProfile, array $command,
        string $expectedPolicyState, bool $expectEmailTemplates, ?string $nativeOriginFingerprint=null): array
    {
        require_once __DIR__.'/SharedBpoEmailNativeAbsence.php';
        $command=self::validate($command);
        self::need($command['expectedBeforeFingerprint']===null&&$command['previousManaged']===['accounts'=>[],'contacts'=>[]],
            'shared_recovery_projection');
        $transaction=ClawPilotNativeEmailTransaction::begin($db,$databaseProfile);
        try {
            $state=self::sharedLoginPolicyState($db,$transaction);
            self::need(hash_equals($state,$expectedPolicyState),'shared_login_policy_changed');
            $id=$command['suiteCrmId'];$expected=$command['attributes'];$globalId=$expected['global_id_c'];
            $snapshot=self::snapshot($db,$transaction,$id);$raw=$snapshot['raw'];
            self::need($snapshot['exists']&&self::rows($db,'SELECT id_c,global_id_c FROM emails_cstm FORCE INDEX (PRIMARY)
                WHERE global_id_c=? ORDER BY id_c FOR UPDATE',[$globalId],2)===[['id_c'=>$id,'global_id_c'=>$globalId]],
                'shared_existing_identity');
            $actual=self::attributes($snapshot);
            self::need($actual['deleted']==='0'&&(string)$raw['emails_text'][0]['deleted']==='0'
                && (string)($raw['emails_text'][0]['raw_source']??'')===''&&$raw['emails_email_addr_rel']===[], 'shared_existing_sidecar');
            $bean=BeanFactory::newBean('Emails');
            self::need($bean instanceof Email&&get_class($bean)==='Email','unknown_email_bean');
            $expected['date_sent_received']=self::utc($expected['date_sent_received']);
            $expected['description_html']=self::derivedHtml($expected['description']);
            foreach(self::HEADERS as $field=>$_)$expected[$field]=self::header($bean,$expected[$field]??'',$field);
            self::need($expected['from_addr_name']!=='','from_header_unavailable');
            foreach($expected as $field=>$value)self::need(($actual[$field]??null)===$value,'shared_existing_content_changed');
            $links=self::links($raw['emails_beans']);
            self::need($links===['accounts'=>$command['accounts'],'contacts'=>$command['contacts']]
                && count($raw['emails_beans'])===count($links['accounts'])+count($links['contacts']), 'shared_existing_links_changed');
            self::lockRelated($db,$command,$links);
            ClawPilotSharedBpoEmailNativeAbsence::assertNoExtraSidecars($db,$transaction,$id,$expectEmailTemplates);
            self::need(hash_equals($state,self::sharedLoginPolicyState($db,$transaction)),'shared_login_policy_changed');
            $observedAt=self::rows($db,"SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ') AS observed_at",[],1)[0]['observed_at']??'';
            self::need(is_string($observedAt)&&preg_match('/\A\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}000Z\z/',$observedAt)===1,'shared_database_clock');
            $proof=['nativeId'=>$id,'globalId'=>$globalId,'snapshotFingerprint'=>$snapshot['fingerprint'],
                'observedAt'=>substr($observedAt,0,-4).'Z'];
            if($nativeOriginFingerprint!==null){
                require_once __DIR__.'/SharedBpoEmailReceipt.php';
                $projectionFingerprint=ClawPilotNativeEmailAuthorityContract::digest($command);
                $receipt=ClawPilotSharedBpoEmailReceipt::observe($db,$transaction,$nativeOriginFingerprint,$id,$globalId,
                    $projectionFingerprint,$snapshot['fingerprint']);
                $proof['projectionFingerprint']=$projectionFingerprint;
                $proof['kind']=$receipt===null?'exact-existing':'created';
                $proof['receiptFingerprint']=ClawPilotNativeEmailAuthorityContract::digest($receipt??[
                    'clawpilot-shared-bpo-exact-existing-v1',$nativeOriginFingerprint,$id,$globalId,$projectionFingerprint,$snapshot['fingerprint']]);
            }
            $transaction->rollback();
            return $proof;
        }catch(Throwable $error){
            try{$transaction->rollback();}catch(Throwable $ignored){}
            throw $error;
        }
    }

    private static function sharedClock(mysqli $db): int
    {
        $value=self::rows($db,'SELECT UNIX_TIMESTAMP() AS epoch',[],1)[0]['epoch']??null;
        self::need(is_int($value)||(is_string($value)&&ctype_digit($value)), 'shared_database_clock');
        return (int)$value;
    }

    private static function upsertInternal(mysqli $db, ClawPilotNativeEmailTransaction $transaction, array $command, bool $sharedLogin): array
    {
        try {
            $command=self::validate($command); self::connection($db,$transaction);
            if($sharedLogin)self::need($command['expectedBeforeFingerprint']===null,'shared_create_only');
            $runtime=$sharedLogin?ClawPilotNativeEmailRuntime::attestSharedLoginSource($db):ClawPilotNativeEmailRuntime::attest($db);
            $before=self::snapshot($db,$transaction,$command['suiteCrmId']); $id=$command['suiteCrmId']; $attributes=$command['attributes'];
            $writer=$GLOBALS['current_user'] ?? null;
            self::need($writer instanceof User && $writer->isAdmin() && is_string($writer->id) && $writer->id !== '', 'native_writer_unproven');
            self::need($_REQUEST === [] && empty($GLOBALS['sugar_config']['email_enable_auto_send_opt_in']), 'unsafe_save_context');
            if ($command['expectedBeforeFingerprint'] === null) {
                self::assertCreatePreimage($db,$transaction,$before,$id,$attributes['global_id_c'],$command['previousManaged']);
            } else {
                self::need($before['exists'] && hash_equals($command['expectedBeforeFingerprint'],$before['fingerprint']), 'existing_preimage_changed');
                $old=$before['raw']['emails'][0];
                self::need((int)$old['deleted'] === 0 && $old['type'] === 'archived'
                    && $old['assigned_user_id'] === $attributes['assigned_user_id'] && $old['created_by'] === $writer->id
                    && count($before['raw']['emails_text']) === 1 && (int)$before['raw']['emails_text'][0]['deleted'] === 0
                    && count($before['raw']['emails_cstm']) === 1, 'existing_lifecycle_or_ownership_changed');
                self::need((string)($before['raw']['emails_text'][0]['raw_source'] ?? '') === '', 'unsupported_existing_raw_source');
                $globalMatches=self::rows($db,'SELECT id_c,global_id_c FROM emails_cstm FORCE INDEX (PRIMARY) WHERE global_id_c=? ORDER BY id_c FOR UPDATE',[$attributes['global_id_c']],2);
                self::need(array_column($globalMatches,'id_c') === [$id]
                    && $before['raw']['emails_cstm'][0]['global_id_c'] === $attributes['global_id_c'],'duplicate_or_changed_global_id');
            }
            // Existing app projections write native *_names fields, not bare
            // address links. Unknown normalized address relationships hold;
            // never erase them or lose display names through retrieveEmailAddresses.
            self::need($before['raw']['emails_email_addr_rel'] === [], 'unsupported_native_address_relations');
            $current=self::links($before['raw']['emails_beans']);
            foreach (['accounts','contacts'] as $link) foreach ($current[$link] as $relatedId) {
                self::need(in_array($relatedId,$command[$link],true) || in_array($relatedId,$command['previousManaged'][$link],true), 'unmanaged_relationship');
            }
            $related=self::lockRelated($db,$command,$current);
            $email=BeanFactory::newBean('Emails');
            self::need($email instanceof Email && get_class($email) === 'Email'
                && realpath((new ReflectionClass($email))->getFileName()) === realpath('modules/Emails/Email.php'), 'unknown_email_bean');
            if ($before['exists']) self::need((bool)$email->retrieve($id,false) && $email->id === $id, 'native_retrieve_failed');
            else { $email->id=$id; $email->new_with_id=true; }
            $expected=$attributes; $expected['date_sent_received']=self::utc($attributes['date_sent_received']);
            foreach (self::HEADERS as $field=>$column) {
                $value=$attributes[$field] ?? ($before['raw']['emails_text'][0][$column] ?? '');
                $expected[$field]=self::header($email,$value,$field);
                $email->{$field === 'reply_to_addrs_names' ? 'reply_to_addr' : $field}=$expected[$field];
            }
            self::need($expected['from_addr_name'] !== '', 'from_header_unavailable');
            foreach (self::REQUIRED as $field) $email->{$field}=$expected[$field];
            // Save only names/text, matching the supported native API profile.
            // Native opt-in/address creation is not used as a side effect.
            foreach (['from_addr','to_addrs','cc_addrs','bcc_addrs'] as $field) $email->{$field}='';
            $email->raw_source='';
            $plain=$attributes['description'];
            $expectedHtml=self::derivedHtml($plain);
            self::connection($db,$transaction);
            // Stock retrieve/save normalizes untouched NULL booleans and ID
            // columns. Its own DBManager update whitelist preserves those raw
            // historical values; Email.save still handles text and native hooks.
            // Existing custom identity is deliberately not rewritten either.
            $priorFields=$email->bean_fields_to_save;
            self::need(empty($priorFields),'unexpected_native_field_filter');
            if($before['exists'])$email->bean_fields_to_save=self::UPDATE_FIELDS;
            try { self::need($email->save(false) === $id, 'native_save_failed'); }
            finally { $email->bean_fields_to_save=$priorFields; }
            self::connection($db,$transaction);
            // Stock save decodes entities in description. Restore ONLY the
            // plain-text column, never HTML, using checked bound parameters.
            self::execute($db,'UPDATE emails_text SET description=? WHERE email_id=? AND deleted=0',[$plain,$id]);
            $expected['description_html']=$expectedHtml;
            foreach (['accounts'=>'Accounts','contacts'=>'Contacts'] as $link=>$module) {
                self::need($email->load_relationship($link), 'native_relationship_unavailable');
                foreach (array_diff($current[$link],$command[$link]) as $relatedId) $email->{$link}->delete($id,$relatedId);
                foreach (array_diff($command[$link],$current[$link]) as $relatedId) $email->{$link}->add($relatedId);
                self::connection($db,$transaction);
            }
            $after=self::snapshot($db,$transaction,$id);
            $actual=self::attributes($after);
            foreach ($expected as $field=>$value) self::need(($actual[$field] ?? null) === $value, 'native_attribute_readback_mismatch');
            self::need($actual['created_by'] === ($before['exists'] ? $before['raw']['emails'][0]['created_by'] : $writer->id)
                && $actual['deleted'] === '0', 'native_ownership_readback_mismatch');
            if ($before['exists']) self::need($after['raw']['emails'][0]['date_entered'] === $before['raw']['emails'][0]['date_entered'], 'native_creation_date_changed');
            if ($before['exists']) {
                $changed=[];
                foreach ($before['raw']['emails'][0] as $field=>$value) if (!in_array($field,self::UPDATE_FIELDS,true)
                    && ($after['raw']['emails'][0][$field] ?? null) !== $value) {
                    // Internal column/type metadata only; no stored values.
                    $changed[]=$field.':'.gettype($value).'->'.gettype($after['raw']['emails'][0][$field] ?? null);
                }
                if($changed)throw new ClawPilotNativeEmailProjectionRefused('unmanaged_email_column_changed',implode(',',$changed));
                self::need($after['raw']['emails_cstm'] === $before['raw']['emails_cstm'],'unmanaged_custom_column_changed');
            }
            self::need($after['raw']['emails_email_addr_rel'] === [], 'native_address_side_effect');
            $links=self::links($after['raw']['emails_beans']);
            self::need($links === ['accounts'=>$command['accounts'],'contacts'=>$command['contacts']], 'native_relationship_readback_mismatch');
            self::need(self::lockRelated($db,$command,$current) === $related, 'contact_or_account_changed');
            self::need(hash_equals($runtime,$sharedLogin?ClawPilotNativeEmailRuntime::attestSharedLoginSource($db):ClawPilotNativeEmailRuntime::attest($db)), 'runtime_changed_during_save');
            self::connection($db,$transaction);
            // Source attributes are attached ONLY after raw database proof.
            return ['version'=>2,'suiteCrmId'=>$id,'attributes'=>$actual,'sourceAttributes'=>$attributes,
                'accounts'=>$links['accounts'],'contacts'=>$links['contacts'],'contactAccounts'=>$command['contactAccounts'],
                'snapshotFingerprint'=>$after['fingerprint'],'dateSentReceivedUtc'=>str_replace(' ','T',$actual['date_sent_received']).'Z'];
        } catch (Throwable $error) {
            try { $transaction->rollback(); } catch (Throwable $ignored) {}
            if ($error instanceof ClawPilotNativeEmailProjectionRefused || $error instanceof ClawPilotNativeEmailTransactionRefused) throw $error;
            throw new ClawPilotNativeEmailProjectionRefused('native_projection_operation_failed');
        }
    }

    private static function attributes(array $snapshot): array
    {
        $raw=$snapshot['raw']; self::need(count($raw['emails']) === 1 && count($raw['emails_text']) === 1 && count($raw['emails_cstm']) === 1,'native_readback_missing');
        $email=$raw['emails'][0]; $text=$raw['emails_text'][0]; $result=[];
        foreach (['name','date_sent_received','type','status','parent_type','parent_id','assigned_user_id','created_by','deleted'] as $field) $result[$field]=(string)($email[$field] ?? '');
        $result['global_id_c']=(string)$raw['emails_cstm'][0]['global_id_c'];
        foreach (['description','description_html'] as $field) $result[$field]=(string)($text[$field] ?? '');
        foreach (self::HEADERS as $field=>$column) $result[$field]=(string)($text[$column] ?? '');
        return $result;
    }
    private static function derivedHtml(string $plain): string
    {
        $expected=from_html(SugarCleaner::cleanHtml(nl2br(SugarCleaner::cleanHtml($plain)),true));
        self::need(is_string($expected)&&from_html(SugarCleaner::cleanHtml($expected,true))===$expected,'unstable_native_html_normalization');
        self::need($plain===''||$expected!=='','empty_derived_html');
        return $expected;
    }
    private static function header(Email $email, string $value, string $field): string
    {
        self::text($value,in_array($field,['from_addr_name','reply_to_addrs_names'],true) ? 255 : 8000);
        self::need(!preg_match('/[\r\n\t]/',$value),'unsupported_header');
        if ($value === '') return '';
        // The admitted native form deliberately excludes quoted commas,
        // semicolons and apostrophes: stock cleanEmails drops those names.
        $parts=explode(',',$value); self::need(count($parts) <= 50
            && (!in_array($field,['from_addr_name','reply_to_addrs_names'],true) || count($parts) === 1),'unsupported_header');
        $canonical=[]; $addresses=[];
        foreach ($parts as $part) {
            $part=trim($part); $name=''; $address=$part;
            if (preg_match('/^([^<>]*)<([^<>]+)>$/uD',$part,$match)) {
                $name=trim($match[1]); $address=trim($match[2]);
                if (str_starts_with($name,'"') && str_ends_with($name,'"')) $name=substr($name,1,-1);
                self::need($name !== '' && !preg_match('/[<>;,\'"\\\\]/u',$name),'unsupported_header_display_name');
            }
            self::need(strlen($address) <= 254 && preg_match('/^[A-Z0-9.!#$%&\'*+\/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/iD',$address) === 1,'unsupported_header_address');
            $address=strtolower($address); self::need(!in_array($address,$addresses,true),'duplicate_header_address'); $addresses[]=$address;
            $canonical[]=$name === '' ? $address : $name.' <'.$address.'>';
        }
        $result=implode(', ',$canonical);
        self::need($email->cleanEmails($result) === $result && from_html($result) === $result,'unsupported_header_normalization');
        return $result;
    }
    private static function links(array $rows): array
    {
        $links=['accounts'=>[],'contacts'=>[]];
        foreach ($rows as $row) if ((int)$row['deleted'] === 0) {
            self::need(in_array($row['bean_module'],['Accounts','Contacts'],true),'unmanaged_relationship_module');
            $key=strtolower($row['bean_module']); self::need(!in_array($row['bean_id'],$links[$key],true),'duplicate_native_relationship'); $links[$key][]=$row['bean_id'];
        }
        foreach ($links as &$ids) sort($ids,SORT_STRING); unset($ids); return $links;
    }
    private static function lockRelated(mysqli $db, array $command, array $current): array
    {
        $result=[];
        foreach (['accounts','contacts'] as $table) {
            $ids=array_values(array_unique(array_merge($command[$table],$current[$table],$command['previousManaged'][$table]))); sort($ids,SORT_STRING);
            foreach ($ids as $id) {
                $rows=self::rows($db,'SELECT * FROM '.$table.' FORCE INDEX (PRIMARY) WHERE id=? FOR UPDATE',[$id],1);
                self::need(count($rows) === 1 && (int)$rows[0]['deleted'] === 0,'related_record_unavailable'); $result[$table][$id]=$rows[0];
            }
            if ($table === 'contacts') $result['contactAccounts']=self::contactRows($db,$ids);
        }
        foreach ($command['contactAccounts'] as $binding) {
            $active=array_values(array_filter($result['contactAccounts'][$binding['contactId']] ?? [],static fn($row)=>(int)$row['deleted'] === 0));
            self::need(count($active) === 1 && $active[0]['account_id'] === $binding['accountId'],'contact_account_changed');
        }
        return $result;
    }
    private static function contactRows(mysqli $db, array $ids): array
    {
        $result=[];
        foreach ($ids as $id) { self::id($id); $result[$id]=self::rows($db,'SELECT * FROM accounts_contacts FORCE INDEX (idx_contid_del_accid) WHERE contact_id=? ORDER BY deleted,account_id,id FOR UPDATE',[$id],100); }
        return $result;
    }
    private static function schema(mysqli $db): void
    {
        foreach (self::INDEXES as $table=>[$index,$columns]) {
            $engine=self::rows($db,'SELECT ENGINE,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[$table],1);
            self::need(count($engine) === 1 && $engine[0]['ENGINE'] === 'InnoDB' && $engine[0]['TABLE_TYPE'] === 'BASE TABLE','unsupported_projection_table');
            $actual=self::rows($db,'SELECT COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? ORDER BY SEQ_IN_INDEX',[$table,$index],4);
            self::need(array_column($actual,'COLUMN_NAME') === $columns,'unsupported_projection_index');
            foreach ($actual as $column) self::need($column['SUB_PART'] === null && $column['INDEX_TYPE'] === 'BTREE','unsupported_projection_index');
        }
    }
    private static function connection(mysqli $db, ClawPilotNativeEmailTransaction $transaction): void
    {
        $transaction->assertConnection($db);
        self::need(DBManagerFactory::getInstance() instanceof MysqliManager && DBManagerFactory::getInstance()->database === $db,'native_connection_changed');
    }
    private static function rows(mysqli $db, string $sql, array $parameters=[], int $cap=5000): array
    {
        try { $statement=$db->prepare($sql); } catch (Throwable $error) { throw new ClawPilotNativeEmailProjectionRefused('native_read_failed'); }
        self::need($statement instanceof mysqli_stmt,'native_read_failed');
        try {
            if ($parameters) $statement->bind_param(str_repeat('s',count($parameters)),...$parameters);
            self::need($statement->execute(),'native_read_failed');
            $metadata=$statement->result_metadata(); self::need($metadata instanceof mysqli_result,'native_read_failed');
            $values=[]; $references=[];
            foreach ($metadata->fetch_fields() as $field) { $values[$field->name]=null; $references[]=&$values[$field->name]; }
            $metadata->free(); self::need($statement->bind_result(...$references),'native_read_failed');
            $rows=[]; $bytes=0;
            while (($fetched=$statement->fetch()) === true) {
                $row=[]; foreach ($values as $key=>$value) $row[$key]=$value;
                $bytes+=strlen(json_encode($row,JSON_THROW_ON_ERROR)); self::need(count($rows)<$cap && $bytes<=8*1024*1024,'native_read_bound'); $rows[]=$row;
            }
            self::need($fetched === null,'native_read_failed');
            return $rows;
        } catch (ClawPilotNativeEmailProjectionRefused $error) { throw $error;
        } catch (Throwable $error) { throw new ClawPilotNativeEmailProjectionRefused('native_read_failed');
        } finally { $statement->close(); }
    }
    private static function execute(mysqli $db, string $sql, array $parameters): void
    {
        $statement=$db->prepare($sql); self::need($statement instanceof mysqli_stmt,'native_write_failed');
        try { $statement->bind_param(str_repeat('s',count($parameters)),...$parameters); self::need($statement->execute() && $statement->affected_rows <= 1,'native_write_failed'); }
        finally { $statement->close(); }
    }
    private static function utc(string $value): string
    {
        self::need(preg_match('/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/D',$value) === 1,'unsupported_timestamp');
        try { $date=new DateTimeImmutable($value,new DateTimeZone('UTC')); $errors=DateTimeImmutable::getLastErrors(); }
        catch (Throwable $error) { throw new ClawPilotNativeEmailProjectionRefused('unsupported_timestamp'); }
        self::need($errors === false || ($errors['warning_count'] === 0 && $errors['error_count'] === 0),'unsupported_timestamp');
        $date=$date->setTimezone(new DateTimeZone('UTC'));
        self::need((int)$date->format('Y') >= 1000 && (int)$date->format('Y') <= 9999,'unsupported_timestamp');
        return $date->format('Y-m-d H:i:s');
    }
    private static function ids($value): array { self::need(is_array($value) && array_is_list($value) && count($value)<=25,'ids_shape'); foreach($value as $id) self::id($id); self::need(count(array_unique($value))===count($value),'duplicate_ids'); sort($value,SORT_STRING); return $value; }
    private static function id($value): void { self::need(is_string($value) && preg_match('/^[a-z0-9][a-z0-9-]{0,35}$/iD',$value)===1,'native_id_shape'); }
    private static function text($value, int $cap): void { self::need(is_string($value) && strlen($value)<=$cap && preg_match('//u',$value)===1 && !preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/',$value),'text_shape'); }
    private static function keys(array $value, array $expected): void { $keys=array_keys($value); sort($keys,SORT_STRING); sort($expected,SORT_STRING); self::need($keys===$expected,'command_shape'); }
    private static function digest(array $value): string { return hash('sha256',json_encode($value,JSON_THROW_ON_ERROR)); }
    private static function need(bool $value, string $code): void { if(!$value) throw new ClawPilotNativeEmailProjectionRefused($code); }
}
