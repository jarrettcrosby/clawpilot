<?php
declare(strict_types=1);

if (!defined('sugarEntry')) {
    define('sugarEntry', true);
}

require_once 'include/entryPoint.php';
require_once 'modules/DynamicFields/DynamicField.php';
require_once 'modules/DynamicFields/FieldCases.php';
require_once 'modules/ModuleBuilder/parsers/ParserFactory.php';

const CLAWPILOT_GLOBAL_ID_FIELD = 'global_id_c';
const CLAWPILOT_GLOBAL_ID_LABEL = 'LBL_GLOBAL_ID';

/** @param mixed $value */
function layout_contains_global_id($value): bool
{
    if (is_string($value)) {
        return strtolower($value) === CLAWPILOT_GLOBAL_ID_FIELD;
    }
    if (!is_array($value)) {
        return false;
    }
    if (isset($value['name']) && strtolower((string) $value['name']) === CLAWPILOT_GLOBAL_ID_FIELD) {
        return true;
    }
    foreach ($value as $child) {
        if (layout_contains_global_id($child)) {
            return true;
        }
    }
    return false;
}

function expose_global_id_in_detail_view(string $module): void
{
    try {
        $parser = ParserFactory::getParser('detailview', $module);
        if (!$parser || layout_contains_global_id($parser->getLayout())) {
            return;
        }
        $parser->addField([
            'name' => CLAWPILOT_GLOBAL_ID_FIELD,
            'label' => CLAWPILOT_GLOBAL_ID_LABEL,
        ]);
        $parser->handleSave(false);
    } catch (Throwable $error) {
        fwrite(STDERR, sprintf(
            "[suitecrm] warning: could not add Global ID to the %s detail layout: %s\n",
            $module,
            $error->getMessage(),
        ));
    }
}

/** @param array<string, mixed> $definition */
function global_id_definition_is_current(array $definition): bool
{
    $fullText = $definition['full_text_search'] ?? null;
    return ($definition['vname'] ?? '') === CLAWPILOT_GLOBAL_ID_LABEL
        && (int) ($definition['len'] ?? 0) === 9
        && !empty($definition['audited'])
        && !empty($definition['reportable'])
        && !empty($definition['unified_search'])
        && is_array($fullText)
        && !empty($fullText['enabled']);
}

function ensure_global_id_field(string $module): void
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

    if (!$existing || !global_id_definition_is_current($definition)) {
        $field = $existing ?: get_widget('varchar');
        $field->name = $existing ? CLAWPILOT_GLOBAL_ID_FIELD : 'global_id';
        $field->label = CLAWPILOT_GLOBAL_ID_LABEL;
        $field->vname = CLAWPILOT_GLOBAL_ID_LABEL;
        $field->label_value = 'Global ID';
        $field->len = '9';
        $field->size = '12';
        $field->required = false;
        $field->default = null;
        $field->default_value = null;
        $field->audited = 1;
        $field->inline_edit = 0;
        $field->massupdate = 0;
        $field->importable = 'true';
        $field->duplicate_merge = 'disabled';
        $field->reportable = true;
        $field->unified_search = 1;
        $field->full_text_search = ['enabled' => true, 'boost' => 3];
        $field->comment = 'Permanent ClawPilot global reference. Managed by ClawPilot.';
        $field->save($dynamic);
    }

    $dynamic->setLabel('en_us', CLAWPILOT_GLOBAL_ID_LABEL, 'Global ID');
    expose_global_id_in_detail_view($module);
}

$modules = [
    'Accounts',
    'Contacts',
    'Leads',
    'Opportunities',
    'Meetings',
    'Notes',
    'Campaigns',
];

foreach ($modules as $module) {
    ensure_global_id_field($module);
}

fwrite(STDOUT, "SuiteCRM Global ID fields are ready\n");
