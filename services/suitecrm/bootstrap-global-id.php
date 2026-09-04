<?php
declare(strict_types=1);

if (!defined('sugarEntry')) {
    define('sugarEntry', true);
}

require_once 'include/entryPoint.php';
require_once 'modules/DynamicFields/DynamicField.php';
require_once 'modules/DynamicFields/FieldCases.php';
require_once 'modules/ModuleBuilder/parsers/ParserFactory.php';
require_once 'modules/ModuleBuilder/parsers/parser.searchfields.php';
require_once 'include/SugarObjects/VardefManager.php';
require_once 'lib/Search/SearchModules.php';
require_once __DIR__ . '/install-email-search.php';

install_clawpilot_email_search(__DIR__ . '/email-search', getcwd());

const CLAWPILOT_GLOBAL_ID_FIELD = 'global_id_c';
const CLAWPILOT_GLOBAL_ID_LABEL = 'LBL_GLOBAL_ID';
const CLAWPILOT_GLOBAL_ID_MIN_LENGTH = 32;
const CLAWPILOT_NOTE_OCCURRED_AT_FIELD = 'occurred_at_c';
const CLAWPILOT_NOTE_OCCURRED_AT_LABEL = 'LBL_OCCURRED_AT';
const CLAWPILOT_PRODUCT_MODULE = 'AOS_Products';
const CLAWPILOT_PRODUCT_IMAGE_FIELD = 'clawpilot_image_c';
const CLAWPILOT_PRODUCT_IMAGE_LABEL = 'LBL_CLAWPILOT_PRODUCT_IMAGE';
const CLAWPILOT_PRODUCT_IMAGE_METADATA = [
    'storage_type' => 'private-images',
    'createThumbnail' => true,
    'thumbnailHeight' => 320,
    'thumbnailWidth' => 320,
    'preview' => true,
    'upload_maxsize' => 2097152,
];

/** @param mixed $value */
function layout_contains_field($value, string $fieldName): bool
{
    if (is_string($value)) {
        return strtolower($value) === strtolower($fieldName);
    }
    if (!is_array($value)) {
        return false;
    }
    if (isset($value['name']) && is_string($value['name']) && strtolower($value['name']) === strtolower($fieldName)) {
        return true;
    }
    foreach ($value as $key => $child) {
        if (is_string($key) && strtolower($key) === strtolower($fieldName)) {
            return true;
        }
        if (layout_contains_field($child, $fieldName)) {
            return true;
        }
    }
    return false;
}

/** @param mixed $value */
function layout_contains_global_id($value): bool
{
    return layout_contains_field($value, CLAWPILOT_GLOBAL_ID_FIELD);
}

function expose_global_id_in_detail_view(string $module): void
{
    $parser = ParserFactory::getParser('detailview', $module);
    if (!$parser) {
        throw new RuntimeException("SuiteCRM detail layout for {$module} is unavailable");
    }
    if (!layout_contains_global_id($parser->getLayout())) {
        $parser->addField([
            'name' => CLAWPILOT_GLOBAL_ID_FIELD,
            'label' => CLAWPILOT_GLOBAL_ID_LABEL,
        ]);
        $parser->handleSave(false);
        $parser = ParserFactory::getParser('detailview', $module);
    }
    if (!$parser || !layout_contains_global_id($parser->getLayout())) {
        throw new RuntimeException("Global ID is missing from the {$module} detail layout");
    }
}

function expose_global_id_in_list_view(string $module): void
{
    $parser = ParserFactory::getParser('listview', $module);
    if (!$parser) {
        throw new RuntimeException("SuiteCRM list layout for {$module} is unavailable");
    }
    if (!layout_contains_global_id($parser->getLayout())) {
        $parser->_viewdefs[CLAWPILOT_GLOBAL_ID_FIELD] = [
            'width' => '10%',
            'label' => CLAWPILOT_GLOBAL_ID_LABEL,
            'default' => true,
            'sortable' => true,
        ];
        $parser->handleSave(false);
        $parser = ParserFactory::getParser('listview', $module);
    }
    if (!$parser || !layout_contains_global_id($parser->getLayout())) {
        throw new RuntimeException("Global ID is missing from the {$module} list layout");
    }
}

function expose_global_id_in_search_view(string $module, string $view): void
{
    $parser = ParserFactory::getParser($view, $module);
    if (!$parser) {
        throw new RuntimeException("SuiteCRM {$view} layout for {$module} is unavailable");
    }
    if (!layout_contains_global_id($parser->getLayout())) {
        $parser->_viewdefs[CLAWPILOT_GLOBAL_ID_FIELD] = [
            'name' => CLAWPILOT_GLOBAL_ID_FIELD,
            'label' => CLAWPILOT_GLOBAL_ID_LABEL,
            'default' => true,
        ];
        $parser->handleSave(false);
        $parser = ParserFactory::getParser($view, $module);
    }
    if (!$parser || !layout_contains_global_id($parser->getLayout())) {
        throw new RuntimeException("Global ID is missing from the {$module} {$view} layout");
    }
}

function ensure_global_id_search_field(string $module): void
{
    $parser = new ParserSearchFields($module);
    $definition = $parser->searchFields[$module][CLAWPILOT_GLOBAL_ID_FIELD] ?? [];
    if (
        !is_array($definition)
        || ($definition['query_type'] ?? null) !== 'default'
        || empty($definition['force_unifiedsearch'])
    ) {
        $parser->addSearchField(CLAWPILOT_GLOBAL_ID_FIELD, [
            'query_type' => 'default',
            // Dynamic vardefs written in this process are not reloaded until the
            // next request. This keeps the rebuilt native search cache correct now.
            'force_unifiedsearch' => true,
        ]);
        $parser->saveSearchFields($parser->searchFields);
    }

    $parser = new ParserSearchFields($module);
    $definition = $parser->searchFields[$module][CLAWPILOT_GLOBAL_ID_FIELD] ?? [];
    if (
        !is_array($definition)
        || ($definition['query_type'] ?? null) !== 'default'
        || empty($definition['force_unifiedsearch'])
    ) {
        throw new RuntimeException("Global ID is missing from {$module} search fields");
    }
}

function ensure_email_unified_search_support(): void
{
    $directory = 'custom/Extension/modules/Emails/Ext/Vardefs';
    $path = $directory . '/zz_clawpilot_unified_search.php';
    $definition = <<<'PHP'
<?php
// SuiteCRM's native Email bean does not opt into unified search even though
// its basic-template fields and custom SearchFields metadata support it.
$dictionary['Email']['unified_search'] = true;
PHP;
    $definition .= "\n";

    mkdir_recursive($directory, true);
    $current = is_file($path) ? file_get_contents($path) : false;
    $changed = $current === false || !hash_equals($definition, $current);
    if ($changed && file_put_contents($path, $definition, LOCK_EX) === false) {
        throw new RuntimeException('Could not write the SuiteCRM Email unified-search vardef extension');
    }

    if ($changed || empty($GLOBALS['dictionary']['Email']['unified_search'])) {
        require_once 'ModuleInstall/ModuleInstaller.php';
        $installer = new ModuleInstaller();
        $installer->silent = true;
        $installer->rebuild_vardefs();

        VardefManager::clearVardef('Emails', 'Email');
        unset($GLOBALS['dictionary']['Email']);
        VardefManager::refreshVardefs('Emails', 'Email');
    }

    if (empty($GLOBALS['dictionary']['Email']['unified_search'])) {
        throw new RuntimeException('SuiteCRM Emails module is not enabled for unified search');
    }
}

/** @param array<string, mixed> $definition */
function global_id_definition_is_current(array $definition, bool $unifiedSearch = true): bool
{
    $fullText = $definition['full_text_search'] ?? null;
    $base = ($definition['vname'] ?? '') === CLAWPILOT_GLOBAL_ID_LABEL
        && (int) ($definition['len'] ?? 0) >= CLAWPILOT_GLOBAL_ID_MIN_LENGTH
        && !empty($definition['audited'])
        && !empty($definition['reportable']);
    if (!$base || !$unifiedSearch) {
        return $base;
    }
    return !empty($definition['unified_search'])
        && is_array($fullText)
        && !empty($fullText['enabled']);
}

function refresh_and_verify_global_id_field(string $module): void
{
    $objectName = BeanFactory::getObjectName($module);
    if (!is_string($objectName) || $objectName === '') {
        throw new RuntimeException("SuiteCRM object name for {$module} is unavailable");
    }

    // DynamicField::addFieldObject() persists fields_meta_data and alters the
    // custom table, then calls buildCache(). SuiteCRM's buildCache() only fills
    // vardef keys that are not already present in this process. Without a full
    // refresh, an older cached len therefore survives the successful ALTER and
    // is written back to the vardef cache consumed by Api/V8/meta/fields.
    VardefManager::clearVardef($module, $objectName);
    unset($GLOBALS['dictionary'][$objectName]);
    VardefManager::refreshVardefs($module, $objectName);

    $hadReloadVardefs = array_key_exists('reload_vardefs', $GLOBALS);
    $previousReloadVardefs = $GLOBALS['reload_vardefs'] ?? null;
    $GLOBALS['reload_vardefs'] = true;
    try {
        $freshBean = BeanFactory::newBean($module);
    } finally {
        if ($hadReloadVardefs) {
            $GLOBALS['reload_vardefs'] = $previousReloadVardefs;
        } else {
            unset($GLOBALS['reload_vardefs']);
        }
    }
    if (!$freshBean) {
        throw new RuntimeException("SuiteCRM module {$module} is unavailable after vardef refresh");
    }

    $definition = isset($freshBean->field_defs[CLAWPILOT_GLOBAL_ID_FIELD])
        && is_array($freshBean->field_defs[CLAWPILOT_GLOBAL_ID_FIELD])
        ? $freshBean->field_defs[CLAWPILOT_GLOBAL_ID_FIELD]
        : [];
    $definitionLength = (int) ($definition['len'] ?? 0);
    if ($definitionLength < CLAWPILOT_GLOBAL_ID_MIN_LENGTH) {
        throw new RuntimeException(
            "Global ID vardef for {$module} is stale after refresh (length {$definitionLength})"
        );
    }

    $dynamic = new DynamicField($module);
    $dynamic->setup($freshBean);
    $persisted = $dynamic->getFieldWidget($module, CLAWPILOT_GLOBAL_ID_FIELD);
    $persistedLength = $persisted ? (int) ($persisted->len ?? 0) : 0;
    if (!$persisted || $persistedLength < CLAWPILOT_GLOBAL_ID_MIN_LENGTH) {
        throw new RuntimeException(
            "Global ID metadata for {$module} is not widened (length {$persistedLength})"
        );
    }

    $tableName = $freshBean->table_name . '_cstm';
    $columns = DBManagerFactory::getInstance()->get_columns($tableName);
    $column = $columns[strtolower(CLAWPILOT_GLOBAL_ID_FIELD)] ?? [];
    $columnLength = is_array($column) ? (int) ($column['len'] ?? 0) : 0;
    if (
        !is_array($column)
        || !in_array(strtolower((string) ($column['type'] ?? '')), ['varchar', 'char'], true)
        || $columnLength < CLAWPILOT_GLOBAL_ID_MIN_LENGTH
    ) {
        throw new RuntimeException(
            "Global ID database column {$tableName}." . CLAWPILOT_GLOBAL_ID_FIELD
            . " is not widened (length {$columnLength})"
        );
    }
}

function ensure_global_id_field(
    string $module,
    bool $unifiedSearch = true,
    bool $managedLayouts = true
): void
{
    $bean = BeanFactory::newBean($module);
    if (!$bean) {
        throw new RuntimeException("SuiteCRM module {$module} is unavailable");
    }

    $dynamic = new DynamicField($module);
    $dynamic->setup($bean);
    $definition = isset($bean->field_defs[CLAWPILOT_GLOBAL_ID_FIELD])
        && is_array($bean->field_defs[CLAWPILOT_GLOBAL_ID_FIELD])
        ? $bean->field_defs[CLAWPILOT_GLOBAL_ID_FIELD]
        : [];
    $existing = $dynamic->getFieldWidget($module, CLAWPILOT_GLOBAL_ID_FIELD);

    if (
        !$existing
        || (int) ($existing->len ?? 0) < CLAWPILOT_GLOBAL_ID_MIN_LENGTH
        || !global_id_definition_is_current($definition, $unifiedSearch)
    ) {
        $field = $existing ?: get_widget('varchar');
        $fieldLength = max(
            CLAWPILOT_GLOBAL_ID_MIN_LENGTH,
            (int) ($field->len ?? 0),
            (int) ($definition['len'] ?? 0)
        );
        $field->name = $existing ? CLAWPILOT_GLOBAL_ID_FIELD : 'global_id';
        $field->label = CLAWPILOT_GLOBAL_ID_LABEL;
        $field->vname = CLAWPILOT_GLOBAL_ID_LABEL;
        $field->label_value = 'Global ID';
        $field->len = (string) $fieldLength;
        $field->size = (string) $fieldLength;
        $field->required = false;
        $field->default = null;
        $field->default_value = null;
        $field->audited = 1;
        $field->inline_edit = 0;
        $field->massupdate = 0;
        $field->importable = 'true';
        $field->duplicate_merge = 'disabled';
        $field->reportable = true;
        $field->unified_search = $unifiedSearch ? 1 : 0;
        $field->full_text_search = ['enabled' => $unifiedSearch, 'boost' => 3];
        $field->comment = 'Permanent ClawPilot global reference. Managed by ClawPilot.';
        $field->save($dynamic);
    }

    refresh_and_verify_global_id_field($module);
    $dynamic->setLabel('en_us', CLAWPILOT_GLOBAL_ID_LABEL, 'Global ID');
    if ($unifiedSearch) {
        ensure_global_id_search_field($module);
    }
    if ($managedLayouts) {
        expose_global_id_in_detail_view($module);
        expose_global_id_in_list_view($module);
        expose_global_id_in_search_view($module, 'basic_search');
        expose_global_id_in_search_view($module, 'advanced_search');
    }
}

/** @param mixed $metadata */
function product_image_metadata_is_current($metadata): bool
{
    if (is_string($metadata)) {
        $decoded = json_decode($metadata, true);
        if (!is_array($decoded)) {
            // DynamicField::getFieldWidget() HTML-encodes DB values, including
            // the JSON quotes, while vardef metadata is already decoded.
            $decoded = json_decode(html_entity_decode($metadata, ENT_QUOTES | ENT_HTML5, 'UTF-8'), true);
        }
        $metadata = is_array($decoded) ? $decoded : [];
    }
    if (!is_array($metadata)) {
        return false;
    }

    foreach (CLAWPILOT_PRODUCT_IMAGE_METADATA as $key => $expected) {
        if (!array_key_exists($key, $metadata) || $metadata[$key] !== $expected) {
            return false;
        }
    }
    return true;
}

/** @param array<string, mixed> $definition */
function product_image_definition_is_current(array $definition): bool
{
    return ($definition['vname'] ?? '') === CLAWPILOT_PRODUCT_IMAGE_LABEL
        && ($definition['type'] ?? '') === 'image'
        && ($definition['source'] ?? '') === 'non-db'
        && product_image_metadata_is_current($definition['metadata'] ?? []);
}

/** @param mixed $widget */
function product_image_widget_is_current($widget): bool
{
    if (!$widget) {
        return false;
    }
    $definition = $widget->get_field_def();
    return is_array($definition)
        && ($definition['type'] ?? '') === 'image'
        && ($definition['source'] ?? '') === 'non-db'
        && product_image_metadata_is_current($widget->metadata ?? []);
}

function refresh_and_verify_product_image_field(): void
{
    $objectName = BeanFactory::getObjectName(CLAWPILOT_PRODUCT_MODULE);
    if (!is_string($objectName) || $objectName === '') {
        throw new RuntimeException('SuiteCRM AOS Products object name is unavailable');
    }

    VardefManager::clearVardef(CLAWPILOT_PRODUCT_MODULE, $objectName);
    unset($GLOBALS['dictionary'][$objectName]);
    VardefManager::refreshVardefs(CLAWPILOT_PRODUCT_MODULE, $objectName);

    $hadReloadVardefs = array_key_exists('reload_vardefs', $GLOBALS);
    $previousReloadVardefs = $GLOBALS['reload_vardefs'] ?? null;
    $GLOBALS['reload_vardefs'] = true;
    try {
        $freshBean = BeanFactory::newBean(CLAWPILOT_PRODUCT_MODULE);
    } finally {
        if ($hadReloadVardefs) {
            $GLOBALS['reload_vardefs'] = $previousReloadVardefs;
        } else {
            unset($GLOBALS['reload_vardefs']);
        }
    }
    if (!$freshBean) {
        throw new RuntimeException('SuiteCRM AOS Products is unavailable after vardef refresh');
    }

    $definition = isset($freshBean->field_defs[CLAWPILOT_PRODUCT_IMAGE_FIELD])
        && is_array($freshBean->field_defs[CLAWPILOT_PRODUCT_IMAGE_FIELD])
        ? $freshBean->field_defs[CLAWPILOT_PRODUCT_IMAGE_FIELD]
        : [];
    if (!product_image_definition_is_current($definition)) {
        throw new RuntimeException(
            'ClawPilot product image vardef is not a native non-db private image field after refresh'
        );
    }

    $dynamic = new DynamicField(CLAWPILOT_PRODUCT_MODULE);
    $dynamic->setup($freshBean);
    $persisted = $dynamic->getFieldWidget(CLAWPILOT_PRODUCT_MODULE, CLAWPILOT_PRODUCT_IMAGE_FIELD);
    if (!product_image_widget_is_current($persisted)) {
        throw new RuntimeException(
            'ClawPilot product image fields_meta_data does not contain the required native image metadata'
        );
    }
}

function expose_product_image_in_view(string $view): void
{
    $parser = ParserFactory::getParser($view, CLAWPILOT_PRODUCT_MODULE);
    if (!$parser) {
        throw new RuntimeException("SuiteCRM {$view} layout for AOS Products is unavailable");
    }
    if (!layout_contains_field($parser->getLayout(), CLAWPILOT_PRODUCT_IMAGE_FIELD)) {
        $parser->addField([
            'name' => CLAWPILOT_PRODUCT_IMAGE_FIELD,
            'label' => CLAWPILOT_PRODUCT_IMAGE_LABEL,
        ]);
        $parser->handleSave(false);
        $parser = ParserFactory::getParser($view, CLAWPILOT_PRODUCT_MODULE);
    }
    if (!$parser || !layout_contains_field($parser->getLayout(), CLAWPILOT_PRODUCT_IMAGE_FIELD)) {
        throw new RuntimeException("ClawPilot product image is missing from the AOS Products {$view} layout");
    }
}

function ensure_product_image_field(): void
{
    $bean = BeanFactory::newBean(CLAWPILOT_PRODUCT_MODULE);
    if (!$bean) {
        throw new RuntimeException('SuiteCRM AOS Products module is unavailable');
    }

    $dynamic = new DynamicField(CLAWPILOT_PRODUCT_MODULE);
    $dynamic->setup($bean);
    $definition = isset($bean->field_defs[CLAWPILOT_PRODUCT_IMAGE_FIELD])
        && is_array($bean->field_defs[CLAWPILOT_PRODUCT_IMAGE_FIELD])
        ? $bean->field_defs[CLAWPILOT_PRODUCT_IMAGE_FIELD]
        : [];
    $existing = $dynamic->getFieldWidget(CLAWPILOT_PRODUCT_MODULE, CLAWPILOT_PRODUCT_IMAGE_FIELD);

    if (!product_image_definition_is_current($definition) || !product_image_widget_is_current($existing)) {
        // Always use TemplateImage, including when repairing a wrongly typed
        // pre-existing field, so DynamicField persists the image metadata map.
        $field = get_widget('image');
        $field->name = $existing ? CLAWPILOT_PRODUCT_IMAGE_FIELD : 'clawpilot_image';
        $field->label = CLAWPILOT_PRODUCT_IMAGE_LABEL;
        $field->vname = CLAWPILOT_PRODUCT_IMAGE_LABEL;
        $field->label_value = 'ClawPilot Product Image';
        $field->type = 'image';
        $field->required = false;
        $field->default = null;
        $field->default_value = null;
        $field->audited = 1;
        $field->inline_edit = 0;
        $field->massupdate = 0;
        $field->importable = 'false';
        $field->duplicate_merge = 'disabled';
        $field->reportable = false;
        $field->comment = 'Native SuiteCRM product media managed by ClawPilot.';
        $field->metadata = CLAWPILOT_PRODUCT_IMAGE_METADATA;
        $field->storage_type = CLAWPILOT_PRODUCT_IMAGE_METADATA['storage_type'];
        $field->maxHeight = null;
        $field->maxWidth = null;
        $field->createThumbnail = CLAWPILOT_PRODUCT_IMAGE_METADATA['createThumbnail'];
        $field->thumbnailHeight = CLAWPILOT_PRODUCT_IMAGE_METADATA['thumbnailHeight'];
        $field->thumbnailWidth = CLAWPILOT_PRODUCT_IMAGE_METADATA['thumbnailWidth'];
        $field->preview = CLAWPILOT_PRODUCT_IMAGE_METADATA['preview'];
        $field->upload_maxsize = CLAWPILOT_PRODUCT_IMAGE_METADATA['upload_maxsize'];
        $field->save($dynamic);
    }

    refresh_and_verify_product_image_field();
    $dynamic->setLabel('en_us', CLAWPILOT_PRODUCT_IMAGE_LABEL, 'ClawPilot Product Image');
    expose_product_image_in_view('detailview');
    expose_product_image_in_view('editview');
}

function expose_note_occurred_at_in_view(string $view): void
{
    $parser = ParserFactory::getParser($view, 'Notes');
    if (!$parser) {
        throw new RuntimeException("SuiteCRM {$view} layout for Notes is unavailable");
    }
    if (!layout_contains_field($parser->getLayout(), CLAWPILOT_NOTE_OCCURRED_AT_FIELD)) {
        $parser->addField([
            'name' => CLAWPILOT_NOTE_OCCURRED_AT_FIELD,
            'label' => CLAWPILOT_NOTE_OCCURRED_AT_LABEL,
        ]);
        $parser->handleSave(false);
        $parser = ParserFactory::getParser($view, 'Notes');
    }
    if (!$parser || !layout_contains_field($parser->getLayout(), CLAWPILOT_NOTE_OCCURRED_AT_FIELD)) {
        throw new RuntimeException("Occurred At is missing from the Notes {$view} layout");
    }
}

function expose_note_occurred_at_in_list_view(): void
{
    $parser = ParserFactory::getParser('listview', 'Notes');
    if (!$parser) {
        throw new RuntimeException('SuiteCRM list layout for Notes is unavailable');
    }
    if (!layout_contains_field($parser->getLayout(), CLAWPILOT_NOTE_OCCURRED_AT_FIELD)) {
        $parser->_viewdefs[CLAWPILOT_NOTE_OCCURRED_AT_FIELD] = [
            'width' => '12%',
            'label' => CLAWPILOT_NOTE_OCCURRED_AT_LABEL,
            'default' => true,
            'sortable' => true,
        ];
        $parser->handleSave(false);
        $parser = ParserFactory::getParser('listview', 'Notes');
    }
    if (!$parser || !layout_contains_field($parser->getLayout(), CLAWPILOT_NOTE_OCCURRED_AT_FIELD)) {
        throw new RuntimeException('Occurred At is missing from the Notes list layout');
    }
}

/** @param array<string, mixed> $definition */
function note_occurred_at_definition_is_current(array $definition): bool
{
    return ($definition['vname'] ?? '') === CLAWPILOT_NOTE_OCCURRED_AT_LABEL
        && in_array(($definition['type'] ?? ''), ['datetime', 'datetimecombo'], true)
        && !empty($definition['audited'])
        && !empty($definition['reportable']);
}

function ensure_note_occurred_at_field(): void
{
    $bean = BeanFactory::newBean('Notes');
    if (!$bean) {
        throw new RuntimeException('SuiteCRM Notes module is unavailable');
    }

    $dynamic = new DynamicField('Notes');
    $dynamic->setup($bean);
    $definition = isset($bean->field_defs[CLAWPILOT_NOTE_OCCURRED_AT_FIELD])
        && is_array($bean->field_defs[CLAWPILOT_NOTE_OCCURRED_AT_FIELD])
        ? $bean->field_defs[CLAWPILOT_NOTE_OCCURRED_AT_FIELD]
        : [];
    $existing = $dynamic->getFieldWidget('Notes', CLAWPILOT_NOTE_OCCURRED_AT_FIELD);

    if (!$existing || !note_occurred_at_definition_is_current($definition)) {
        $field = $existing ?: get_widget('datetimecombo');
        $field->name = $existing ? CLAWPILOT_NOTE_OCCURRED_AT_FIELD : 'occurred_at';
        $field->label = CLAWPILOT_NOTE_OCCURRED_AT_LABEL;
        $field->vname = CLAWPILOT_NOTE_OCCURRED_AT_LABEL;
        $field->label_value = 'Occurred At';
        $field->required = false;
        $field->default = null;
        $field->default_value = null;
        $field->audited = 1;
        $field->inline_edit = 1;
        $field->massupdate = 0;
        $field->importable = 'true';
        $field->duplicate_merge = 'disabled';
        $field->reportable = true;
        $field->comment = 'Business occurrence time for the ClawPilot interaction. Managed by ClawPilot.';
        $field->save($dynamic);
    }

    $dynamic->setLabel('en_us', CLAWPILOT_NOTE_OCCURRED_AT_LABEL, 'Occurred At');
    expose_note_occurred_at_in_view('detailview');
    expose_note_occurred_at_in_view('editview');
    expose_note_occurred_at_in_list_view();
}

function product_purchases_subpanel_is_hidden(): bool
{
    $layout_defs = [];
    $basePath = 'modules/AOS_Products/metadata/subpaneldefs.php';
    $compiledPath = 'custom/modules/AOS_Products/Ext/Layoutdefs/layoutdefs.ext.php';
    if (!is_file($basePath)) {
        throw new RuntimeException('SuiteCRM AOS Products subpanel metadata is unavailable');
    }
    include $basePath;
    if (is_file($compiledPath)) {
        include $compiledPath;
    }
    return empty($layout_defs['AOS_Products']['subpanel_setup']['aos_products_purchases']);
}

function hide_unowned_product_purchases_subpanel(): void
{
    $directory = 'custom/Extension/modules/AOS_Products/Ext/Layoutdefs';
    $path = $directory . '/zz_clawpilot_hide_unowned_purchases.php';
    $definition = <<<'PHP'
<?php
// ClawPilot does not project AOS Quotes or AOS Products Quotes. The stock
// "Purchases" query therefore is not a relationship to canonical Operations
// orders and must not imply that it is.
unset($layout_defs['AOS_Products']['subpanel_setup']['aos_products_purchases']);
PHP;
    $definition .= "\n";

    mkdir_recursive($directory, true);
    $current = is_file($path) ? file_get_contents($path) : false;
    $changed = $current === false || !hash_equals($definition, $current);
    if ($changed && file_put_contents($path, $definition, LOCK_EX) === false) {
        throw new RuntimeException('Could not write the ClawPilot AOS Products layout extension');
    }

    if ($changed || !product_purchases_subpanel_is_hidden()) {
        require_once 'ModuleInstall/ModuleInstaller.php';
        $installer = new ModuleInstaller();
        $installer->silent = true;
        $installer->rebuild_layoutdefs();
    }
    if (!product_purchases_subpanel_is_hidden()) {
        throw new RuntimeException('Unsupported AOS Products Purchases subpanel is still active');
    }
}

/** @param list<string> $modules */
function rebuild_and_verify_global_search(array $modules): void
{
    $cachePath = sugar_cached('modules/unified_search_modules.php');
    if (is_file($cachePath) && !unlink($cachePath)) {
        throw new RuntimeException('Could not invalidate SuiteCRM unified-search metadata');
    }

    \SuiteCRM\Search\SearchModules::buildCache();
    $searchModules = \SuiteCRM\Search\SearchModules::getUnifiedSearchModules();
    foreach ($modules as $module) {
        if (empty($searchModules[$module]['fields'][CLAWPILOT_GLOBAL_ID_FIELD])) {
            throw new RuntimeException("Global ID is missing from {$module} unified search");
        }
    }
}

/** @param list<string> $modules */
function enable_and_verify_global_search_modules(array $modules): void
{
    $display = \SuiteCRM\Search\SearchModules::getUnifiedSearchModulesDisplay();
    $changed = false;
    foreach ($modules as $module) {
        if (($display[$module]['visible'] ?? null) !== true) {
            $display[$module]['visible'] = true;
            $changed = true;
        }
    }

    if (
        $changed
        && !write_array_to_file(
            'unified_search_modules_display',
            $display,
            'custom/modules/unified_search_modules_display.php'
        )
    ) {
        throw new RuntimeException('Could not enable required ClawPilot modules in SuiteCRM global search');
    }

    $enabled = array_fill_keys(\SuiteCRM\Search\SearchModules::getEnabledModules(), true);
    foreach ($modules as $module) {
        if (empty($enabled[$module])) {
            throw new RuntimeException("{$module} is disabled in SuiteCRM global search");
        }
    }
}

$modules = [
    'Accounts',
    'Contacts',
    CLAWPILOT_PRODUCT_MODULE,
    'Leads',
    'Opportunities',
    'Meetings',
    'Calls',
    'Notes',
    'Campaigns',
];

foreach ($modules as $module) {
    ensure_global_id_field($module);
}

// Emails accepts DynamicFields and unified-search metadata, but its legacy list
// metadata is not compatible with the generic Studio layout writer. Opt the
// native bean into unified search, then keep the managed field searchable
// without rewriting Email detail or list layouts.
ensure_email_unified_search_support();
ensure_global_id_field('Emails', true, false);

// Users are administered separately from business-record global search, but
// still need a visible, reportable gu identity for ClawPilot assignment maps.
ensure_global_id_field('Users', false);

ensure_note_occurred_at_field();
ensure_product_image_field();
hide_unowned_product_purchases_subpanel();

$globalSearchModules = [...$modules, 'Emails'];
rebuild_and_verify_global_search($globalSearchModules);
enable_and_verify_global_search_modules([CLAWPILOT_PRODUCT_MODULE, 'Emails']);

fwrite(STDOUT, "SuiteCRM Global ID fields, native product image, owned layouts, and search metadata are ready\n");
