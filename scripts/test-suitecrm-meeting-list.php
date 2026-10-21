<?php
declare(strict_types=1);

// Run the pinned SuiteCRM 8.10.1 query-builder methods, with only the
// relationship/ACL/database boundaries replaced by deterministic fixtures.
define('sugarEntry', true);
$nativeRoot = getenv('CLAWPILOT_TEST_NATIVE_ROOT') ?: '';
$nativeSource = file_get_contents($nativeRoot . '/SugarBean.php');
if (!is_string($nativeSource) || hash('sha256', $nativeSource) !== '5edf1050ee0ad01c1de57f235ebae55bab2e5476f58d979ebfc8eb14fc155547') {
    throw new RuntimeException('Expected pinned SuiteCRM 8.10.1 SugarBean source');
}

function nativeMethod(string $source, string $name): string
{
    $start = strpos($source, '    public function ' . $name . '(');
    if ($start === false) { throw new RuntimeException('Native method not found'); }
    $tokens = token_get_all('<?php ' . substr($source, $start));
    $code = '';
    $depth = 0;
    $opened = false;
    foreach ($tokens as $token) {
        if (is_array($token) && $token[0] === T_OPEN_TAG) { continue; }
        $text = is_array($token) ? $token[1] : $token;
        $code .= $text;
        if ((!is_array($token) && $text === '{')
            || (is_array($token) && in_array($token[0], [T_CURLY_OPEN, T_DOLLAR_OPEN_CURLY_BRACES], true))) {
            $depth++; $opened = true;
        }
        if (!is_array($token) && $text === '}') {
            $depth--;
            if ($opened && $depth === 0) { return $code; }
        }
    }
    throw new RuntimeException('Native method did not terminate');
}

$helpers = <<<'PHP'
    public $table_name = 'meetings';
    public $field_defs = [];
    public $db;
    public $contacts;
    public $fixtureAccessWhere = "meetings.assigned_user_id = 'allowed-owner'";
    public function buildAccessWhere($mode) { return $this->fixtureAccessWhere; }
    public function getCustomJoin($filter) {
        return ['select' => $filter === true ? ', meetings_cstm.global_id_c' : '',
            'join' => ' LEFT JOIN meetings_cstm ON meetings_cstm.id_c = meetings.id '];
    }
    public function load_relationship($link) { return $link === 'contacts'; }
    protected function is_relate_field($field) { return ($this->field_defs[$field]['type'] ?? '') === 'relate'; }
    public function get_relationship_field($field) { return false; }
    public function process_order_by($order) { return $order; }
PHP;
eval('class SugarBean {' . $helpers
    . nativeMethod($nativeSource, 'create_new_list_query')
    . nativeMethod($nativeSource, 'create_list_count_query') . '}');

class MeetingQueryDatabaseFixture
{
    public function concat($table, $fields) { return "CONCAT({$table}." . implode(", ' ', {$table}.", $fields) . ')'; }
}
class MeetingContactsFixture
{
    public function getRelatedModuleName() { return 'Contacts'; }
    public function getJoin($params, $asArray) {
        $contact = $params['join_table_alias'];
        $link = $params['join_table_link_alias'];
        return ['type' => 'many-to-many', 'rel_key' => 'contact_id',
            'join' => " LEFT JOIN meetings_contacts {$link} ON {$link}.meeting_id = meetings.id AND {$link}.deleted = 0"
                . " LEFT JOIN contacts {$contact} ON {$contact}.id = {$link}.contact_id "];
    }
}
class Contact
{
    public $field_defs = ['first_name' => ['type' => 'varchar'], 'last_name' => ['type' => 'varchar']];
    public $field_name_map = ['first_name' => [], 'last_name' => []];
}
class Meeting extends SugarBean
{
    public function __construct() {
        $this->db = new MeetingQueryDatabaseFixture();
        $this->contacts = new MeetingContactsFixture();
        $this->field_defs = [
            'id' => ['name' => 'id', 'type' => 'id'],
            'name' => ['name' => 'name', 'type' => 'name'],
            'date_modified' => ['name' => 'date_modified', 'type' => 'datetime'],
            'assigned_user_id' => ['name' => 'assigned_user_id', 'type' => 'id'],
            'deleted' => ['name' => 'deleted', 'type' => 'bool'],
            'global_id_c' => ['name' => 'global_id_c', 'type' => 'varchar', 'source' => 'custom_fields'],
            'contact_name' => ['name' => 'contact_name', 'type' => 'relate', 'rname' => 'last_name',
                'db_concat_fields' => ['first_name', 'last_name'], 'id_name' => 'contact_id',
                'link' => 'contacts', 'table' => 'contacts', 'module' => 'Contacts',
                'join_name' => 'contacts', 'source' => 'non-db'],
            'contact_id' => ['name' => 'contact_id', 'type' => 'id', 'source' => 'non-db'],
        ];
    }
}

$repoRoot = dirname(__DIR__);
$root = sys_get_temp_dir() . '/clawpilot-meeting-list-' . bin2hex(random_bytes(8));
mkdir($root . '/modules/Meetings', 0700, true);
mkdir($root . '/include/VarDefHandler', 0700, true);
mkdir($root . '/data', 0700, true);
mkdir($root . '/custom/include/ClawPilot', 0700, true);
file_put_contents($root . '/modules/Meetings/Meeting.php', '<?php // Fixture class is already loaded.');
file_put_contents($root . '/data/SugarBean.php', '<?php // Pinned methods are already loaded.');
file_put_contents($root . '/Contact.php', '<?php // Fixture class is already loaded.');
copy($repoRoot . '/services/suitecrm/email-search/MeetingList.php', $root . '/custom/include/ClawPilot/MeetingList.php');
copy($nativeRoot . '/listvardefoverride.php', $root . '/include/VarDefHandler/listvardefoverride.php');
$GLOBALS['beanFiles'] = ['Contact' => $root . '/Contact.php'];
$GLOBALS['beanList'] = ['Contacts' => 'Contact'];
$previous = getcwd();
chdir($root);
try {
    require $root . '/custom/include/ClawPilot/MeetingList.php';
    $native = new Meeting();
    $fixed = new ClawPilotMeeting();
    $queries = [];
    $cases = [
        'all' => ['', 'date_modified ASC', []],
        'global-id' => ["meetings_cstm.global_id_c = 'gmicboburacp2l'", 'date_modified ASC', []],
        'title' => ["meetings.name LIKE 'Weekly%'", 'date_modified ASC', array_keys($fixed->field_defs)],
        'contact-name' => ["contact_name LIKE 'Adrian%'", 'date_modified ASC', []],
        'all-contacts' => ["contact_name LIKE '%'", 'date_modified ASC', []],
        'contact-sort' => ['', 'contact_name ASC', []],
        'contact-id-sort' => ['', 'contact_id DESC', []],
    ];
    foreach ($cases as $name => [$where, $order, $fields]) {
        $before = $native->create_new_list_query($order, $where, $fields, [], 0, '', false, null, true);
        $after = $fixed->create_new_list_query($order, $where, $fields, [], 0, '', false, null, true);
        $queries[$name] = ['before' => $before, 'after' => $after, 'count' => $fixed->create_list_count_query($after)];
        if (!str_contains($after, "meetings.assigned_user_id = 'allowed-owner'")) { throw new RuntimeException('ACL predicate lost'); }
        if (!str_contains($after, 'meetings.deleted=0')) { throw new RuntimeException('Deletion predicate lost'); }
    }
    $parts = $fixed->create_new_list_query('date_modified ASC', '', [], [], 0, '', true, null, true);
    if (!str_contains($parts['secondary_select'], 'contact_name') || !str_contains($parts['secondary_from'], 'meetings_contacts')) {
        throw new RuntimeException('Native secondary attendee hydration lost');
    }
    foreach ([[false, false], [true, true]] as [$singleSelect, $export]) {
        $before = $native->create_new_list_query('date_modified ASC', '', [], [], 0, '', false, null, $singleSelect, $export);
        $after = $fixed->create_new_list_query('date_modified ASC', '', [], [], 0, '', false, null, $singleSelect, $export);
        if ($before !== $after) { throw new RuntimeException('Unowned native query path changed'); }
    }
    foreach (['c; DELETE FROM meetings', ['bad alias']] as $alias) {
        try { $fixed->create_list_count_query($queries['all']['after'], $alias); throw new RuntimeException('Unsafe alias accepted'); }
        catch (InvalidArgumentException $expected) {}
    }
    $beanList = ['Meetings' => 'Meeting', 'Contacts' => 'Contact'];
    $beanFiles = ['Meeting' => 'modules/Meetings/Meeting.php', 'Contact' => 'native-contact'];
    $customBeanList = [];
    $customBeanFiles = [];
    $customObjectList = [];
    require $repoRoot . '/services/suitecrm/email-search/MeetingListRegistration.php';
    require $repoRoot . '/services/suitecrm/email-search/MeetingListRegistration.php';
    if ($beanList !== ['Meetings' => 'Meeting', 'Contacts' => 'Contact'] || $beanFiles['Contact'] !== 'native-contact'
        || $customBeanList !== ['Meetings' => 'ClawPilotMeeting'] || $customObjectList !== ['Meetings' => 'Meeting']) {
        throw new RuntimeException('Registration changed an unrelated bean');
    }
    if (hash_file('sha256', $nativeRoot . '/BeanFactory.php') !== '240a50bd7e8878223230ac466e453de91c1332091d6acf960afb6abf75b75640') {
        throw new RuntimeException('Expected pinned native BeanFactory source');
    }
    require $nativeRoot . '/BeanFactory.php';
    if (BeanFactory::getObjectName('Meetings') !== 'Meeting'
        || BeanFactory::getCustomObjectName('Meetings') !== 'Meeting'
        || BeanFactory::getBeanClass('Meetings') !== 'ClawPilotMeeting'
        || !(BeanFactory::newBean('Meetings') instanceof ClawPilotMeeting)) {
        throw new RuntimeException('Native Meeting dictionary/bean identity changed');
    }
    echo 'CLAWPILOT_MEETING_QUERIES=' . json_encode($queries, JSON_THROW_ON_ERROR) . "\n";
} finally {
    chdir($previous);
    unlink($root . '/modules/Meetings/Meeting.php');
    unlink($root . '/include/VarDefHandler/listvardefoverride.php');
    unlink($root . '/Contact.php');
    unlink($root . '/data/SugarBean.php');
    unlink($root . '/custom/include/ClawPilot/MeetingList.php');
    rmdir($root . '/modules/Meetings'); rmdir($root . '/modules');
    rmdir($root . '/include/VarDefHandler'); rmdir($root . '/include'); rmdir($root . '/data');
    rmdir($root . '/custom/include/ClawPilot'); rmdir($root . '/custom/include'); rmdir($root . '/custom'); rmdir($root);
}
