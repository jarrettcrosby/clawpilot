<?php
declare(strict_types=1);
require_once __DIR__.'/NativeEmailTransaction.php';
require_once __DIR__.'/../native-email-scope/Patch.php';

/** Pinned, prepared runtime profile. No installer, permission change, or waiver.
 * Files must be deployed quiescently with workers restarted (opcache is static).
 * This detects observed file/config drift; it is not a filesystem-admin lock.
 */
final class ClawPilotNativeEmailRuntime
{
    private const WRITE_SCOPE_HASH='e5acae3f23ff7c2c46ea28d01968fb3aac7f9d842aa2c5903eb5f49391113e0a';
    // Only changed bytes from the official 8.10.2 regular release ZIP. Every
    // other source pin and all runtime/schema guards still apply to the worker.
    private const SHARED_WORKER_8_10_2_PINS=[
        'data/Relationships/SugarRelationship.php'=>'a64c455a4a0751cb888235980189788412e05f5eaedf8b0683a0642751d18af2',
        'include/utils.php'=>'80bdeec6d9f86c5f125d8f50989188c187ba29beec5bc52a084e7f9aafbe5289',
        'include/SugarEmailAddress/SugarEmailAddress.php'=>'ff2fd4e3f86bbf32aab9df1cb1c35d059d5162c03a8096c93aea2059bc940ae5',
        'modules/Emails/vardefs.php'=>'e0bcddbcbf10e2be44b695cc09656f1f1619a7ef1b219023d9fadf80b82bd3f3',
        'modules/Contacts/vardefs.php'=>'f97b9924aafa71266f0dba37bea44c8016adc201d573e744940d3fdd7abdf97c',
        'data/SugarBean.php'=>'9203e27556c9ed097cd8f46c3f2212afa95e5a4817802080b34d9ffb98181057',
        'Api/V8/Service/ModuleService.php'=>'78d10d3726f6d2a945a2c7ce7853ead4eb9efccdb4a4c01c49f3abaab17adc79',
        'Api/V8/Service/RelationshipService.php'=>'accfbbaf07a3743ca428de149c53f22ce1afabba86fc26cfa44768bf8b2c0919',
        'include/SugarFolders/SugarFolders.php'=>'2f5572dcdc346f3d90f5cf2690bb5ceb1f301ac167a19d9ec8583523a8953a17',
    ];
    public static function attest(mysqli $db): string
    {return self::attestProfile($db,'ordinary');}
    /** Actual stock-source observation before the separate offline installer.
     * This profile is never accepted by the publisher/authority runtime. */
    public static function attestInitialSource(mysqli $db): string
    {return self::attestProfile($db,'initial_source');}
    /** The ordinary, unmodified SuiteCRM login boundary. This is not an
     * enrollment stage and does not enable the managed role or write scope. */
    public static function attestSharedLoginSource(mysqli $db): string
    {return self::attestProfile($db,'shared_login_source');}
    /** Ordinary OAuth worker only. Historical operator permits still bind to
     * the original stock profile; managed enrollment never uses this path. */
    public static function attestSharedWorkerSource(mysqli $db): string
    {return self::attestProfile($db,'shared_login_source',false,self::sharedWorkerStockUpgrade());}
    private static function sharedWorkerStockUpgrade(): bool
    {
        // The legacy root is independently verified against the loaded Email
        // bean. Observe the installed package, not a caller or image env flag.
        $file='../../VERSION';
        self::requireTrue(is_file($file)&&!is_link($file),'shared_worker_stock_version');
        $version=file_get_contents($file,false,null,0,8);
        self::requireTrue(in_array($version,["8.10.1\n","8.10.2\n"],true),'shared_worker_stock_version');
        return $version==="8.10.2\n";
    }
    /** Actual installed-but-not-enrolled state. The config journal must have
     * enabled managed writes while traffic remains stopped; SQL defaults are
     * still the exact original ALL rows. This is not the old source profile. */
    public static function attestInitialInstalled(mysqli $db): string
    {return self::attestProfile($db,'initial_installed');}
    /** Prediction only, derived after verifying the real installed profile.
     * Execution MUST call ordinary attest() after actual SQL default changes. */
    public static function projectInitialAfter(mysqli $db): string
    {return self::attestProfile($db,'initial_installed',true);}
    private static function attestProfile(mysqli $db,string $stage,bool $projectAfter=false,bool $sharedWorker8102=false): string
    {
        global $sugar_config;
        self::requireTrue(is_bool($sugar_config['clawpilot_managed_email_write_scope']??false),'managed_write_scope_config');
        self::requireTrue(in_array($stage,['ordinary','initial_source','initial_installed','shared_login_source'],true)
            && (!$projectAfter || $stage==='initial_installed')
            && (!$sharedWorker8102 || $stage==='shared_login_source'),'unknown_initial_runtime_stage');
        if($stage!=='ordinary')self::requireTrue(($sugar_config['clawpilot_managed_email_write_scope']??false)
            ===($stage==='initial_installed'),'initial_managed_write_stage');
        self::requireTrue(is_file(__DIR__.'/NativeEmailWriteScope.php')&&!is_link(__DIR__.'/NativeEmailWriteScope.php')
            &&hash_equals(self::WRITE_SCOPE_HASH,hash_file('sha256',__DIR__.'/NativeEmailWriteScope.php')),'managed_write_scope_code');
        $email = BeanFactory::newBean('Emails');
        self::requireTrue($email instanceof Email && get_class($email) === 'Email', 'unknown_email_bean');
        self::requireTrue(realpath('.') === realpath(dirname((new ReflectionClass($email))->getFileName()).'/../..'), 'legacy_root_changed');
        self::requireTrue(DBManagerFactory::getInstance()->database === $db, 'native_connection_changed');
        self::requireTrue(($GLOBALS['db'] ?? null) === DBManagerFactory::getInstance(), 'native_global_manager_changed');
        self::assertDatabaseSideEffectProfile($db);
        self::requireTrue(!($sugar_config['email_enable_auto_send_opt_in'] ?? false), 'auto_send_enabled');
        self::requireTrue(empty($sugar_config['html_allow_objects']) && strtoupper((string)ini_get('default_charset')) === 'UTF-8', 'unsafe_html_profile');
        self::requireTrue($_REQUEST === [], 'implicit_request_context');
        $customEmailFields = array_values(array_filter(array_keys($email->field_defs), static fn($field)=>str_ends_with($field,'_c')));
        sort($customEmailFields,SORT_STRING);
        self::requireTrue($customEmailFields === ['global_id_c'] && ($email->field_defs['global_id_c']['type'] ?? '') === 'varchar'
            && (int)($email->field_defs['global_id_c']['len'] ?? 0) >= 14, 'unknown_email_custom_fields');
        foreach (['securitysuite_inherit_creator','securitysuite_inherit_assigned','securitysuite_inherit_parent'] as $flag) {
            self::requireTrue(($sugar_config[$flag] ?? null) === true, 'unknown_inheritance_profile:'.$flag);
        }
    $pins = [
        'data/BeanFactory.php' => '240a50bd7e8878223230ac466e453de91c1332091d6acf960afb6abf75b75640',
        'data/Link2.php' => 'fb22735d4dca7ca5a97892a78532fdcba877a5711e20fd407316133cb423f8e7',
        'data/Relationships/SugarRelationship.php' => '98ad3a10ea8286f6236702d0f62b12f2c8452c8b77ea009125c73e59f3453e91',
        'data/Relationships/RelationshipFactory.php' => '2fca8f5a9a86c89727a6ebb7b556fe5fd03193d6809b4d9373db5ccdfa0f596f',
        'data/Relationships/M2MRelationship.php' => 'c6a3d2f4ee400fcacb1522363d99563b318dc5d5b5133a66f9619b89eb3af1cd',
        'data/Relationships/One2MRelationship.php' => '20a2b1bcc656a5271c27af453f9ded9f1edab16c219f0ee92b5d782e74be76cb',
        'include/database/DBManager.php' => 'f22ef9cc568f53920bf9a74019b99ba267499bb14df6054f32089b3370da0aa9',
        'include/database/MysqlManager.php' => 'ca3a91992c13a253e48fb06329c015581dec97ed4e17b6ee36a2dfa0a12631ac',
        'include/database/MysqliManager.php' => '3aba3033d743cd35cb788b8f485db1aef8ef718a84f06e48582c975cb86aac5b',
        'include/HtmlSanitizer.php' => '16694aa80e3da806ec88147361e51ede1727e09cae1472e2657a614f8d4c0118',
        'include/clean.php' => '540fe4b0cb3dd6b990c82f002bcd7e9fe8606bf9f3b5c3d47014eeae0cfb90ed',
        'include/utils.php' => '77753ad08a18a0dde0f45f596603391908ef0f83835142754f4ef866ad51b817',
        'include/utils/db_utils.php' => 'b89d64a8dfa2b67c834601f49ba4541246d6d7fbf84f32b1c6ee1214a5c7b84f',
        'include/SugarEmailAddress/SugarEmailAddress.php' => '6f63acf9a6599d821b6677d1dc85b7ff3e394ba917a9bc38bc7ea19af7cc4241',
        'modules/EmailText/EmailText.php' => 'd9d49f55152d6170db1ccea0723d1caa22b86d36a138c58ebd2b3e152c29eea4',
        'modules/EmailText/vardefs.php' => '485c98d9f80902a8299518479f0c7ff7dd7c1ee572a652c4d61687501e4161bc',
        'modules/DynamicFields/DynamicField.php' => '39b244d65b02214d529daf19a94a38bc2be3db4a9d4108b96cfe775d3aeb83d6',
        'modules/Emails/vardefs.php' => '47a672da804def0d4d2b2201286c779a0cf45c2688d06e97d9126be4c6f236be',
        'modules/Accounts/Account.php' => '83b3e19fcf89227c5900428540d14a682baf6af9ca59bedb052c471fd31dedff',
        'modules/Accounts/vardefs.php' => '1d72af0c699a5bc70433dcd665adb11db8ba3eb023e009865cabf6b5654565ab',
        'modules/Contacts/Contact.php' => '7f7f2e9dad9021b3da0a19500b086c76d702fcc7dcd1007862892f9e46ac1c43',
        'modules/Contacts/vardefs.php' => '8353d892bce704edf9cdfdef6dd9953bd005f82208651f4520fddc906196107f',
        'modules/Contacts/updatePortal.php' => '178a8a2877b5cbbb7c9f850dcdfa3ec350ca3ebf812891d8f509c048d72f0294',
        'modules/Contacts/SugarFeeds/ContactFeed.php' => 'a50946f81963a4df225ab43ef8975f7516b2642060f2033c1300dfaa731a44e8',
        'modules/SugarFeed/feedLogicBase.php' => '13c35f20249bc2a37bad29b23da8491690977384be8ecfddeb1e9fde22887ac0',
        'modules/SugarFeed/SugarFeed.php' => '6add3f19ed66a7e6cc59c2062c39c10484932827f5565e00b22960e4fd034ed9',
        'modules/Accounts/AccountsJjwg_MapsLogicHook.php' => 'bb47c44de10e90f20c635dc0749e962eb20fd3a79a8012abd6d376a06754d5ff',
        'modules/Contacts/ContactsJjwg_MapsLogicHook.php' => '30636f865d7ef4c03318c5564128f3e81851fde39f7cd80fa360700a99494e98',
        'modules/jjwg_Maps/jjwg_Maps.php' => '5e0a691f6541a33c6412ef251c2601f2fbf3ac67cd71c369d4715ab81089e01c',
        'modules/Administration/Administration.php' => '2e5cf979279b1b7f666d4d44d4020ccaeeaabfdbdfac08758a5e535b715d57b2',
        'metadata/emails_beansMetaData.php' => 'c42b5465a930b9fd88ca4cc51cc1d101761cc9fe5613e87e8ef106a94086c8fc',
        'metadata/accounts_contactsMetaData.php' => 'f5c1993fde0a74d5d531884ebf7df90a6c6a337cf7c5b2c2c445d50766fc5b0f',
        'metadata/email_addressesMetaData.php' => '769dab35463094a545230c71ca474138f92dc133f92d1a6a3ea50bc9551f985a',
        'data/SugarBean.php' => '5edf1050ee0ad01c1de57f235ebae55bab2e5476f58d979ebfc8eb14fc155547',
        'modules/ACLActions/ACLAction.php' => 'eee9139f7b88d3a3719754f835f2bb5e48af85cbcc51274c94a8bad3dcb67fbd',
        'modules/SecurityGroups/AssignGroups.php' => '6612368834eacd66a011b2b032645d86d5d269791c1b8d4985dc71ddc7767af6',
        'modules/AOW_WorkFlow/AOW_WorkFlow.php' => '4c7848085db5153a7a337aca7acfc63c198a5eb3da60421da045f510da2e4010',
        'include/utils/LogicHook.php' => 'f9ccbeacd358951cba447b1b746a476177b5d0e7b2d2e267d44294fa54184e38',
        'include/portability/SaveHandlers/BeanSaveHandlers.php' => '359b0068effdcea6917f2f5e096fb216265ede8931f3902fef7a0a3e472d88d2',
        'include/portability/SaveHandlers/BeanSaveHandlersManager.php' => '2af90844b6cec1d5e3154e32d3cecbaeb8a8ba9dc84c0f4e672fcab8dcd070b8',
        'include/portability/SaveHandlers/TypeSaveHandlers/BeanMultiRelateSaveHandler.php' => '8ff9df346b8dac93f78e081f53b66f6d620888e7ddd8be4a21252f950697b755',
        'include/portability/LineItems/BeanLineItemSaveHandler.php' => '254fe0532a4e17f1e12bdc0fba32214d34e9d9e38d2a9d9846c8cda2b7dffb9c',
        'lib/Search/ElasticSearch/ElasticSearchHooks.php' => '54e26d3da41b906e76e6dbcfb5a2e0dee79d69b3da56e49b1f98a43cfdba0aec',
        'lib/Search/ElasticSearch/ElasticSearchIndexer.php' => '607f7466df2884d2c673dfcc9daddb4a8e69d0bac45336a4c124ec930e58027b',
        'include/social/hooks.php' => 'af6dd8b8d773a5f1f8caf273391d9334b497c88a95470df26e4256ce03cd241e',
        'modules/AOP_Case_Updates/CaseUpdatesHook.php' => '3e9843dd66b23c051d22ed835dbf4ad9e3b5c222441aebba59e4e1339bbd1cd7',
        'modules/AOP_Case_Updates/util.php' => '77eabac1a935f33924f08ac69ab6c4066e9786a733fdee2fb5afed602e5684d7',
    ];
    $stockSource=in_array($stage,['initial_source','shared_login_source'],true);
    $pins += $stockSource?clawpilot_native_scope_input_hashes():clawpilot_native_scope_output_hashes();
    if($sharedWorker8102)$pins=array_replace($pins,self::SHARED_WORKER_8_10_2_PINS);
    if($stockSource)self::requireTrue(!file_exists('custom/ClawPilotNativeEmailScope.php')&&!is_link('custom/ClawPilotNativeEmailScope.php'),
        $stage==='initial_source'?'initial_source_helper_present':'shared_login_scope_helper_present');
    else $pins['custom/ClawPilotNativeEmailScope.php'] = 'ba26057190771c47cf18c829cf5fef09f93d6dde071b4856c62ca943704059a7';
    foreach ($pins as $path => $hash) self::requireTrue(is_file($path) && !is_link($path) && hash_equals($hash, hash_file('sha256', $path)), 'runtime_changed:'.$path);
    require_once 'data/Relationships/SugarRelationship.php';
    // Native SugarBean.save() drains this process-local queue. Observe only:
    // never clear queued work to make this operation appear side-effect-free.
    $resaveQueue=new ReflectionProperty(SugarRelationship::class,'beansToResave');
    self::requireTrue($resaveQueue->isStatic() && $resaveQueue->getValue()===[]
        && empty($GLOBALS['resavingRelatedBeans']), 'pending_native_relationship_resave');
    $expectedHooks = [
        'after_save' => [[1,'ElasticSearch Index Changes','lib/Search/ElasticSearch/ElasticSearchHooks.php','SuiteCRM\\Search\\ElasticSearch\\ElasticSearchHooks','beanSaved'],
            [30,'popup_select','modules/SecurityGroups/AssignGroups.php','AssignGroups','popup_select'],
            [99,'AOW_Workflow','modules/AOW_WorkFlow/AOW_WorkFlow.php','AOW_WorkFlow','run_bean_flows']],
        'after_delete' => [[1,'ElasticSearch Index Changes','lib/Search/ElasticSearch/ElasticSearchHooks.php','SuiteCRM\\Search\\ElasticSearch\\ElasticSearchHooks','beanDeleted']],
        'after_ui_footer' => [[10,'popup_onload','modules/SecurityGroups/AssignGroups.php','AssignGroups','popup_onload']],
        'after_ui_frame' => [[1,'Load Social JS','include/social/hooks.php','hooks','load_js'],
            [20,'mass_assign','modules/SecurityGroups/AssignGroups.php','AssignGroups','mass_assign']],
    ];
    $normalize = static function (array $hooks): array {
        foreach ($hooks as &$entries) { $entries = array_values($entries); usort($entries, static fn ($a,$b) => $a[0] <=> $b[0]); }
        unset($entries); ksort($hooks); return $hooks;
    };
    $hooks = LogicHook::initialize();
    self::requireTrue($normalize($hooks->getHooks('', true)) === $normalize($expectedHooks), 'Unknown application hooks must hold');
    self::requireTrue(\SuiteCRM\Search\ElasticSearch\ElasticSearchIndexer::isEnabled() === false, 'External indexing must be disabled');
    $moduleHooks = ['Emails' => ['after_save' => [[10,'Save email case updates','modules/AOP_Case_Updates/CaseUpdatesHook.php','CaseUpdatesHook','saveEmailUpdate']]],
        'SecurityGroups' => [], 'Accounts'=>[],
        // Stock feed/portal hooks are before_save/after_save only. ContactFeed
        // creates SugarFeed rows for new Contacts; it is not side-effect-free.
        // The observed installed hooks are admitted because Email/Contact M2M
        // add/delete calls relationship hooks, never Contact.save(); the queue
        // guard above excludes unrelated deferred saves entering Email.save().
        'Contacts'=>['before_save'=>[[1,'Contacts push feed','modules/Contacts/SugarFeeds/ContactFeed.php','ContactFeed','pushFeed']],
            'after_save'=>[[1,'Update Portal','modules/Contacts/updatePortal.php','updatePortal','updateUser']]], 'EmailText'=>[]];
    // These hooks are installed by stock suite_install/GoogleMaps.php. The
    // relationship callbacks do not exempt Emails; admit them only with the
    // existing native Maps setting disabled, never by changing that setting.
    foreach (['Accounts'=>['before_save'=>[77=>'updateGeocodeInfo'],
        'after_save'=>[77=>'updateRelatedMeetingsGeocodeInfo',78=>'updateRelatedProjectGeocodeInfo',79=>'updateRelatedOpportunitiesGeocodeInfo',80=>'updateRelatedCasesGeocodeInfo'],
        'after_relationship_add'=>[77=>'addRelationship'],'after_relationship_delete'=>[77=>'deleteRelationship']],
        'Contacts'=>['before_save'=>[77=>'updateGeocodeInfo'],'after_save'=>[77=>'updateRelatedMeetingsGeocodeInfo']]] as $module=>$phases) {
        foreach ($phases as $phase=>$entries) foreach ($entries as $order=>$method) {
            $moduleHooks[$module][$phase][]=[$order,$method,'modules/'.$module.'/'.$module.'Jjwg_MapsLogicHook.php',$module.'Jjwg_MapsLogicHook',$method];
        }
    }
    $admin=BeanFactory::newBean('Administration');
    self::requireTrue($admin instanceof SugarBean && get_class($admin)==='Administration'
        && realpath((new ReflectionClass($admin))->getFileName())===realpath('modules/Administration/Administration.php')
        && !isset($GLOBALS['customBeanList']['Administration']), 'unknown_configuration_bean');
    $maps=BeanFactory::newBean('jjwg_Maps');
    self::requireTrue($maps instanceof SugarBean && get_class($maps)==='jjwg_Maps'
        && realpath((new ReflectionClass($maps))->getFileName())===realpath('modules/jjwg_Maps/jjwg_Maps.php')
        && !isset($GLOBALS['customBeanList']['jjwg_Maps']) && ($maps->settings['logic_hooks_enabled'] ?? null)===false, 'maps_side_effects_enabled');
    $mapsSettings=self::rows($db,"SELECT value FROM config WHERE category='jjwg' AND name='logic_hooks_enabled'");
    self::requireTrue(count($mapsSettings)<=1 && ($mapsSettings===[] || in_array($mapsSettings[0]['value'],['','0'],true)), 'maps_side_effects_enabled');
    foreach (['emails_beansMetaData.php','accounts_contactsMetaData.php','email_addressesMetaData.php'] as $file) {
        self::requireTrue(!file_exists('custom/metadata/'.$file), 'unknown_relationship_metadata');
    }
    $beanPaths=['Emails'=>['Email','modules/Emails/Email.php'],'SecurityGroups'=>['SecurityGroup','modules/SecurityGroups/SecurityGroup.php'],
        'Accounts'=>['Account','modules/Accounts/Account.php'],'Contacts'=>['Contact','modules/Contacts/Contact.php'],'EmailText'=>['EmailText','modules/EmailText/EmailText.php']];
    foreach ($beanPaths as $module=>[$class,$path]) {
        $bean=BeanFactory::newBean($module);
        self::requireTrue($bean instanceof SugarBean && get_class($bean) === $class
            && realpath((new ReflectionClass($bean))->getFileName()) === realpath($path), 'unknown_native_bean:'.$module);
        self::requireTrue(!isset($GLOBALS['customBeanList'][$module]), 'unknown_custom_bean:'.$module);
        self::requireTrue($normalize($hooks->getHooks($module, true)) === $normalize($moduleHooks[$module]), 'unknown_module_hooks:'.$module);
        // Pinned stock setRegistry() also copies TYPE_BEFORE into the after
        // registry, then appends the multi-relate handler in its constructor.
        foreach (['before' => ['BeanLineItemSaveHandler'], 'after' => ['BeanLineItemSaveHandler','BeanMultiRelateSaveHandler']] as $phase => $classes) {
            $actual = array_map('get_class', BeanSaveHandlers::getInstance()->get($module, $phase));
            self::requireTrue($actual === $classes, 'Unknown '.$module.' '.$phase.' save handlers must hold: '.implode(',', $actual));
        }
    }
    self::requireTrue(self::rows($db, "SELECT id FROM aow_workflow WHERE deleted=0 AND status='Active'") === [], 'Active native workflows must hold');
    self::requireTrue(self::rows($db, 'SELECT id FROM securitygroups_default WHERE deleted=0') === [], 'Default/inherited group rules must hold');
        // Future unroled principals must not fall back to ALL. Existing role
        // overrides are evaluated per-record under the same native policy lock.
        $defaults = self::rows($db, "SELECT name,aclaccess FROM acl_actions WHERE category='Emails' AND acltype='module' AND deleted=0 AND name IN ('view','list','export','edit','delete') ORDER BY name");
        $safeDefaults = ['delete'=>75,'edit'=>75,'export'=>80,'list'=>80,'view'=>80];
        $expected = $stage==='ordinary'?$safeDefaults:array_fill_keys(array_keys($safeDefaults),90);
        self::requireTrue(count($defaults) === 5, 'unsafe_email_defaults');
        foreach ($defaults as $row) self::requireTrue(isset($expected[$row['name']]) && (int)$row['aclaccess'] === $expected[$row['name']], 'unsafe_email_defaults');
        ksort($pins, SORT_STRING);
        $profile='stock-inheritance-no-default-groups-no-workflows-no-external-index';
        if($stage!=='ordinary'&&!$projectAfter)$profile.='-'.$stage;
        if($sharedWorker8102)$profile.='-suitecrm-8.10.2';
        return hash('sha256', json_encode(['version'=>1,'pins'=>$pins,'profile'=>$profile,
            'defaults'=>$projectAfter?$safeDefaults:$expected,'siteUrl'=>(string)($sugar_config['site_url'] ?? ''),'htmlAllowObjects'=>false,'charset'=>'UTF-8','mapsLogicHooksEnabled'=>false,
            'managedEmailWriteScope'=>($sugar_config['clawpilot_managed_email_write_scope']??false),
            'managedEmailWriteScopeCode'=>self::WRITE_SCOPE_HASH], JSON_THROW_ON_ERROR));
    }
    /** Cheap independently callable check after registry table metadata locks. */
    public static function assertDatabaseSideEffectProfile(mysqli $db): void
    {
        // Empty metadata is not evidence when the current DB account cannot
        // inspect these objects. Role-only/unknown privilege layouts hold.
        $identity = self::rows($db, 'SELECT CURRENT_USER() AS principal,DATABASE() AS database_name')[0] ?? [];
        $principal = $identity['principal'] ?? '';
        $database = $identity['database_name'] ?? '';
        $parts = explode('@', $principal);
        self::requireTrue(count($parts) === 2 && preg_match('/^[a-zA-Z0-9_.-]+$/D',$parts[0]) === 1
            && preg_match('/^[a-zA-Z0-9_.%:-]+$/D',$parts[1]) === 1
            && is_string($database) && $database!=='' && strlen($database)<=64, 'database_metadata_principal_unproven');
        $grantee = "'".$parts[0]."'@'".$parts[1]."'";
        $grants = self::rows($db, "SELECT PRIVILEGE_TYPE,NULL AS TABLE_SCHEMA FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=?".
            " AND PRIVILEGE_TYPE IN ('TRIGGER','EVENT') UNION ALL SELECT PRIVILEGE_TYPE,TABLE_SCHEMA FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=?".
            " AND PRIVILEGE_TYPE IN ('TRIGGER','EVENT')",[$grantee,$grantee]);
        $privileges=[];
        foreach($grants as $grant) if($grant['TABLE_SCHEMA']===null || self::exactSchemaGrant($grant['TABLE_SCHEMA'],$database))
            $privileges[]=$grant['PRIVILEGE_TYPE'];
        $privileges=array_values(array_unique($privileges));sort($privileges,SORT_STRING);
        self::requireTrue($privileges === ['EVENT','TRIGGER'], 'database_metadata_visibility_unproven');
        self::requireTrue(self::rows($db, 'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()') === [], 'unknown_database_trigger');
        // No events, including disabled events awaiting activation, belong to
        // the pinned stock profile. This is attestation, not a DB-admin fence.
        self::requireTrue(self::rows($db, 'SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()') === [], 'unknown_database_event');
    }
    private static function exactSchemaGrant(string $grantSchema,string $database): bool
    {
        // MariaDB SCHEMA_PRIVILEGES reports the stored GRANT pattern. The
        // pinned image escapes underscores in suitecrm_native_test. Accept
        // only its exact canonical escaped literal, never LIKE/wildcard matches
        // or privileges belonging to another schema.
        return $database!=='' && $grantSchema===strtr($database,['\\'=>'\\\\','_'=>'\\_','%'=>'\\%']);
    }
    private static function rows(mysqli $db, string $sql, array $parameters=[]): array
    {
        $statement=null;$result=null;
        try {
            if($parameters) {
                $statement=$db->prepare($sql);
                self::requireTrue($statement instanceof mysqli_stmt,'profile_read_failed');
                self::requireTrue($statement->bind_param(str_repeat('s',count($parameters)),...$parameters),'profile_read_failed');
                self::requireTrue($statement->execute(),'profile_read_failed');
                $result=$statement->get_result();
            } else $result = $db->query($sql);
            self::requireTrue($result instanceof mysqli_result,'profile_read_failed');
            return $result->fetch_all(MYSQLI_ASSOC);
        } finally {if($result instanceof mysqli_result)$result->free();if($statement instanceof mysqli_stmt)$statement->close();}
    }
    private static function requireTrue(bool $value, string $message): void
    {
        if (!$value) throw new ClawPilotNativeEmailTransactionRefused('native_runtime_profile_unproven',$message);
    }
}
